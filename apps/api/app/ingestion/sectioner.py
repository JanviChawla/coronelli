"""
Sectioning strategies (tried in order):

  1. Markdown headings             — # Title
  2. Isolated chapter keyword      — Chapter I. / SUBTITLE  (Peter Pan, Gutenberg)
  3. Roman-numeral + double-dash   — I--DOWN THE RABBIT-HOLE  (Alice pg19033)
  4. Bare CHAPTER keyword          — CHAPTER I. on its own line  (Pride & Prejudice)
  5. ToC-based                     — body subtitle headings mapped via ToC  (Oz)
  6. Numeric chapter headings      — 1 Birth and Prophecy  (Firebringer)
  7. Fallback                      — single "Section 1"

Strategies 2-6 use blank-line or structural isolation so that chapter-like words
inside prose never create spurious sections.
"""
import re

from app.domain.sources import ProposedSection


# ── Roman numeral helpers ──────────────────────────────────────────────────────

_ROMAN_MAP = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}


def _roman_to_int(s: str) -> int | None:
    s = s.upper()
    if not s or not all(c in _ROMAN_MAP for c in s):
        return None
    result, prev = 0, 0
    for c in reversed(s):
        v = _ROMAN_MAP[c]
        result += v if v >= prev else -v
        prev = v
    return result or None


# ── Smart title-case that doesn't capitalise apostrophe-suffixes ───────────────

_SMALL_WORDS = frozenset({
    "a", "an", "the", "and", "but", "or", "for", "nor", "so", "yet",
    "at", "by", "in", "of", "on", "to", "up", "as", "is",
})

def _capitalize_word(word: str) -> str:
    """Capitalize first letter of a word, handling hyphens and apostrophes."""
    if "-" in word:
        return "-".join(_capitalize_word(p) for p in word.split("-"))
    parts = word.split("'")
    parts[0] = parts[0].capitalize()
    return "'".join(p.lower() if j > 0 else p for j, p in enumerate(parts))


def _smart_title(s: str) -> str:
    """Title-case s: capitalize content words, lowercase small words mid-phrase,
    handle hyphens and don't capitalize apostrophe-suffixes ('s, 't, etc.)."""
    words = s.split()
    result = []
    for i, word in enumerate(words):
        base = word.split("'")[0].lower()
        if i == 0 or i == len(words) - 1 or base not in _SMALL_WORDS:
            result.append(_capitalize_word(word))
        else:
            result.append(word.lower())
    return " ".join(result)


# ── Strategy 1: Markdown headings ─────────────────────────────────────────────

_MARKDOWN_HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)


def _split_by_markdown(text: str) -> list[ProposedSection]:
    matches = list(_MARKDOWN_HEADING_RE.finditer(text))
    if not matches:
        return []
    sections: list[ProposedSection] = []
    for i, m in enumerate(matches):
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections.append(ProposedSection(
            title=m.group(1).strip(),
            text=text[m.end():body_end].strip(),
            ordinal=i,
        ))
    return sections


# ── Strategy 2: Isolated chapter keyword (Peter Pan) ──────────────────────────

# Heading must be preceded by \n\n AND alone on its line (lookahead (?=[ \t]*\n))
# so ToC entries like " Chapter I. PETER BREAKS THROUGH" are excluded.
_CHAPTER_ISOLATED_RE = re.compile(
    r"(?<=\n\n)[ \t]*((?:chapter|part|book)\s+\w+\.?)(?=[ \t]*\n)",
    re.IGNORECASE,
)


def _normalize_chapter_heading(raw: str) -> str:
    s = raw.strip().rstrip(".,;")
    s = re.sub(r"^(chapter|part|book)", lambda m: m.group(0).title(), s, flags=re.IGNORECASE)
    # Spelled-out ordinals (ONE, TWO, …) are not Roman numerals — title-case them.
    m = re.match(r"^(Chapter|Part|Book)\s+([A-Z]+)(\.?)$", s)
    if m and _roman_to_int(m.group(2)) is None:
        s = f"{m.group(1)} {m.group(2).capitalize()}{m.group(3)}"
    return s


