import re
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.db.models import SourceDocument
from app.domain.sources import ProposedSection, delete_document, list_documents, list_sections, replace_sections
from app.ingestion.parsers import TextExtractionUnavailableError
from app.ingestion.service import import_document, resection_document

router = APIRouter(prefix="/api/documents", tags=["documents"])


class SectionResponse(BaseModel):
    id: str
    document_id: str
    ordinal: int
    title: str | None
    text: str
    page_start: int | None
    page_end: int | None
    user_corrected: bool
    section_kind: str = "narrative"

    model_config = {"from_attributes": True}


class DocumentResponse(BaseModel):
    id: str
    title: str
    original_filename: str
    mime_type: str
    content_hash: str
    imported_at: datetime
    parser_version: str
    category: str
    author: str | None
    year: int | None

    model_config = {"from_attributes": True}


class ImportResponse(BaseModel):
    document: DocumentResponse
    sections: list[SectionResponse]


@router.post("/import", response_model=ImportResponse, status_code=201)
async def import_document_endpoint(
    file: UploadFile = File(...),
    category: Literal["demo", "private"] = Form("demo"),
    db: Session = Depends(get_db),
) -> ImportResponse:
    content = await file.read()
    try:
        doc, sections = import_document(db, file.filename or "upload", content, category)
    except TextExtractionUnavailableError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ImportResponse(
        document=DocumentResponse.model_validate(doc),
        sections=[SectionResponse.model_validate(s) for s in sections],
    )


@router.get("", response_model=list[DocumentResponse])
def get_documents(db: Session = Depends(get_db)) -> list[DocumentResponse]:
    return [DocumentResponse.model_validate(d) for d in list_documents(db)]


class SectionUpdateRequest(BaseModel):
    id: str
    ordinal: int
    title: str | None
    text: str


@router.put("/{document_id}/sections", response_model=list[SectionResponse])
def update_sections(
    document_id: str,
    body: list[SectionUpdateRequest],
    db: Session = Depends(get_db),
) -> list[SectionResponse]:
    doc = db.get(SourceDocument, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail=f"Document '{document_id}' not found.")

    current = {s.id: s for s in list_sections(db, document_id)}
    proposed: list[ProposedSection] = []
    for upd in body:
        existing = current.get(upd.id)
        changed = existing is None or existing.title != upd.title or existing.text != upd.text
        proposed.append(ProposedSection(
            title=upd.title,
            text=upd.text,
            ordinal=upd.ordinal,
            user_corrected=changed,
        ))

    sections = replace_sections(db, document_id, proposed)
    return [SectionResponse.model_validate(s) for s in sections]


class DocumentUpdateRequest(BaseModel):
    title: str | None = None
    author: str | None = None
    year: int | None = None


@router.patch("/{document_id}", response_model=DocumentResponse)
def update_document_metadata(
    document_id: str,
    body: DocumentUpdateRequest,
    db: Session = Depends(get_db),
) -> DocumentResponse:
    doc = db.get(SourceDocument, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail=f"Document '{document_id}' not found.")
    if body.title is not None:
        doc.title = body.title.strip() or doc.title
    if body.author is not None:
        doc.author = body.author.strip() or None
    if body.year is not None:
        doc.year = body.year
    db.commit()
    db.refresh(doc)
    return DocumentResponse.model_validate(doc)


@router.delete("/{document_id}", status_code=204)
def delete_document_endpoint(document_id: str, db: Session = Depends(get_db)) -> None:
    try:
        delete_document(db, document_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{document_id}/export-text")
def export_document_text(document_id: str, db: Session = Depends(get_db)) -> PlainTextResponse:
    """Return the document's full text as a downloadable Markdown file."""
    doc = db.get(SourceDocument, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail=f"Document '{document_id}' not found.")

    if doc.raw_text:
        body = doc.raw_text
    else:
        sections = list_sections(db, document_id)
        parts: list[str] = []
        for s in sections:
            if s.title:
                parts.append(f"## {s.title}\n\n{s.text}")
            else:
                parts.append(s.text)
        body = "\n\n".join(parts)

    header_lines = [f"Title: {doc.title}"]
    if doc.author:
        header_lines.append(f"Author: {doc.author}")
    if doc.year:
        header_lines.append(f"Year: {doc.year}")
    md = "\n".join(header_lines) + "\n\n" + body

    safe_title = re.sub(r"[^\w\s-]", "", doc.title or "document").strip().replace(" ", "_")
    filename = f"{safe_title}.md"
    return PlainTextResponse(
        content=md,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/{document_id}/resection", response_model=list[SectionResponse])
def resection_document_endpoint(document_id: str, db: Session = Depends(get_db)) -> list[SectionResponse]:
    """Re-run the sectioning pipeline (including semantic splitting) on the stored raw text."""
    try:
        sections = resection_document(db, document_id)
        db.commit()
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return [SectionResponse.model_validate(s) for s in sections]


@router.get("/{document_id}/sections", response_model=list[SectionResponse])
def get_sections(document_id: str, db: Session = Depends(get_db)) -> list[SectionResponse]:
    sections = list_sections(db, document_id)
    if not sections:
        exists = db.get(SourceDocument, document_id)
        if exists is None:
            raise HTTPException(status_code=404, detail=f"Document '{document_id}' not found.")
    return [SectionResponse.model_validate(s) for s in sections]
