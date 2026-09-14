import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import SourceDocument, SourceSection


@dataclass
class ProposedSection:
    text: str
    ordinal: int
    title: str | None = None
    page_start: int | None = None
    page_end: int | None = None
    user_corrected: bool = False


def create_document(
    session: Session,
    *,
    title: str,
    original_filename: str,
    mime_type: str,
    content_hash: str,
    parser_version: str,
    category: Literal["demo", "private"],
) -> SourceDocument:
    doc = SourceDocument(
        id=str(uuid.uuid4()),
        title=title,
        original_filename=original_filename,
        mime_type=mime_type,
        content_hash=content_hash,
        imported_at=datetime.now(timezone.utc),
        parser_version=parser_version,
        category=category,
    )
    session.add(doc)
    session.commit()
    session.refresh(doc)
    return doc


def replace_sections(
    session: Session,
    document_id: str,
    sections: list[ProposedSection],
) -> list[SourceSection]:
    existing = session.execute(
        select(SourceSection).where(SourceSection.document_id == document_id)
    ).scalars().all()
    for row in existing:
        session.delete(row)
    session.flush()

    new_rows: list[SourceSection] = []
    for prop in sorted(sections, key=lambda s: s.ordinal):
        row = SourceSection(
            id=str(uuid.uuid4()),
            document_id=document_id,
            ordinal=prop.ordinal,
            title=prop.title,
            text=prop.text,
            page_start=prop.page_start,
            page_end=prop.page_end,
            user_corrected=prop.user_corrected,
        )
        session.add(row)
        new_rows.append(row)

    session.commit()
    for row in new_rows:
        session.refresh(row)
    return new_rows


def list_sections(session: Session, document_id: str) -> list[SourceSection]:
    return list(
        session.execute(
            select(SourceSection)
            .where(SourceSection.document_id == document_id)
            .order_by(SourceSection.ordinal)
        ).scalars().all()
    )


def list_documents(session: Session) -> list[SourceDocument]:
    return list(session.execute(select(SourceDocument)).scalars().all())


def delete_document(session: Session, document_id: str) -> None:
    doc = session.get(SourceDocument, document_id)
    if doc is None:
        raise ValueError(f"Document '{document_id}' not found.")
    for section in list_sections(session, document_id):
        session.delete(section)
    session.delete(doc)
    session.commit()
