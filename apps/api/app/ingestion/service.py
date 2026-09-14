from typing import Literal

from sqlalchemy.orm import Session

from app.db.models import SourceDocument, SourceSection
from app.domain.sources import create_document, replace_sections
from app.ingestion.parsers import parse_upload
from app.ingestion.sectioner import section_text


def import_document(
    session: Session,
    filename: str,
    content: bytes,
    category: Literal["demo", "private"],
) -> tuple[SourceDocument, list[SourceSection]]:
    parsed = parse_upload(filename, content)
    proposed = section_text(parsed.text)

    doc = create_document(
        session,
        title=parsed.title,
        original_filename=filename,
        mime_type=parsed.mime_type,
        content_hash=parsed.content_hash,
        parser_version=parsed.parser_version,
        category=category,
    )

    sections = replace_sections(session, doc.id, proposed)
    return doc, sections