def _pop_subtitle(body: str) -> tuple[str | None, str]:
    """Subtitle is on the very next line (one \\n) or after one blank line (\\n\\n), followed by a blank line."""
    if not body.startswith("\n"):
        return None, body

    if not body.startswith("\n\n"):
        # Case 1: subtitle immediately follows (Peter Pan style)
        after_newline = body[1:]
        nl = after_newline.find("\n")
        if nl == -1:
            return None, body
        first_line = after_newline[:nl].rstrip("\r").strip()
        rest = after_newline[nl + 1:]
        if (
            0 < len(first_line) <= 60
            and not re.match(r"^(?:chapter|part|book)\s+\w+", first_line, re.IGNORECASE)
            and bool(rest) and rest[0] == "\n"
        ):
            return first_line, rest
    else:
        # Case 2: subtitle after one blank line (HP style: CHAPTER ONE\n\nTHE BOY WHO LIVED)
        # Guard: line must be ALL-CAPS to distinguish from prose.
        after_blank = body[2:]
        nl = after_blank.find("\n")
        if nl == -1:
            return None, body
        first_line = after_blank[:nl].rstrip("\r").strip()
        rest = after_blank[nl + 1:]
        if (
            0 < len(first_line) <= 70
            and first_line == first_line.upper()
            and re.search(r"[A-Z]", first_line)
            and not re.match(r"^(?:chapter|part|book)\s+\w+", first_line, re.IGNORECASE)
            and bool(rest) and rest[0] == "\n"
        ):
            return _smart_title(first_line), rest

    return None, body


def _split_by_chapter_keyword(text: str) -> list[ProposedSection]:
    padded = "\n\n" + text
    matches = list(_CHAPTER_ISOLATED_RE.finditer(padded))
    if len(matches) < 2:
        return []
    sections: list[ProposedSection] = []
    for i, m in enumerate(matches):
        heading = _normalize_chapter_heading(m.group(1))
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(padded)
        body = padded[m.end():body_end]
        subtitle, body = _pop_subtitle(body)
        title = f"{heading}. {subtitle}" if subtitle else heading
        sections.append(ProposedSection(title=title, text=body.strip(), ordinal=i))
    return sections


# ── Strategy 3: Roman-numeral + double-dash (Alice pg19033) ───────────────────

_ROMAN_DASH_RE = re.compile(r"(?<=\n\n)[ \t]*([IVXLCDM]+)--([^\n]+)")


def _split_by_roman_dash(text: str) -> list[ProposedSection]:
    padded = "\n\n" + text
    matches = list(_ROMAN_DASH_RE.finditer(padded))
    if len(matches) < 2:
        return []
    sections: list[ProposedSection] = []
    for i, m in enumerate(matches):
        roman = m.group(1).strip()
        raw_subtitle = m.group(2).strip()
        subtitle = _smart_title(raw_subtitle) if raw_subtitle == raw_subtitle.upper() else raw_subtitle
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(padded)
        sections.append(ProposedSection(
            title=f"Chapter {roman}. {subtitle}",
            text=padded[m.end():body_end].strip(),
            ordinal=i,
        ))
    return sections


# ── Strategy 4: Bare CHAPTER keyword on its own line (Pride & Prejudice) ──────

# Matches ALL-CAPS CHAPTER [ROMAN]. alone on its own line (single \n before it).
_BARE_CHAPTER_RE = re.compile(r"\nCHAPTER ([IVXLCDM]+)\.\n")

# Standard Roman numerals for volume prefixing.
_VOLUME_ROMANS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]


def _split_by_bare_chapter(text: str) -> list[ProposedSection]:
    padded = "\n" + text
    matches = list(_BARE_CHAPTER_RE.finditer(padded))
    if len(matches) < 2:
        return []

    # Detect numbering restarts: when a chapter's value ≤ the previous chapter's
    # value, a new volume has begun.  Assign a volume index to every match.
    values = [_roman_to_int(m.group(1)) or 0 for m in matches]
    volume_indices: list[int] = []
    vol = 0
    prev_val = 0
    for v in values:
        if v <= prev_val:
            vol += 1
        volume_indices.append(vol)
        prev_val = v

    multi_volume = vol > 0  # at least one restart occurred

    sections: list[ProposedSection] = []
    for i, m in enumerate(matches):
        roman = m.group(1)
        if multi_volume:
            vol_label = _VOLUME_ROMANS[volume_indices[i]] if volume_indices[i] < len(_VOLUME_ROMANS) else str(volume_indices[i] + 1)
            title = f"Vol. {vol_label} · Chapter {roman}"
        else:
            title = f"Chapter {roman}"

        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(padded)
        body = padded[m.end():body_end]
        # Strip PDF page-marker lines (e.g. "- [Vol. I] 8 -").
        body = re.sub(r"^[^\n]*-\s*\[.*?\]\s*\d+\s*-[^\n]*\n?", "", body, flags=re.MULTILINE)
        sections.append(ProposedSection(
            title=title,
            text=body.strip(),
            ordinal=i,
        ))
    return sections


