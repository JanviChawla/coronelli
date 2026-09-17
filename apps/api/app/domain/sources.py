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
    section_kind: str = "narrative"


def create_document(
    session: Session,
    *,
    title: str,
    original_filename: str,
    mime_type: str,
    content_hash: str,
    parser_version: str,
    category: Literal["demo", "private"],
    raw_text: str | None = None,
    narrative_body_start: int | None = None,
    narrative_body_end: int | None = None,
    normalization_diagnostics: list | None = None,
    author: str | None = None,
    year: int | None = None,
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
        raw_text=raw_text,
        narrative_body_start=narrative_body_start,
        narrative_body_end=narrative_body_end,
        normalization_diagnostics=normalization_diagnostics or None,
        author=author,
        year=year,
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
            section_kind=prop.section_kind,
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
    from app.domain.world import EntityMention, MapClaim, MapEntity, MapTravelRule
    from app.extraction.models import Candidate, ExtractionRun
    from app.synthesis.models import SynthesisItem, SynthesisRun

    doc = session.get(SourceDocument, document_id)
    if doc is None:
        raise ValueError(f"Document '{document_id}' not found.")

    section_ids = [s.id for s in list_sections(session, document_id)]

    # EntityMention references both MapEntity and SourceSection — delete first
    session.query(EntityMention).filter(
        EntityMention.document_id == document_id
    ).delete(synchronize_session=False)

    # MapClaim / MapTravelRule use SET NULL on provenance_document_id — must delete explicitly
    session.query(MapClaim).filter(
        MapClaim.provenance_document_id == document_id
    ).delete(synchronize_session=False)
    session.query(MapTravelRule).filter(
        MapTravelRule.provenance_document_id == document_id
    ).delete(synchronize_session=False)
    session.query(MapEntity).filter(
        MapEntity.provenance_document_id == document_id
    ).delete(synchronize_session=False)

    # Synthesis rows — CASCADE from source_documents but explicit for reliability
    session.query(SynthesisItem).filter(
        SynthesisItem.document_id == document_id
    ).delete(synchronize_session=False)
    session.query(SynthesisRun).filter(
        SynthesisRun.document_id == document_id
    ).delete(synchronize_session=False)

    # Extraction rows — CASCADE from source_sections but explicit for reliability
    if section_ids:
        session.query(Candidate).filter(
            Candidate.section_id.in_(section_ids)
        ).delete(synchronize_session=False)
        session.query(ExtractionRun).filter(
            ExtractionRun.section_id.in_(section_ids)
        ).delete(synchronize_session=False)

    session.query(SourceSection).filter(
        SourceSection.document_id == document_id
    ).delete(synchronize_session=False)
    session.delete(doc)
    session.commit()
