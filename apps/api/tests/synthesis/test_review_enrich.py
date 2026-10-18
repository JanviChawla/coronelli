"""
Tests for synthesis/review_enrich.py.

Covers: apply_catalog_fields, _fill_entity_gaps.
"""
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import SourceDocument, SourceSection
from app.domain.world import MapEntity
from app.extraction.models import Candidate, ExtractionRun
from app.synthesis.review_enrich import apply_catalog_fields, _fill_entity_gaps


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


def _make_entity_candidate(db, run, section, payload, review_state="proposed"):
    c = Candidate(
        extraction_run_id=run.id,
        section_id=section.id,
        kind="entity",
        payload=payload,
        status="explicit",
        confidence=0.9,
        excerpt="Test excerpt.",
        rationale="Test rationale.",
        review_state=review_state,
        ordinal=0,
    )
    db.add(c)
    db.commit()
    return c


def _make_entity(db, doc, name, place_kind=None, payload=None):
    e = MapEntity(
        name=name,
        entity_kind="place",
        place_kind=place_kind,
        status="explicit",
        state="active",
        provenance_document_id=doc.id,
        aliases=[],
        payload=payload or {},
    )
    db.add(e)
    db.commit()
    return e


# ── apply_catalog_fields ──────────────────────────────────────────────────────

def test_stamps_significance_from_candidate(db, doc, section, run):
    _make_entity_candidate(db, run, section, {
        "name": "Millhaven",
        "type": "settlement",
        "significance": "The main town in the story",
    })
    entity = _make_entity(db, doc, "Millhaven")

    apply_catalog_fields(db, doc.id)
    db.refresh(entity)

    assert entity.payload.get("significance") == "The main town in the story"


def test_stamps_description_from_note_field(db, doc, section, run):
    _make_entity_candidate(db, run, section, {
        "name": "Millhaven",
        "type": "settlement",
        "note": "A grey stone village",
    })
    entity = _make_entity(db, doc, "Millhaven")

    apply_catalog_fields(db, doc.id)
    db.refresh(entity)

    assert entity.payload.get("description") == "A grey stone village"


def test_stamps_kind_descriptor(db, doc, section, run):
    _make_entity_candidate(db, run, section, {
        "name": "Millhaven",
        "kind_descriptor": "medieval market town",
    })
    entity = _make_entity(db, doc, "Millhaven")

    apply_catalog_fields(db, doc.id)
    db.refresh(entity)

    assert entity.payload.get("kind_descriptor") == "medieval market town"


def test_does_not_overwrite_existing_significance(db, doc, section, run):
    _make_entity_candidate(db, run, section, {
        "name": "Millhaven",
        "significance": "Candidate significance",
    })
    entity = _make_entity(db, doc, "Millhaven", payload={"significance": "Original significance"})

    apply_catalog_fields(db, doc.id)
    db.refresh(entity)

    assert entity.payload["significance"] == "Original significance"


def test_does_not_overwrite_existing_description(db, doc, section, run):
    _make_entity_candidate(db, run, section, {
        "name": "Millhaven",
        "note": "Candidate note",
    })
    entity = _make_entity(db, doc, "Millhaven", payload={"description": "Original description"})

    apply_catalog_fields(db, doc.id)
    db.refresh(entity)

    assert entity.payload["description"] == "Original description"


def test_skips_rejected_candidates(db, doc, section, run):
    _make_entity_candidate(db, run, section, {
        "name": "Millhaven",
        "significance": "Should be ignored",
    }, review_state="rejected")
    entity = _make_entity(db, doc, "Millhaven")

    apply_catalog_fields(db, doc.id)
    db.refresh(entity)

    assert entity.payload.get("significance") is None


def test_no_op_when_no_sections(db, doc):
    entity = _make_entity(db, doc, "Millhaven")
    apply_catalog_fields(db, doc.id)
    db.refresh(entity)
    assert entity.payload == {}


# ── _fill_entity_gaps ─────────────────────────────────────────────────────────

def test_creates_entity_for_uncovered_catalog_candidate(db, doc, section, run):
    _make_entity_candidate(db, run, section, {"name": "The River", "type": "waterway"})

    count_before = db.query(MapEntity).filter(
        MapEntity.provenance_document_id == doc.id
    ).count()
    filled = _fill_entity_gaps(db, doc.id)
    db.flush()
    count_after = db.query(MapEntity).filter(
        MapEntity.provenance_document_id == doc.id
    ).count()

    assert filled == 1
    assert count_after == count_before + 1
    new_entity = db.query(MapEntity).filter(
        MapEntity.provenance_document_id == doc.id,
        MapEntity.name == "The River",
    ).one()
    assert new_entity.place_kind == "waterway"
    assert new_entity.state == "active"


def test_skips_candidate_already_covered_by_entity(db, doc, section, run):
    _make_entity_candidate(db, run, section, {"name": "Millhaven", "type": "settlement"})
    _make_entity(db, doc, "Millhaven")

    filled = _fill_entity_gaps(db, doc.id)

    assert filled == 0


def test_skips_rejected_candidates(db, doc, section, run):
    _make_entity_candidate(db, run, section, {"name": "Ghost Town"}, review_state="rejected")

    filled = _fill_entity_gaps(db, doc.id)

    assert filled == 0
    count = db.query(MapEntity).filter(
        MapEntity.provenance_document_id == doc.id
    ).count()
    assert count == 0


def test_skips_candidate_covered_by_alias(db, doc, section, run):
    _make_entity_candidate(db, run, section, {"name": "Millhaven Village"})
    entity = _make_entity(db, doc, "Millhaven", payload={})
    entity.aliases = ["Millhaven Village"]
    db.commit()

    filled = _fill_entity_gaps(db, doc.id)

    assert filled == 0


def test_deduplicates_same_name_across_candidates(db, doc, section, run):
    _make_entity_candidate(db, run, section, {"name": "The River"})
    _make_entity_candidate(db, run, section, {"name": "The River"})

    filled = _fill_entity_gaps(db, doc.id)
    db.flush()

    assert filled == 1
    count = db.query(MapEntity).filter(
        MapEntity.provenance_document_id == doc.id,
        MapEntity.name == "The River",
    ).count()
    assert count == 1


def test_sets_provenance_section_id_on_created_entity(db, doc, section, run):
    _make_entity_candidate(db, run, section, {"name": "The River", "type": "waterway"})

    _fill_entity_gaps(db, doc.id)
    db.flush()

    entity = db.query(MapEntity).filter(
        MapEntity.name == "The River",
        MapEntity.provenance_document_id == doc.id,
    ).one()
    assert entity.provenance_section_id == section.id
