"""
Library model tests: Series, standalone works, and book assignment.

Invariants:
- A standalone document has series_id=None and series_order=None.
- A Series can be created empty and listed.
- A document is assigned to a series explicitly with an explicit series_order.
- series_order is never inferred from filename, upload order, title, or date.
- A document with only proposed candidates may be freely reassigned.
- A document with any reviewed candidate or canonical record blocks reassignment.
- Removing a document from a series clears series_id and series_order.
- Deleting an empty series succeeds; deleting one with books raises SeriesError.
"""
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import SourceDocument, SourceSection
from app.domain.series import (
    SeriesError,
    assign_to_series,
    create_series,
    delete_series,
    get_series,
    list_series,
    remove_from_series,
)
from app.extraction.models import Candidate, ExtractionRun
from app.domain.world import MapEntity


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    Base.metadata.drop_all(engine)


def _doc(db, title="Test Book"):
    d = SourceDocument(
        id=str(uuid.uuid4()),
        title=title,
        original_filename="test.txt",
        mime_type="text/plain",
        content_hash=str(uuid.uuid4()),
        imported_at=datetime.now(timezone.utc),
        parser_version="1.0",
        category="demo",
    )
    db.add(d)
    db.commit()
    return d


def _section(db, doc):
    s = SourceSection(
        id=str(uuid.uuid4()),
        document_id=doc.id,
        ordinal=0,
        title="Chapter I",
        text="Once upon a time.",
    )
    db.add(s)
    db.commit()
    return s


def _extraction_run(db, section):
    r = ExtractionRun(
        section_id=section.id,
        status="completed",
        provider="fake",
        model="fake-v1",
        prompt_version="0.2",
    )
    db.add(r)
    db.commit()
    return r


def _candidate(db, run, section, review_state="proposed"):
    c = Candidate(
        extraction_run_id=run.id,
        section_id=section.id,
        kind="entity",
        payload={"name": "Casterbridge", "type": "settlement"},
        status="explicit",
        confidence=0.9,
        excerpt="Casterbridge.",
        rationale="Named place.",
        review_state=review_state,
        ordinal=0,
    )
    db.add(c)
    db.commit()
    return c


# ── Standalone document ───────────────────────────────────────────────────────

def test_standalone_document_has_no_series(db):
    doc = _doc(db)
    assert doc.series_id is None
    assert doc.series_order is None


# ── Series creation and listing ───────────────────────────────────────────────

def test_create_series(db):
    s = create_series(db, name="The Land of Elyon", category="demo")
    assert s.id is not None
    assert s.name == "The Land of Elyon"
    assert s.category == "demo"


def test_list_series_returns_created(db):
    create_series(db, name="Elyon", category="demo")
    create_series(db, name="Zenda", category="demo")
    result = list_series(db)
    names = [s.name for s in result]
    assert "Elyon" in names
    assert "Zenda" in names


def test_get_series_returns_none_for_missing(db):
    assert get_series(db, "no-such-id") is None


def test_empty_series_has_no_books(db):
    s = create_series(db, name="Empty Series", category="demo")
    from app.db.models import SourceDocument as SD
    from sqlalchemy import select
    books = db.execute(select(SD).where(SD.series_id == s.id)).scalars().all()
    assert books == []


# ── Book assignment ───────────────────────────────────────────────────────────

def test_assign_document_to_series(db):
    s = create_series(db, name="Elyon", category="demo")
    doc = _doc(db)
    assign_to_series(db, document_id=doc.id, series_id=s.id, series_order=1)
    db.refresh(doc)
    assert doc.series_id == s.id
    assert doc.series_order == 1


def test_assign_two_books_with_explicit_order(db):
    s = create_series(db, name="Elyon", category="demo")
    book1 = _doc(db, "Book One")
    book2 = _doc(db, "Book Two")
    assign_to_series(db, document_id=book1.id, series_id=s.id, series_order=1)
    assign_to_series(db, document_id=book2.id, series_id=s.id, series_order=2)
    db.refresh(book1)
    db.refresh(book2)
    assert book1.series_order == 1
    assert book2.series_order == 2


def test_assign_proposed_only_document_succeeds(db):
    s = create_series(db, name="Elyon", category="demo")
    doc = _doc(db)
    sec = _section(db, doc)
    run = _extraction_run(db, sec)
    _candidate(db, run, sec, review_state="proposed")
    # Must not raise — only proposed candidates means freely reassignable
    assign_to_series(db, document_id=doc.id, series_id=s.id, series_order=1)
    db.refresh(doc)
    assert doc.series_id == s.id


def test_assign_reviewed_document_raises_series_error(db):
    s = create_series(db, name="Elyon", category="demo")
    doc = _doc(db)
    sec = _section(db, doc)
    run = _extraction_run(db, sec)
    _candidate(db, run, sec, review_state="approved")
    with pytest.raises(SeriesError, match="review"):
        assign_to_series(db, document_id=doc.id, series_id=s.id, series_order=1)


def test_assign_document_with_canonical_record_raises_series_error(db):
    s = create_series(db, name="Elyon", category="demo")
    doc = _doc(db)
    sec = _section(db, doc)
    entity = MapEntity(
        name="Casterbridge",
        entity_kind="place",
        status="explicit",
        state="active",
        provenance_document_id=doc.id,
        provenance_section_id=sec.id,
        payload={},
    )
    db.add(entity)
    db.commit()
    with pytest.raises(SeriesError, match="review"):
        assign_to_series(db, document_id=doc.id, series_id=s.id, series_order=1)


def test_assign_nonexistent_document_raises_series_error(db):
    s = create_series(db, name="Elyon", category="demo")
    with pytest.raises(SeriesError, match="not found"):
        assign_to_series(db, document_id="no-such-id", series_id=s.id, series_order=1)


def test_assign_to_nonexistent_series_raises_series_error(db):
    doc = _doc(db)
    with pytest.raises(SeriesError, match="not found"):
        assign_to_series(db, document_id=doc.id, series_id="no-such-series", series_order=1)


# ── Remove from series ────────────────────────────────────────────────────────

def test_remove_from_series_clears_fields(db):
    s = create_series(db, name="Elyon", category="demo")
    doc = _doc(db)
    assign_to_series(db, document_id=doc.id, series_id=s.id, series_order=1)
    remove_from_series(db, document_id=doc.id)
    db.refresh(doc)
    assert doc.series_id is None
    assert doc.series_order is None


def test_remove_reviewed_document_from_series_raises_series_error(db):
    s = create_series(db, name="Elyon", category="demo")
    doc = _doc(db)
    assign_to_series(db, document_id=doc.id, series_id=s.id, series_order=1)
    sec = _section(db, doc)
    run = _extraction_run(db, sec)
    _candidate(db, run, sec, review_state="rejected")
    with pytest.raises(SeriesError, match="review"):
        remove_from_series(db, document_id=doc.id)


# ── Delete series ─────────────────────────────────────────────────────────────

def test_delete_empty_series_succeeds(db):
    s = create_series(db, name="Elyon", category="demo")
    delete_series(db, series_id=s.id)
    assert get_series(db, s.id) is None


def test_delete_series_with_books_raises_series_error(db):
    s = create_series(db, name="Elyon", category="demo")
    doc = _doc(db)
    assign_to_series(db, document_id=doc.id, series_id=s.id, series_order=1)
    with pytest.raises(SeriesError, match="books"):
        delete_series(db, series_id=s.id)


def test_delete_nonexistent_series_raises_series_error(db):
    with pytest.raises(SeriesError, match="not found"):
        delete_series(db, series_id="no-such-id")
