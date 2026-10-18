"""Document import and management endpoints."""

import os
import re
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.database import get_db
from app.db.models import Document, Section

router = APIRouter()

_CHAPTER_PATTERN = re.compile(
    r"^\s*(Chapter|CHAPTER|Part|PART|\d+\.)\s", re.MULTILINE
)
_WORDS_PER_SECTION = 3000


def _split_into_sections(text: str) -> list[tuple[str | None, str]]:
    """
    Returns list of (title, text) tuples.
    Splits on chapter headings; falls back to word-count chunks if none found.
    """
    matches = list(_CHAPTER_PATTERN.finditer(text))
    if not matches:
        # Word-count fallback
        words = text.split()
        chunks: list[tuple[str | None, str]] = []
        for i in range(0, len(words), _WORDS_PER_SECTION):
            chunk = " ".join(words[i : i + _WORDS_PER_SECTION])
            n = i // _WORDS_PER_SECTION + 1
            chunks.append((f"Section {n}", chunk))
        return chunks or [("Section 1", text)]

    sections: list[tuple[str | None, str]] = []
    for idx, match in enumerate(matches):
        start = match.start()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        raw = text[start:end].strip()
        # First line of the chunk is the heading
        lines = raw.split("\n", 1)
        title = lines[0].strip() if lines else None
        body = lines[1].strip() if len(lines) > 1 else raw
        if body:
            sections.append((title, body))
    return sections or [("Section 1", text)]


class DocumentOut(BaseModel):
    id: str
    title: str
    author: str | None
    year: int | None
    status: str
    created_at: str

    model_config = {"from_attributes": True}


class DocumentWithSections(DocumentOut):
    sections: list[dict[str, Any]]


class PatchDocumentIn(BaseModel):
    title: str | None = None
    author: str | None = None
    year: int | None = None


@router.post("/documents", response_model=DocumentWithSections)
async def create_document(
    file: UploadFile = File(...),
    title: str = Form(...),
    author: str | None = Form(None),
    year: int | None = Form(None),
    db: AsyncSession = Depends(get_db),
) -> Any:
    raw_bytes = await file.read()
    text = raw_bytes.decode("utf-8", errors="replace")

    doc = Document(title=title, author=author, year=year, status="raw")
    db.add(doc)
    await db.flush()

    raw_sections = _split_into_sections(text)
    sections_out = []
    for ordinal, (sec_title, sec_text) in enumerate(raw_sections):
        sec = Section(
            document_id=doc.id,
            ordinal=ordinal,
            title=sec_title,
            text=sec_text,
            catalog_status="pending",
        )
        db.add(sec)
        await db.flush()
        sections_out.append(
            {
                "id": sec.id,
                "ordinal": ordinal,
                "title": sec_title,
                "catalog_status": "pending",
                "word_count": len(sec_text.split()),
            }
        )

    await db.commit()
    return {
        "id": doc.id,
        "title": doc.title,
        "author": doc.author,
        "year": doc.year,
        "status": doc.status,
        "created_at": doc.created_at.isoformat(),
        "sections": sections_out,
    }


@router.get("/documents", response_model=list[DocumentOut])
async def list_documents(db: AsyncSession = Depends(get_db)) -> Any:
    result = await db.execute(
        select(Document).order_by(Document.created_at.desc())
    )
    docs = result.scalars().all()
    return [
        {
            "id": d.id,
            "title": d.title,
            "author": d.author,
            "year": d.year,
            "status": d.status,
            "created_at": d.created_at.isoformat(),
        }
        for d in docs
    ]


