import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.domain.sources import ProposedSection, create_document, list_sections, replace_sections


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    Base.metadata.drop_all(engine)


def _doc(session, *, title="Test Book", category="demo"):
    return create_document(
        session,
        title=title,
        original_filename="test.txt",
        mime_type="text/plain",
        content_hash="abc123",
        parser_version="1.0",
        category=category,
    )


def test_create_document_returns_id_and_fields(db_session):
    doc = _doc(db_session)
    assert doc.id is not None
    assert doc.title == "Test Book"
    assert doc.category == "demo"


def test_two_documents_have_distinct_ids(db_session):
    d1 = _doc(db_session, title="A")
    d2 = _doc(db_session, title="B")
    assert d1.id != d2.id


def test_replace_sections_stores_two_sections(db_session):
    doc = _doc(db_session)
    sections = replace_sections(db_session, doc.id, [
        ProposedSection(title="Ch 1", text="Content one", ordinal=0),
        ProposedSection(title="Ch 2", text="Content two", ordinal=1),
    ])
    assert len(sections) == 2
    assert all(s.document_id == doc.id for s in sections)


def test_replace_sections_preserves_document_id(db_session):
    doc = _doc(db_session)
    replace_sections(db_session, doc.id, [ProposedSection(title="Ch", text="Text", ordinal=0)])
    listed = list_sections(db_session, doc.id)
    assert all(s.document_id == doc.id for s in listed)


def test_list_sections_returns_ordinal_order(db_session):
    doc = _doc(db_session)
    replace_sections(db_session, doc.id, [
        ProposedSection(title="Second", text="...", ordinal=1),
        ProposedSection(title="First", text="...", ordinal=0),
    ])
    sections = list_sections(db_session, doc.id)
    assert sections[0].ordinal == 0
    assert sections[0].title == "First"
    assert sections[1].ordinal == 1
    assert sections[1].title == "Second"


def test_replace_sections_removes_previous_sections(db_session):
    doc = _doc(db_session)
    replace_sections(db_session, doc.id, [ProposedSection(title="Old", text="old", ordinal=0)])
    replace_sections(db_session, doc.id, [ProposedSection(title="New", text="new", ordinal=0)])
    sections = list_sections(db_session, doc.id)
    assert len(sections) == 1
    assert sections[0].title == "New"


def test_replace_sections_does_not_affect_other_documents(db_session):
    doc_a = _doc(db_session, title="A")
    doc_b = _doc(db_session, title="B")
    replace_sections(db_session, doc_a.id, [ProposedSection(title="A-sec", text="a", ordinal=0)])
    replace_sections(db_session, doc_b.id, [ProposedSection(title="B-sec", text="b", ordinal=0)])
    assert list_sections(db_session, doc_a.id)[0].title == "A-sec"
    assert list_sections(db_session, doc_b.id)[0].title == "B-sec"


def test_section_optional_fields_default(db_session):
    doc = _doc(db_session)
    sections = replace_sections(db_session, doc.id, [
        ProposedSection(title=None, text="no title", ordinal=0),
    ])
    assert sections[0].title is None
    assert sections[0].page_start is None
    assert sections[0].page_end is None
    assert sections[0].user_corrected is False
