import re

from app.domain.sources import ProposedSection

_MARKDOWN_HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)
_CHAPTER_RE = re.compile(r"^(Chapter\s+\w+[^\n]*)", re.MULTILINE | re.IGNORECASE)


def _split_by_pattern(text: str, pattern: re.Pattern) -> list[ProposedSection]:
    matches = list(pattern.finditer(text))
    if not matches:
        return []
    sections: list[ProposedSection] = []
    for i, match in enumerate(matches):
        body_start = match.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[body_start:body_end].strip()
        sections.append(ProposedSection(
            title=match.group(1).strip(),
            text=body,
            ordinal=i,
        ))
    return sections


def section_text(text: str) -> list[ProposedSection]:
    sections = _split_by_pattern(text, _MARKDOWN_HEADING_RE)
    if sections:
        return sections

    sections = _split_by_pattern(text, _CHAPTER_RE)
    if sections:
        return sections

    return [ProposedSection(title=None, text=text.strip(), ordinal=0)]
