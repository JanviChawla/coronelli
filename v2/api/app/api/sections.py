"""Section listing and bulk-update endpoints."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.db.models import Document, Section

router = APIRouter()


class SectionOut(BaseModel):
    id: str
    document_id: str
    ordinal: int
    title: str | None
    catalog_status: str
    catalog_hash: str | None
    word_count: int

    model_config = {"from_attributes": True}


class SectionUpdate(BaseModel):
    id: str
    title: str | None = None
    ordinal: int | None = None


@router.get("/documents/{doc_id}/sections", response_model=list[SectionOut])
async def list_sections(doc_id: str, db: AsyncSession = Depends(get_db)) -> Any:
    doc = await db.get(Document, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    result = await db.execute(
        select(Section)
        .where(Section.document_id == doc_id)
        .order_by(Section.ordinal)
    )
    sections = result.scalars().all()
    return [
        {
            "id": s.id,
            "document_id": s.document_id,
            "ordinal": s.ordinal,
            "title": s.title,
            "catalog_status": s.catalog_status,
            "catalog_hash": s.catalog_hash,
            "word_count": len(s.text.split()),
        }
        for s in sections
    ]


@router.patch("/documents/{doc_id}/sections")
async def patch_sections(
    doc_id: str,
    updates: list[SectionUpdate],
    db: AsyncSession = Depends(get_db),
) -> Any:
    doc = await db.get(Document, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    updated = []
    for upd in updates:
        sec = await db.get(Section, upd.id)
        if not sec or sec.document_id != doc_id:
            raise HTTPException(status_code=404, detail=f"Section {upd.id} not found")
        if upd.title is not None:
            sec.title = upd.title
        if upd.ordinal is not None:
            sec.ordinal = upd.ordinal
        updated.append(
            {
                "id": sec.id,
                "document_id": sec.document_id,
                "ordinal": sec.ordinal,
                "title": sec.title,
                "catalog_status": sec.catalog_status,
            }
        )

    await db.commit()
    return updated