@router.get("/documents/{doc_id}", response_model=DocumentOut)
async def get_document(doc_id: str, db: AsyncSession = Depends(get_db)) -> Any:
    doc = await db.get(Document, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return {
        "id": doc.id,
        "title": doc.title,
        "author": doc.author,
        "year": doc.year,
        "status": doc.status,
        "created_at": doc.created_at.isoformat(),
    }


@router.patch("/documents/{doc_id}", response_model=DocumentOut)
async def patch_document(
    doc_id: str, body: PatchDocumentIn, db: AsyncSession = Depends(get_db)
) -> Any:
    doc = await db.get(Document, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    if body.title is not None:
        doc.title = body.title
    if body.author is not None:
        doc.author = body.author
    if body.year is not None:
        doc.year = body.year
    await db.commit()
    return {
        "id": doc.id,
        "title": doc.title,
        "author": doc.author,
        "year": doc.year,
        "status": doc.status,
        "created_at": doc.created_at.isoformat(),
    }


@router.delete("/documents/{doc_id}", status_code=204)
async def delete_document(doc_id: str, db: AsyncSession = Depends(get_db)) -> None:
    doc = await db.get(Document, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    await db.delete(doc)
    await db.commit()


# ── Cost estimation ───────────────────────────────────────────────────────────

_PRICING: dict[str, dict[str, float]] = {
    "gpt-4o":          {"input": 2.50,  "output": 10.00},
    "gpt-4o-mini":     {"input": 0.15,  "output": 0.60},
    "gpt-4.1":         {"input": 2.00,  "output": 8.00},
    "gpt-4.1-mini":    {"input": 0.40,  "output": 1.60},
    "gpt-4-turbo":     {"input": 10.00, "output": 30.00},
}
_CATALOG_SYSTEM_TOKENS   = 1_400   # approximate system-prompt overhead
_GAP_SYSTEM_TOKENS       = 900
_EVIDENCE_SYSTEM_TOKENS  = 1_000
_CATALOG_OUTPUT_TOKENS   = 600     # per section
_GAP_OUTPUT_TOKENS       = 300
_EVIDENCE_OUTPUT_TOKENS  = 800
_KNOWN_NAMES_PER_PLACE   = 12      # tokens per confirmed place passed to evidence


@router.get("/documents/{doc_id}/estimate")
async def estimate_cost(doc_id: str, db: AsyncSession = Depends(get_db)) -> Any:
    doc = await db.get(Document, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    result = await db.execute(
        select(Section).where(Section.document_id == doc_id).order_by(Section.ordinal)
    )
    sections = result.scalars().all()
    if not sections:
        raise HTTPException(status_code=400, detail="No sections found")

    model = os.getenv("OPENAI_EXTRACTION_MODEL", "gpt-4o")
    pricing = _PRICING.get(model, _PRICING["gpt-4o"])

    section_token_counts = [max(1, len(s.text) // 4) for s in sections]
    n = len(sections)

    # catalog+gap: two LLM calls per section
    cat_input  = sum(t + _CATALOG_SYSTEM_TOKENS for t in section_token_counts)
    cat_output = n * _CATALOG_OUTPUT_TOKENS
    gap_input  = sum(t + _GAP_SYSTEM_TOKENS + _CATALOG_OUTPUT_TOKENS for t in section_token_counts)
    gap_output = n * _GAP_OUTPUT_TOKENS
    catalog_gap_input  = cat_input + gap_input
    catalog_gap_output = cat_output + gap_output

    # evidence: one call per section; known-names list grows as catalog fills
    avg_places_known = 15  # rough estimate before catalog is run
    evidence_input  = sum(
        t + _EVIDENCE_SYSTEM_TOKENS + avg_places_known * _KNOWN_NAMES_PER_PLACE
        for t in section_token_counts
    )
    evidence_output = n * _EVIDENCE_OUTPUT_TOKENS

    def cost(inp: int, out: int) -> float:
        return round(inp / 1_000_000 * pricing["input"] + out / 1_000_000 * pricing["output"], 4)

    catalog_gap_cost = cost(catalog_gap_input, catalog_gap_output)
    evidence_cost    = cost(evidence_input, evidence_output)

    return {
        "model": model,
        "section_count": n,
        "catalog_gap": {
            "estimated_input_tokens":  catalog_gap_input,
            "estimated_output_tokens": catalog_gap_output,
            "estimated_cost_usd":      catalog_gap_cost,
        },
        "evidence": {
            "estimated_input_tokens":  evidence_input,
            "estimated_output_tokens": evidence_output,
            "estimated_cost_usd":      evidence_cost,
        },
        "total_estimated_cost_usd": round(catalog_gap_cost + evidence_cost, 4),
    }
