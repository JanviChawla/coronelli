from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.db.models import SourceDocument
from app.domain.sources import ProposedSection, list_documents, list_sections, replace_sections
from app.ingestion.parsers import TextExtractionUnavailableError
from app.ingestion.service import import_document

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


@router.get("/{document_id}/sections", response_model=list[SectionResponse])
def get_sections(document_id: str, db: Session = Depends(get_db)) -> list[SectionResponse]:
    sections = list_sections(db, document_id)
    if not sections:
        exists = db.get(SourceDocument, document_id)
        if exists is None:
            raise HTTPException(status_code=404, detail=f"Document '{document_id}' not found.")
    return [SectionResponse.model_validate(s) for s in sections]
