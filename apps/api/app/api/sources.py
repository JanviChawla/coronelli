from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.domain.sources import list_documents, list_sections

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


@router.get("", response_model=list[DocumentResponse])
def get_documents(db: Session = Depends(get_db)) -> list[DocumentResponse]:
    return [DocumentResponse.model_validate(d) for d in list_documents(db)]


@router.get("/{document_id}/sections", response_model=list[SectionResponse])
def get_sections(document_id: str, db: Session = Depends(get_db)) -> list[SectionResponse]:
    sections = list_sections(db, document_id)
    if not sections:
        # Check if the document exists to distinguish 404 from empty section list
        from app.domain.sources import list_documents
        from sqlalchemy import select
        from app.db.models import SourceDocument
        exists = db.get(SourceDocument, document_id)
        if exists is None:
            raise HTTPException(status_code=404, detail=f"Document '{document_id}' not found.")
    return [SectionResponse.model_validate(s) for s in sections]
