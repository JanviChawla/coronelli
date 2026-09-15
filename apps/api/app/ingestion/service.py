from typing import Literal

from sqlalchemy.orm import Session

from app.db.models import SourceDocument, SourceSection
from app.domain.sources import ProposedSection, create_document, replace_sections
from app.ingestion.normalizer import normalize_source
from app.ingestion.parsers import parse_upload
from app.ingestion.sectioner import section_text


def import_document(
    session: Session,
    filename: str,
    content: bytes,
    category: Literal["demo", "private"],
) -> tuple[SourceDocument, list[SourceSection]]:
    parsed = parse_upload(filename, content)

    # Detect Gutenberg boundaries and authored end-matter (Postscript, etc.).
    normalized = normalize_source(parsed.text)

    # Section the narrative body only — never the raw or the authored sections.
    narrative_sections = section_text(normalized.narrative_body)

    # Build authored sections (Postscript, Appendix…) as end_matter entries.
    # Append them after all narrative sections so ordinals stay contiguous.
    proposed: list[ProposedSection] = list(narrative_sections)
    next_ordinal = len(narrative_sections)
    for authored in normalized.authored_sections:
        proposed.append(ProposedSection(
            text=authored.text,
            ordinal=next_ordinal,
            title=authored.title,
            section_kind=authored.kind,
        ))
        next_ordinal += 1

    doc = create_document(
        session,
        title=parsed.title,
        original_filename=filename,
        mime_type=parsed.mime_type,
        content_hash=parsed.content_hash,
        parser_version=parsed.parser_version,
        category=category,
        raw_text=parsed.text,
        narrative_body_start=normalized.body_start,
        narrative_body_end=normalized.body_end,
        normalization_diagnostics=normalized.diagnostics or None,
        author=parsed.author,
        year=parsed.year,
    )

    sections = replace_sections(session, doc.id, proposed)
    return doc, sections
