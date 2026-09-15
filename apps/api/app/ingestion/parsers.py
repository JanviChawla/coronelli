import hashlib
import re
from dataclasses import dataclass, field

import pymupdf as fitz

PARSER_VERSION = "1.0"

_TITLE_RE = re.compile(r"^Title:\s*(.+)$", re.MULTILINE | re.IGNORECASE)
_AUTHOR_RE = re.compile(r"^Author:\s*(.+)$", re.MULTILINE | re.IGNORECASE)
_YEAR_RE = re.compile(
    r"(?:copyright|©|\(c\)|first\s+published|published(?:\s+in)?|written(?:\s+in)?)"
    r"\D{0,20}(1[3-9]\d{2}|20[0-2]\d)",
    re.IGNORECASE,
)


class TextExtractionUnavailableError(ValueError):
    pass


@dataclass
class ParsedDocument:
    title: str
    text: str
    content_hash: str
    mime_type: str
    parser_version: str
    author: str | None = field(default=None)
    year: int | None = field(default=None)


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _stem(filename: str) -> str:
    return filename.rsplit(".", 1)[0]


def _extract_year(text: str) -> int | None:
    m = _YEAR_RE.search(text)
    return int(m.group(1)) if m else None


def _parse_text(filename: str, content: bytes, mime_type: str) -> ParsedDocument:
    text = content.decode("utf-8", errors="replace")
    header = text[:4000]
    title_m = _TITLE_RE.search(header)
    author_m = _AUTHOR_RE.search(header)
    title = title_m.group(1).strip() if title_m else _stem(filename)
    author = author_m.group(1).strip() if author_m else None
    year = _extract_year(header)
    return ParsedDocument(
        title=title,
        text=text,
        content_hash=_sha256(content),
        mime_type=mime_type,
        parser_version=PARSER_VERSION,
        author=author,
        year=year,
    )


def _parse_pdf(filename: str, content: bytes) -> ParsedDocument:
    doc = fitz.open(stream=content, filetype="pdf")
    pages = [page.get_text() for page in doc]
    text = "\n".join(pages).strip()
    if not text:
        raise TextExtractionUnavailableError(
            f"'{filename}' contains no extractable text. "
            "Image-only PDFs (scanned without an OCR text layer) are not supported."
        )
    meta = doc.metadata or {}
    pdf_title = (meta.get("title") or "").strip() or None
    pdf_author = (meta.get("author") or "").strip() or None
    first_page = pages[0] if pages else ""
    year = _extract_year(first_page[:3000])
    return ParsedDocument(
        title=pdf_title or _stem(filename),
        text=text,
        content_hash=_sha256(content),
        mime_type="application/pdf",
        parser_version=PARSER_VERSION,
        author=pdf_author,
        year=year,
    )


def parse_upload(filename: str, content: bytes) -> ParsedDocument:
    lower = filename.lower()
    if lower.endswith(".txt"):
        return _parse_text(filename, content, "text/plain")
    if lower.endswith(".md"):
        return _parse_text(filename, content, "text/markdown")
    if lower.endswith(".pdf"):
        return _parse_pdf(filename, content)
    raise ValueError(
        f"Unsupported file type: '{filename}'. Accepted extensions: .txt, .md, .pdf"
    )
