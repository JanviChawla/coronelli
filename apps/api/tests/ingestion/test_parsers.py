import hashlib

import pytest

from app.ingestion.parsers import TextExtractionUnavailableError, parse_upload


def test_parse_txt_returns_text_and_mime(chapter_txt_bytes):
    doc = parse_upload("chapter-story.txt", chapter_txt_bytes)
    assert "barge" in doc.text.lower()
    assert doc.mime_type == "text/plain"


def test_parse_md_returns_text_and_mime(headed_md_bytes):
    doc = parse_upload("headed-story.md", headed_md_bytes)
    assert "observatory" in doc.text.lower()
    assert doc.mime_type == "text/markdown"


def test_parse_pdf_returns_page_text(text_bearing_pdf_bytes):
    doc = parse_upload("story.pdf", text_bearing_pdf_bytes)
    assert len(doc.text) > 0
    assert doc.mime_type == "application/pdf"


def test_parse_image_only_pdf_raises(image_only_pdf_bytes):
    with pytest.raises(TextExtractionUnavailableError):
        parse_upload("scan.pdf", image_only_pdf_bytes)


def test_content_hash_is_sha256(chapter_txt_bytes):
    doc = parse_upload("story.txt", chapter_txt_bytes)
    assert doc.content_hash == hashlib.sha256(chapter_txt_bytes).hexdigest()


def test_duplicate_bytes_produce_same_hash(headed_md_bytes):
    doc1 = parse_upload("copy-a.md", headed_md_bytes)
    doc2 = parse_upload("copy-b.md", headed_md_bytes)
    assert doc1.content_hash == doc2.content_hash


def test_different_bytes_produce_different_hash(chapter_txt_bytes, headed_md_bytes):
    doc1 = parse_upload("story.txt", chapter_txt_bytes)
    doc2 = parse_upload("story.md", headed_md_bytes)
    assert doc1.content_hash != doc2.content_hash


def test_parse_unsupported_extension_raises():
    with pytest.raises(ValueError, match="Unsupported"):
        parse_upload("story.docx", b"content")
