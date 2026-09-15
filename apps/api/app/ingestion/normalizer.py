"""Source text normalisation: Gutenberg boundary detection and authored end-matter extraction.

Produces a NormalizedSource separating:
  - raw_text      : the original decoded string, unchanged (for auditability)
  - narrative_body: text between Gutenberg markers, minus any authored end matter
  - body_start/end: character offsets of narrative_body within raw_text
  - authored_sections: editorial sections (Postscript, Appendix …) excluded by default
  - diagnostics   : problems encountered during detection

All offsets refer to the Python string coordinate space (raw_text may have had
\r\n normalised to \n before regex matching; the stored raw_text reflects what
the caller passes in).
"""
import re
from dataclasses import dataclass, field

# Both START and END must be present and in order; otherwise the full text is used.
_GUTENBERG_START = re.compile(
    r"\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG\b[^\n]*\*{3}",
    re.IGNORECASE,
)
_GUTENBERG_END = re.compile(
    r"\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG\b[^\n]*\*{3}",
    re.IGNORECASE,
)

# Matches authored end-matter keywords on their own line, preceded by ≥2 blank lines.
# Group 1 captures the keyword (POSTSCRIPT, EPILOGUE, AFTERWORD, APPENDIX).
# Uses \n{2,} (not lookbehind) so it handles any number of blank lines robustly.
_AUTHORED_END_MATTER = re.compile(
    r"\n{2,}"
    r"(POSTSCRIPT|Postscript|EPILOGUE|Epilogue|AFTERWORD|Afterword|APPENDIX|Appendix)"
    r"\.?\s*\n",
)


@dataclass
class AuthoredSection:
    title: str
    kind: str           # "end_matter" | "front_matter"
    start_in_raw: int   # character offset of the first char of this section in raw_text
    text: str           # full text of this authored section (stripped)


@dataclass
class NormalizedSource:
    raw_text: str
    narrative_body: str     # stripped text eligible for sectioning and LLM extraction
    body_start: int         # offset of narrative_body[0] within raw_text
    body_end: int           # offset one past narrative_body[-1] within raw_text
    authored_sections: list[AuthoredSection] = field(default_factory=list)
    diagnostics: list[str] = field(default_factory=list)


def normalize_source(raw_text: str) -> NormalizedSource:
    """Detect Gutenberg boundaries and authored end-matter; return a NormalizedSource.

    If Gutenberg markers are absent or ambiguous the full text is used and a
    diagnostic is emitted — content is never silently deleted.
    """
    diagnostics: list[str] = []

    # Normalise line endings for pattern matching (raw_text stored unchanged).
    text = raw_text.replace("\r\n", "\n").replace("\r", "\n")

    # ── 1. Gutenberg boundary detection ──────────────────────────────────────
    start_match = _GUTENBERG_START.search(text)
    end_match   = _GUTENBERG_END.search(text)

    if start_match and end_match and start_match.start() < end_match.start():
        # gut_start: first char after the newline that closes the START line.
        nl_after_start = text.find("\n", start_match.end())
        gut_start = (nl_after_start + 1) if nl_after_start != -1 else start_match.end()

        # gut_end: char just before the line containing the END marker.
        prev_nl = text.rfind("\n", 0, end_match.start())
        gut_end = (prev_nl + 1) if prev_nl != -1 else end_match.start()

        gutenberg_body = text[gut_start:gut_end]
    else:
        if not start_match:
            diagnostics.append(
                "Gutenberg START marker not found; using full source text as narrative body."
            )
        elif not end_match:
            diagnostics.append(
                "Gutenberg END marker not found; using full source text as narrative body."
            )
        else:
            diagnostics.append(
                "Gutenberg markers found out of order; using full source text as narrative body."
            )
        gut_start = 0
        gut_end   = len(text)
        gutenberg_body = text

    # ── 2. Authored end-matter detection within the Gutenberg body ────────────
    authored_sections: list[AuthoredSection] = []
    narrative_end_in_body = len(gutenberg_body)

    em_match = _AUTHORED_END_MATTER.search(gutenberg_body)
    if em_match:
        # Start the authored section at the keyword (group 1), not at the blank lines.
        keyword_start = em_match.start(1)
        narrative_end_in_body = keyword_start
        em_text = gutenberg_body[keyword_start:].strip()
        authored_sections.append(AuthoredSection(
            title=em_match.group(1).capitalize(),
            kind="end_matter",
            start_in_raw=gut_start + keyword_start,
            text=em_text,
        ))

    # ── 3. Compute precise offsets for the narrative body in raw_text ─────────
    main_slice   = gutenberg_body[:narrative_end_in_body]
    leading_ws   = len(main_slice) - len(main_slice.lstrip())
    narrative_body = main_slice.strip()
    body_start   = gut_start + leading_ws
    body_end     = body_start + len(narrative_body)

    return NormalizedSource(
        raw_text=raw_text,
        narrative_body=narrative_body,
        body_start=body_start,
        body_end=body_end,
        authored_sections=authored_sections,
        diagnostics=diagnostics,
    )
