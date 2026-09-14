from pathlib import Path

import pymupdf as fitz
import pytest

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def headed_md_bytes() -> bytes:
    return (FIXTURES / "headed-story.md").read_bytes()


@pytest.fixture(scope="session")
def chapter_txt_bytes() -> bytes:
    return (FIXTURES / "chapter-story.txt").read_bytes()


@pytest.fixture(scope="session")
def text_bearing_pdf_bytes() -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "The Glass Bay\n\nChapter 1\nThe barge drifted south.", fontsize=12)
    return doc.tobytes()


@pytest.fixture(scope="session")
def image_only_pdf_bytes() -> bytes:
    """A PDF page containing only a vector drawing — no text layer."""
    doc = fitz.open()
    page = doc.new_page()
    page.draw_rect(fitz.Rect(72, 72, 300, 300), color=(0, 0, 0), fill=(0.9, 0.9, 0.9))
    return doc.tobytes()