# ── Strategy 5: ToC-based (Oz) ────────────────────────────────────────────────

_TOC_ENTRY_RE = re.compile(
    r"^[ \t]+((?:chapter|part|book)\s+[IVXLCDM]+\.?\s+.+)$",
    re.MULTILINE | re.IGNORECASE,
)
_ISOLATED_LINE_RE = re.compile(r"(?<=\n\n)[ \t]*([^\n\[]{1,100})(?=\n\n)")
_STRUCTURAL_KEYWORDS = frozenset({
    "contents", "introduction", "preface", "foreword", "epilogue",
    "prologue", "appendix", "afterword", "dedication",
})


def _parse_toc(text: str) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for m in _TOC_ENTRY_RE.finditer(text):
        entry = m.group(1).strip()
        dot_space = entry.find(". ")
        if dot_space == -1:
            continue
        chapter_part = entry[:dot_space]
        subtitle = entry[dot_space + 2:]
        norm = re.sub(
            r"^(chapter|part|book)", lambda x: x.group(0).title(),
            chapter_part, flags=re.IGNORECASE,
        )
        mapping[subtitle.strip().lower()] = f"{norm}. {subtitle.strip()}"
    return mapping


def _split_by_toc(text: str) -> list[ProposedSection]:
    toc = _parse_toc(text)
    if len(toc) < 2:
        return []
    padded = "\n\n" + text
    headings: list[tuple[int, int, str]] = []
    for m in _ISOLATED_LINE_RE.finditer(padded):
        block = m.group(1).strip()
        lower = block.lower()
        if lower in toc:
            title = toc[lower]
        elif lower in _STRUCTURAL_KEYWORDS:
            title = block
        else:
            continue
        headings.append((m.start(1), m.end(0), title))
    if len(headings) < 2:
        return []
    sections: list[ProposedSection] = []
    for i, (_, hend, title) in enumerate(headings):
        next_start = headings[i + 1][0] if i + 1 < len(headings) else len(padded)
        sections.append(ProposedSection(
            title=title,
            text=padded[hend:next_start].strip(),
            ordinal=i,
        ))
    return sections


# ── Strategy 6: Numeric chapter headings (Firebringer) ────────────────────────

# "Part X - \n8 Sgorr" — collapse the part-header line so the chapter number
# is preceded by \n\n, making it detectable by the standard isolated pattern.
_PART_HEADER_RE = re.compile(r"(Part\s+\w+\s*-\s*)\n(\d)", re.IGNORECASE)
_NUMERIC_ISOLATED_RE = re.compile(r"(?<=\n\n)(\d{1,2})\s+([A-Z][^\n]{2,60})(?=\n)")


def _split_by_numeric_chapters(text: str) -> list[ProposedSection]:
    # Normalise "Part X - \nN Title" → "\n\nN Title" so chapters are isolated.
    normalised = _PART_HEADER_RE.sub(r"\n\n\2", "\n\n" + text)
    matches = list(_NUMERIC_ISOLATED_RE.finditer(normalised))
    if len(matches) < 2:
        return []

    # Verify consecutive numbering to avoid false positives (e.g. "100 hinds gathered").
    numbers = [int(m.group(1)) for m in matches]
    expected = list(range(numbers[0], numbers[0] + len(numbers)))
    if numbers != expected:
        return []

    sections: list[ProposedSection] = []
    for i, m in enumerate(matches):
        title = f"{m.group(1)} {m.group(2).strip()}"
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(normalised)
        sections.append(ProposedSection(
            title=title,
            text=normalised[m.end():body_end].strip(),
            ordinal=i,
        ))
    return sections


# ── Entry point ───────────────────────────────────────────────────────────────

def section_text(text: str) -> list[ProposedSection]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    for strategy in (
        _split_by_markdown,
        _split_by_bare_chapter,       # ALL-CAPS CHAPTER keyword (Pride & Prejudice)
        _split_by_chapter_keyword,    # mixed-case Chapter keyword (Peter Pan, Gutenberg)
        _split_by_roman_dash,         # I--SUBTITLE (Alice pg19033)
        _split_by_toc,                # ToC-mapped subtitle headings (Oz)
        _split_by_numeric_chapters,   # N Title (Firebringer)
    ):
        sections = strategy(text)
        if sections:
            return sections

    return [ProposedSection(title="Section 1", text=text.strip(), ordinal=0)]
