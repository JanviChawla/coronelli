"""
Tests for synthesis/review_approve.py.

Covers: _find_or_create_entity, _approve_entity, _approve_claim.
"""
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import SourceDocument, SourceSection
from app.domain.world import MapClaim, MapEntity
from app.extraction.models import Candidate, ExtractionRun
from app.synthesis.review_approve import (
    _approve_claim,
    _approve_entity,
    _find_or_create_entity,
)


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


@pytest.fixture
def doc(db):
    d = SourceDocument(
        id=str(uuid.uuid4()),
        title="Test Book",
        original_filename="test.txt",
        mime_type="text/plain",
        content_hash="abc",
        imported_at=datetime.now(timezone.utc),
        parser_version="1.0",
        category="demo",
    )
    db.add(d)
    db.commit()
    return d


@pytest.fixture
def section(db, doc):
    s = SourceSection(
        id=str(uuid.uuid4()),
        document_id=doc.id,
        ordinal=0,
        title="Chapter I",
        text="The village of Millhaven lay by the river.",
    )
    db.add(s)
    db.commit()
    return s


@pytest.fixture
def run(db, section):
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


def _make_candidate(db, run, section, kind, payload):
    c = Candidate(
        extraction_run_id=run.id,
        section_id=section.id,
        kind=kind,
        payload=payload,
        status="explicit",
        confidence=0.9,
        excerpt="Test excerpt.",
        rationale="Test rationale.",
        review_state="proposed",
        ordinal=0,
    )
    db.add(c)
    db.commit()
    return c


def _make_entity(db, doc, name, place_kind=None, aliases=None):
    e = MapEntity(
        name=name,
        entity_kind="place",
        place_kind=place_kind,
        status="explicit",
        state="active",
        provenance_document_id=doc.id,
        aliases=aliases or [],
        payload={},
    )
    db.add(e)
    db.commit()
    return e


# ── _find_or_create_entity ────────────────────────────────────────────────────

def test_creates_new_entity_when_none_exists(db, doc):
    entity = _find_or_create_entity(db, doc.id, "Millhaven", "settlement", {})
    db.flush()
    assert entity.name == "Millhaven"
    assert entity.place_kind == "settlement"
    assert entity.state == "active"
    assert entity.provenance_document_id == doc.id


def test_returns_existing_entity_by_exact_name(db, doc):
    existing = _make_entity(db, doc, "Millhaven", "settlement")
    result = _find_or_create_entity(db, doc.id, "Millhaven", "city", {})
    assert result.id == existing.id
    # should not have changed place_kind
    assert result.place_kind == "settlement"


def test_creates_new_entity_for_different_document(db, doc):
    _make_entity(db, doc, "Millhaven")
    other_doc_id = str(uuid.uuid4())
    entity = _find_or_create_entity(db, other_doc_id, "Millhaven", None, {})
    db.flush()
    assert entity.provenance_document_id == other_doc_id


def test_sets_provenance_document_id(db, doc, section, run):
    _make_candidate(db, run, section, "entity", {"name": "Millhaven", "type": "settlement"})
    entity = _find_or_create_entity(db, doc.id, "Millhaven", "settlement", {})
    db.flush()
    assert entity.provenance_document_id == doc.id


def test_sets_provenance_section_id_from_earliest_candidate(db, doc, section, run):
    _make_candidate(db, run, section, "entity", {"name": "Millhaven", "type": "settlement"})
    entity = _find_or_create_entity(db, doc.id, "Millhaven", "settlement", {})
    db.flush()
    assert entity.provenance_section_id == section.id


# ── _approve_entity ───────────────────────────────────────────────────────────

def test_approve_entity_creates_map_entity(db, doc):
    payload = {"name": "Millhaven", "type": "settlement"}
    entity = _approve_entity(db, doc.id, payload)
    db.flush()
    assert entity.name == "Millhaven"
    assert entity.place_kind == "settlement"
    assert entity.entity_kind == "place"
    assert entity.state == "active"


def test_approve_entity_sets_place_kind_from_type_field(db, doc):
    entity = _approve_entity(db, doc.id, {"name": "The River", "type": "waterway"})
    db.flush()
    assert entity.place_kind == "waterway"


def test_approve_entity_raises_on_missing_name(db, doc):
    with pytest.raises(ValueError, match="name"):
        _approve_entity(db, doc.id, {"type": "settlement"})


def test_approve_entity_no_located_in_attribute(db, doc):
    entity = _approve_entity(db, doc.id, {"name": "Millhaven", "type": "settlement"})
    db.flush()
    assert not hasattr(entity, "located_in"), (
        "MapEntity must not have a 'located_in' attribute — containment is expressed via MapClaim"
    )


def test_approve_entity_idempotent_on_same_name(db, doc):
    _approve_entity(db, doc.id, {"name": "Millhaven", "type": "settlement"})
    db.flush()
    _approve_entity(db, doc.id, {"name": "Millhaven", "type": "city"})
    db.flush()
    count = db.query(MapEntity).filter(
        MapEntity.provenance_document_id == doc.id,
        MapEntity.name == "Millhaven",
    ).count()
    assert count == 1


# ── _approve_claim ────────────────────────────────────────────────────────────

def test_approve_claim_creates_map_claim(db, doc):
    _make_entity(db, doc, "Millhaven")
    _make_entity(db, doc, "The River")
    payload = {"subject": "Millhaven", "predicate": "NEAR", "object": "The River"}
    claim = _approve_claim(db, doc.id, payload, "spatial")
    db.flush()
    assert claim.predicate == "NEAR"
    assert claim.claim_type == "spatial"
    assert claim.state == "active"


def test_approve_claim_resolves_subject_and_object_to_entity_ids(db, doc):
    subject = _make_entity(db, doc, "Millhaven")
    obj = _make_entity(db, doc, "The River")
    payload = {"subject": "Millhaven", "predicate": "NEAR", "object": "The River"}
    claim = _approve_claim(db, doc.id, payload, "spatial")
    db.flush()
    assert claim.subject_ref == subject.id
    assert claim.object_refs == [obj.id]


def test_approve_claim_with_unresolvable_subject_sets_none(db, doc):
    _make_entity(db, doc, "The River")
    payload = {"subject": "Unknown Place", "predicate": "NEAR", "object": "The River"}
    claim = _approve_claim(db, doc.id, payload, "spatial")
    db.flush()
    assert claim.subject_ref is None


def test_approve_claim_normalizes_contains_to_located_in(db, doc):
    container = _make_entity(db, doc, "Millhaven")
    contained = _make_entity(db, doc, "Town Hall")
    payload = {"subject": "Millhaven", "predicate": "CONTAINS", "object": "Town Hall"}
    claim = _approve_claim(db, doc.id, payload, "spatial")
    db.flush()
    assert claim.predicate == "LOCATED_IN"
    # CONTAINS flips direction: contained becomes subject, container becomes object
    assert claim.subject_ref == contained.id
    assert claim.object_refs == [container.id]


def test_approve_claim_visual_type(db, doc):
    _make_entity(db, doc, "Millhaven")
    payload = {"subject": "Millhaven", "category": "color", "observation": "grey stone"}
    claim = _approve_claim(db, doc.id, payload, "visual")
    db.flush()
    assert claim.claim_type == "visual"
