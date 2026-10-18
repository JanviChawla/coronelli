"""Atlas data endpoint."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.db.models import AtlasPosition, Claim, Document, Place, Section

router = APIRouter()


@router.get("/documents/{doc_id}/atlas")
async def get_atlas(doc_id: str, db: AsyncSession = Depends(get_db)) -> Any:
    doc = await db.get(Document, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    places_result = await db.execute(
        select(Place).where(
            Place.document_id == doc_id,
            Place.status == "confirmed",
        )
    )
    places = places_result.scalars().all()

    # Build section ordinal map for provenance scrubber
    section_ids = {p.first_section_id for p in places if p.first_section_id}
    section_ordinals: dict[str, int] = {}
    if section_ids:
        secs_result = await db.execute(
            select(Section).where(Section.id.in_(section_ids))
        )
        for s in secs_result.scalars().all():
            section_ordinals[s.id] = s.ordinal

    claims_result = await db.execute(
        select(Claim).where(Claim.document_id == doc_id)
    )
    claims = claims_result.scalars().all()

    place_ids = {p.id for p in places}
    positions_result = await db.execute(
        select(AtlasPosition).where(AtlasPosition.place_id.in_(place_ids))
    )
    positions = positions_result.scalars().all()
    positions_map = {pos.place_id: {"x": pos.x, "z": pos.z} for pos in positions}

    return {
        "document": {
            "id": doc.id,
            "title": doc.title,
            "author": doc.author,
            "year": doc.year,
            "status": doc.status,
        },
        "places": [
            {
                "id": p.id,
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
                "first_section_id": p.first_section_id,
                "first_section_ordinal": section_ordinals.get(p.first_section_id) if p.first_section_id else None,
            }
            for p in places
        ],
        "claims": [
            {
                "id": c.id,
                "claim_type": c.claim_type,
                "subject_id": c.subject_id,
                "predicate": c.predicate,
                "object_id": c.object_id,
                "payload": c.payload,
                "excerpt": c.excerpt,
                "confidence": c.confidence,
            }
            for c in claims
        ],
        "positions": positions_map,
    }
