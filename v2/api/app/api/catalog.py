"""Catalog run, confirm, place patch, manual-place, and claim endpoints."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.db.models import Claim, Document, Place, Section
from app.extraction.catalog import get_combined_hash, run_catalog_and_gap

router = APIRouter()


def _place_out(p: Place) -> dict[str, Any]:
    return {
        "id": p.id,
        "document_id": p.document_id,
        "first_section_id": p.first_section_id,
        "name": p.name,
        "aliases": p.aliases or [],
        "kind": p.kind,
        "kind_descriptor": p.kind_descriptor,
        "spatial_level": p.spatial_level,
        "tier": p.tier,
        "parent_context": p.parent_context,
        "note": p.note,
        "palette": p.palette,
        "is_edge": p.is_edge,
        "status": p.status,
        "source": p.source,
    }


class PlacePatch(BaseModel):
    status: str | None = None
    name: str | None = None
    kind: str | None = None
    kind_descriptor: str | None = None
    tier: str | None = None
    note: str | None = None
    is_edge: bool | None = None


class ManualPlaceIn(BaseModel):
    name: str
    kind: str | None = None
    kind_descriptor: str | None = None
    spatial_level: int | None = None
    tier: str | None = None
    parent_context: str | None = None
    note: str | None = None
    aliases: list[str] = []
    is_edge: bool = False


@router.post("/sections/{section_id}/catalog/run")
async def run_catalog(section_id: str, db: AsyncSession = Depends(get_db)) -> Any:
    sec = await db.get(Section, section_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Section not found")

    new_hash = get_combined_hash(section_id, sec.text)

    # Cache hit: return existing candidates for this section
    if sec.catalog_hash == new_hash and sec.catalog_status in ("extracted", "confirmed"):
        result = await db.execute(
            select(Place).where(
                Place.first_section_id == section_id,
                Place.status.in_(["candidate", "confirmed", "rejected"]),
            )
        )
        existing = result.scalars().all()
        return {"section_id": section_id, "cached": True, "places": [_place_out(p) for p in existing]}

    # Fetch known confirmed names from prior sections
    result = await db.execute(
        select(Place).where(
            Place.document_id == sec.document_id,
            Place.status == "confirmed",
        )
    )
    confirmed_places = result.scalars().all()
    known_names = [
        {"name": p.name, "kind": p.kind, "spatial_level": p.spatial_level}
        for p in confirmed_places
    ]

    # Run LLM extraction (raises NotImplementedError until wired)
    raw_places = await run_catalog_and_gap(section_id, sec.text, known_names)

    _VALID_TIERS = {"peak", "elevated", "surface", "underground", "deep"}

    # Persist extracted candidates
    new_places = []
    for raw in raw_places:
        tier_raw = raw.get("tier")
        tier = tier_raw if tier_raw in _VALID_TIERS else "surface"

        # Model sometimes sets tier="edge" instead of is_edge=True — coerce it
        is_edge = raw.get("is_edge", False)
        if tier_raw == "edge":
            is_edge = True

        place = Place(
            document_id=sec.document_id,
            first_section_id=section_id,
            name=raw["name"],
            kind=raw.get("kind"),
            kind_descriptor=raw.get("kind_descriptor"),
            spatial_level=raw.get("spatial_level"),
            tier=tier,
            parent_context=raw.get("parent_context"),
            note=raw.get("note"),
            aliases=raw.get("aliases", []),
            is_edge=is_edge,
            status="candidate",
            source=raw.get("source", "catalog"),
            payload=raw,
        )
        db.add(place)
        await db.flush()
        new_places.append(place)

    sec.catalog_hash = new_hash
    sec.catalog_status = "extracted"

    # Update document status to cataloging if still raw
    doc = await db.get(Document, sec.document_id)
    if doc and doc.status == "raw":
        doc.status = "cataloging"

    await db.commit()
    return {"section_id": section_id, "cached": False, "places": [_place_out(p) for p in new_places]}


@router.post("/sections/{section_id}/catalog/confirm")
async def confirm_section(section_id: str, db: AsyncSession = Depends(get_db)) -> Any:
    sec = await db.get(Section, section_id)
    if not sec:
        raise HTTPException(status_code=404, detail="Section not found")

    # Flip non-rejected candidates → confirmed
    result = await db.execute(
        select(Place).where(
            Place.first_section_id == section_id,
            Place.status == "candidate",
        )
    )
    candidates = result.scalars().all()
    for place in candidates:
        place.status = "confirmed"

    sec.catalog_status = "confirmed"

    # Check if all sections are confirmed → advance document
    doc = await db.get(Document, sec.document_id)
    if doc:
        all_sections = await db.execute(
            select(Section).where(Section.document_id == sec.document_id)
        )
        all_secs = all_sections.scalars().all()
        if all(s.catalog_status == "confirmed" for s in all_secs):
            doc.status = "cataloged"

    await db.commit()
    return {
        "section_id": section_id,
        "catalog_status": sec.catalog_status,
        "confirmed_count": len(candidates),
    }


@router.patch("/places/{place_id}")
async def patch_place(
    place_id: str, body: PlacePatch, db: AsyncSession = Depends(get_db)
) -> Any:
    place = await db.get(Place, place_id)
    if not place:
        raise HTTPException(status_code=404, detail="Place not found")

    if body.status is not None:
        if body.status not in ("candidate", "confirmed", "rejected"):
            raise HTTPException(status_code=400, detail="Invalid status")
        place.status = body.status
    if body.name is not None:
        place.name = body.name
    if body.kind is not None:
        place.kind = body.kind
    if body.kind_descriptor is not None:
        place.kind_descriptor = body.kind_descriptor
    if body.tier is not None:
        place.tier = body.tier
    if body.note is not None:
        place.note = body.note
    if body.is_edge is not None:
        place.is_edge = body.is_edge

    await db.commit()
    return _place_out(place)


@router.post("/documents/{doc_id}/places")
async def add_manual_place(
    doc_id: str, body: ManualPlaceIn, db: AsyncSession = Depends(get_db)
) -> Any:
    doc = await db.get(Document, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    place = Place(
        document_id=doc_id,
        name=body.name,
        kind=body.kind,
        kind_descriptor=body.kind_descriptor,
        spatial_level=body.spatial_level,
        tier=body.tier,
        parent_context=body.parent_context,
        note=body.note,
        aliases=body.aliases,
        is_edge=body.is_edge,
        status="confirmed",
        source="manual",
    )
    db.add(place)
    await db.commit()
    return _place_out(place)


class ClaimIn(BaseModel):
    claim_type: str = "spatial"
    subject_id: str
    predicate: str | None = None
    object_id: str | None = None
    excerpt: str | None = None


@router.post("/documents/{doc_id}/claims")
async def add_claim(doc_id: str, body: ClaimIn, db: AsyncSession = Depends(get_db)) -> Any:
    doc = await db.get(Document, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Claims require a section_id — use the first section of the document
    sec_result = await db.execute(
        select(Section).where(Section.document_id == doc_id).order_by(Section.ordinal).limit(1)
    )
    sec = sec_result.scalar_one_or_none()
    if not sec:
        raise HTTPException(status_code=400, detail="Document has no sections")

    claim = Claim(
        document_id=doc_id,
        section_id=sec.id,
        claim_type=body.claim_type,
        subject_id=body.subject_id,
        predicate=body.predicate,
        object_id=body.object_id,
        excerpt=body.excerpt,
        confidence=1.0,
    )
    db.add(claim)
    await db.commit()
    return {
        "id": claim.id,
        "claim_type": claim.claim_type,
        "subject_id": claim.subject_id,
        "predicate": claim.predicate,
        "object_id": claim.object_id,
        "excerpt": claim.excerpt,
        "confidence": claim.confidence,
    }


@router.delete("/claims/{claim_id}", status_code=204)
async def delete_claim(claim_id: str, db: AsyncSession = Depends(get_db)) -> None:
    claim = await db.get(Claim, claim_id)
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")
    await db.delete(claim)
    await db.commit()


@router.get("/documents/{doc_id}/places")
async def get_places(doc_id: str, db: AsyncSession = Depends(get_db)) -> Any:
    doc = await db.get(Document, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    result = await db.execute(
        select(Place)
        .where(Place.document_id == doc_id)
        .order_by(Place.created_at)
    )
    places = result.scalars().all()

    grouped: dict[str, list[dict[str, Any]]] = {
        "candidate": [],
        "confirmed": [],
        "rejected": [],
    }
    for p in places:
        grouped[p.status].append(_place_out(p))

    return grouped
