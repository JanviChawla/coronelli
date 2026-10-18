"""Evidence extraction, synthesis, and SSE event-stream endpoints."""

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.db.models import AtlasPosition, Claim, Document, Place, Section
from app.extraction.evidence import extract_evidence
from app.extraction.synthesis import compute_layout, consolidate_palettes, normalize_containment

logger = logging.getLogger(__name__)
router = APIRouter()

# Per-document event queues: doc_id → list of connected queues
_event_queues: dict[str, list[asyncio.Queue]] = {}


def _get_queues(doc_id: str) -> list[asyncio.Queue]:
    return _event_queues.setdefault(doc_id, [])


async def _broadcast(doc_id: str, event: dict[str, Any]) -> None:
    payload = json.dumps(event)
    for q in _get_queues(doc_id):
        await q.put(payload)


@router.get("/documents/{doc_id}/events")
async def event_stream(doc_id: str, db: AsyncSession = Depends(get_db)):
    """SSE stream for a document. Yields typed JSON events as they occur."""
    doc = await db.get(Document, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    queue: asyncio.Queue = asyncio.Queue()
    _get_queues(doc_id).append(queue)

    async def generate():
        try:
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=30.0)
                    yield f"data: {payload}\n\n"
                except asyncio.TimeoutError:
                    # Heartbeat to keep connection alive
                    yield ": heartbeat\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            queues = _event_queues.get(doc_id, [])
            if queue in queues:
                queues.remove(queue)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _run_extraction_task(doc_id: str) -> None:
    """Background task: extract evidence for all sections concurrently (max 3 at a time)."""
    from app.db.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Section)
            .where(Section.document_id == doc_id)
            .order_by(Section.ordinal)
        )
        sections = result.scalars().all()

        confirmed_result = await db.execute(
            select(Place).where(
                Place.document_id == doc_id, Place.status == "confirmed"
            )
        )
        confirmed_places = confirmed_result.scalars().all()
        places_dicts = [
            {"id": p.id, "name": p.name, "kind": p.kind}
            for p in confirmed_places
        ]

        place_name_map = {p.name: p.id for p in confirmed_places}

    semaphore = asyncio.Semaphore(3)
    total = len(sections)

    async def extract_section(sec: Section) -> None:
        async with semaphore:
            try:
                raw_claims = await extract_evidence(sec.id, sec.text, places_dicts)
            except NotImplementedError:
                await _broadcast(
                    doc_id,
                    {
                        "type": "error",
                        "stage": "evidence",
                        "section_id": sec.id,
                        "message": "LLM not yet wired — see app/extraction/evidence.py",
                    },
                )
                return

            async with AsyncSessionLocal() as db:
                for raw in raw_claims:
                    subject_name = raw.get("subject")
                    object_name = raw.get("object")
                    subject_id = place_name_map.get(subject_name) if subject_name else None
                    object_id = place_name_map.get(object_name) if object_name else None

                    if not subject_id:
                        continue

                    payload: dict[str, Any] = {}
                    if raw.get("claim_type") == "visual":
                        payload["palette"] = raw.get("palette", [])

                    claim = Claim(
                        document_id=doc_id,
                        section_id=sec.id,
                        claim_type=raw.get("claim_type", "spatial"),
                        subject_id=subject_id,
                        predicate=raw.get("predicate"),
                        object_id=object_id,
                        payload=payload or None,
                        excerpt=raw.get("excerpt"),
                        confidence=raw.get("confidence"),
                    )
                    db.add(claim)

                await db.commit()

            await _broadcast(
                doc_id,
                {
                    "type": "section_extracted",
                    "section_id": sec.id,
                    "claim_count": len(raw_claims),
                },
            )

    await asyncio.gather(*[extract_section(s) for s in sections])

    # Synthesis
    async with AsyncSessionLocal() as db:
        places_result = await db.execute(
            select(Place).where(
                Place.document_id == doc_id,
                Place.status == "confirmed",
                Place.is_edge == False,  # noqa: E712
            )
        )
        places = places_result.scalars().all()

        claims_result = await db.execute(
            select(Claim).where(Claim.document_id == doc_id)
        )
        claims = claims_result.scalars().all()

        places_list = [
            {"id": p.id, "name": p.name, "tier": p.tier, "spatial_level": p.spatial_level}
            for p in places
        ]
        claims_list = [
            {
                "id": c.id,
                "claim_type": c.claim_type,
                "subject_id": c.subject_id,
                "predicate": c.predicate,
                "object_id": c.object_id,
                "section_ordinal": 0,
            }
            for c in claims
        ]

        positions = compute_layout(places_list, normalize_containment(claims_list))

        for place_id, (x, z) in positions.items():
            existing = await db.get(AtlasPosition, place_id)
            if existing:
                existing.x = x
                existing.z = z
                existing.layout_version += 1
            else:
                db.add(AtlasPosition(place_id=place_id, x=x, z=z))

        doc = await db.get(Document, doc_id)
        if doc:
            doc.status = "ready"

        await db.commit()

    await _broadcast(doc_id, {"type": "synthesis_done", "document_id": doc_id})


@router.post("/documents/{doc_id}/extract/run", status_code=202)
async def run_extraction(doc_id: str, db: AsyncSession = Depends(get_db)) -> Any:
    doc = await db.get(Document, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    if doc.status != "cataloged":
        raise HTTPException(
            status_code=400,
            detail=f"Document must be in 'cataloged' state to extract (current: {doc.status})",
        )

    doc.status = "extracting"
    await db.commit()

    asyncio.create_task(_run_extraction_task(doc_id))
    return {"status": "started", "document_id": doc_id}


@router.post("/documents/{doc_id}/synthesize", status_code=202)
async def run_synthesis(doc_id: str, db: AsyncSession = Depends(get_db)) -> Any:
    """Re-run synthesis independently (e.g. to recompute layout after manual edits)."""
    doc = await db.get(Document, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    places_result = await db.execute(
        select(Place).where(
            Place.document_id == doc_id,
            Place.status == "confirmed",
            Place.is_edge == False,  # noqa: E712
        )
    )
    places = places_result.scalars().all()

    claims_result = await db.execute(
        select(Claim).where(Claim.document_id == doc_id)
    )
    claims = claims_result.scalars().all()

    places_list = [
        {"id": p.id, "name": p.name, "tier": p.tier, "spatial_level": p.spatial_level}
        for p in places
    ]
    claims_list = [
        {
            "id": c.id,
            "claim_type": c.claim_type,
            "subject_id": c.subject_id,
            "predicate": c.predicate,
            "object_id": c.object_id,
            "section_ordinal": 0,
        }
        for c in claims
    ]

    positions = compute_layout(places_list, normalize_containment(claims_list))

    for place_id, (x, z) in positions.items():
        existing = await db.get(AtlasPosition, place_id)
        if existing:
            existing.x = x
            existing.z = z
            existing.layout_version += 1
        else:
            db.add(AtlasPosition(place_id=place_id, x=x, z=z))

    doc.status = "ready"
    await db.commit()

    return {"status": "done", "document_id": doc_id, "positions": len(positions)}
