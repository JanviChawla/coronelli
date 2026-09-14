import hashlib
from dataclasses import dataclass

import pymupdf as fitz

PARSER_VERSION = "1.0"


class TextExtractionUnavailableError(ValueError):
    pass


@dataclass
class ParsedDocument:
    title: str
    text: str
    content_hash: str
    mime_type: str
    parser_version: str


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _stem(filename: str) -> str:
    return filename.rsplit(".", 1)[0]


def _parse_text(filename: str, content: bytes, mime_type: str) -> ParsedDocument:
    text = content.decode("utf-8", errors="replace")
    return ParsedDocument(
        title=_stem(filename),
        text=text,
        content_hash=_sha256(content),
        mime_type=mime_type,
        parser_version=PARSER_VERSION,
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
    return ParsedDocument(
        title=_stem(filename),
        text=text,
        content_hash=_sha256(content),
        mime_type="application/pdf",
        parser_version=PARSER_VERSION,
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
