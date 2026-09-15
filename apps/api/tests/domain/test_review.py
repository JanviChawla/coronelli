"""
Task 9: Review and canonicalization tests.

Invariants:
- Approving an entity candidate creates a MapEntity; review_state becomes "approved".
- Approving a claim/visual_claim candidate creates a MapClaim with the correct type.
- Approving a travel_rule candidate creates a MapTravelRule.
- Rejection creates no canonical record; candidate remains queryable.
- Defer creates no canonical record; review_state becomes "deferred".
- Merge records the target candidate ID on the ReviewEvent.
- Approve with an edited payload uses the edited payload and stores before/after on the event.
- Canonical records carry provenance (document_id + section_id) derived from the candidate.
- A ReviewEvent is created for every action.
- Invalid actions and missing candidates raise ReviewError.
"""
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import SourceDocument, SourceSection
from app.domain.review import ReviewError, review_candidate
from app.domain.world import MapClaim, MapEntity, MapTravelRule
from app.extraction.models import Candidate, ExtractionRun


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
        text="The village of Casterbridge lay amid the cornfields.",
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


def _candidate(db, run, section, kind, payload, status="explicit"):
    c = Candidate(
        extraction_run_id=run.id,
        section_id=section.id,
        kind=kind,
        payload=payload,
        status=status,
        confidence=0.9,
        excerpt="Test excerpt.",
        rationale="Test rationale.",
        review_state="proposed",
        ordinal=0,
    )
    db.add(c)
    db.commit()
    return c


@pytest.fixture
def entity_candidate(db, run, section):
    return _candidate(db, run, section, "entity", {"name": "Casterbridge", "type": "settlement"})


@pytest.fixture
def claim_candidate(db, run, section):
    return _candidate(db, run, section, "claim",
                      {"subject": "Casterbridge", "predicate": "NORTH_OF", "object": "Forest"},
                      status="inferred")


@pytest.fixture
def visual_candidate(db, run, section):
    return _candidate(db, run, section, "visual_claim",
                      {"subject": "The Forest", "category": "color", "observation": "dark green"})


@pytest.fixture
def travel_candidate(db, run, section):
    return _candidate(db, run, section, "travel_rule",
                      {"traveler": "ships", "can_traverse": True, "route": "The Channel", "condition": None})


# ── Entity approval ───────────────────────────────────────────────────────────

def test_approve_entity_creates_map_entity(db, entity_candidate, doc, section):
    result = review_candidate(db, entity_candidate.id, "approve")
    assert result.canonical_entity is not None
    assert result.canonical_entity.name == "Casterbridge"
    assert result.canonical_entity.place_kind == "settlement"
    assert result.canonical_entity.state == "active"
    assert result.canonical_entity.status == "explicit"
    assert result.canonical_entity.provenance_section_id == section.id
    assert result.canonical_entity.provenance_document_id == doc.id
    assert result.canonical_entity.candidate_id == entity_candidate.id


def test_approve_entity_updates_candidate_review_state(db, entity_candidate):
    review_candidate(db, entity_candidate.id, "approve")
    db.refresh(entity_candidate)
    assert entity_candidate.review_state == "approved"


def test_approve_entity_creates_review_event(db, entity_candidate):
    result = review_candidate(db, entity_candidate.id, "approve")
    assert result.event is not None
    assert result.event.candidate_id == entity_candidate.id
    assert result.event.action == "approve"
    assert result.event.canonical_entity_id == result.canonical_entity.id


def test_approve_entity_result_returns_no_claim_or_rule(db, entity_candidate):
    result = review_candidate(db, entity_candidate.id, "approve")
    assert result.canonical_claim is None
    assert result.canonical_travel_rule is None


# ── Claim approval ────────────────────────────────────────────────────────────

def test_approve_claim_creates_map_claim(db, claim_candidate, section):
    result = review_candidate(db, claim_candidate.id, "approve")
    assert result.canonical_claim is not None
    assert result.canonical_claim.claim_type == "spatial"
    assert result.canonical_claim.predicate == "NORTH_OF"
    assert result.canonical_claim.state == "active"
    assert result.canonical_claim.status == "inferred"
    assert result.canonical_claim.provenance_section_id == section.id
    assert result.canonical_claim.candidate_id == claim_candidate.id


def test_approve_visual_claim_creates_map_claim_with_visual_type(db, visual_candidate):
    result = review_candidate(db, visual_candidate.id, "approve")
    assert result.canonical_claim is not None
    assert result.canonical_claim.claim_type == "visual"


def test_approve_claim_creates_review_event_with_claim_id(db, claim_candidate):
    result = review_candidate(db, claim_candidate.id, "approve")
    assert result.event.canonical_claim_id == result.canonical_claim.id
    assert result.event.canonical_entity_id is None


# ── Travel rule approval ──────────────────────────────────────────────────────

def test_approve_travel_rule_creates_map_travel_rule(db, travel_candidate):
    result = review_candidate(db, travel_candidate.id, "approve")
    assert result.canonical_travel_rule is not None
    assert result.canonical_travel_rule.state == "active"
    assert result.canonical_travel_rule.candidate_id == travel_candidate.id


def test_approve_travel_rule_creates_review_event_with_rule_id(db, travel_candidate):
    result = review_candidate(db, travel_candidate.id, "approve")
    assert result.event.canonical_travel_rule_id == result.canonical_travel_rule.id


# ── Reject ────────────────────────────────────────────────────────────────────

def test_reject_creates_no_canonical_record(db, entity_candidate):
    result = review_candidate(db, entity_candidate.id, "reject")
    assert result.canonical_entity is None
    assert result.canonical_claim is None
    assert result.canonical_travel_rule is None


def test_reject_updates_candidate_review_state(db, entity_candidate):
    review_candidate(db, entity_candidate.id, "reject")
    db.refresh(entity_candidate)
    assert entity_candidate.review_state == "rejected"


def test_rejected_candidate_remains_queryable(db, entity_candidate):
    review_candidate(db, entity_candidate.id, "reject")
    still_there = db.get(Candidate, entity_candidate.id)
    assert still_there is not None
    assert still_there.review_state == "rejected"


def test_reject_creates_review_event(db, entity_candidate):
    result = review_candidate(db, entity_candidate.id, "reject")
    assert result.event.action == "reject"
    assert result.event.candidate_id == entity_candidate.id


# ── Defer ─────────────────────────────────────────────────────────────────────

def test_defer_sets_deferred_state(db, entity_candidate):
    review_candidate(db, entity_candidate.id, "defer")
    db.refresh(entity_candidate)
    assert entity_candidate.review_state == "deferred"


def test_defer_creates_no_canonical_record(db, entity_candidate):
    result = review_candidate(db, entity_candidate.id, "defer")
    assert result.canonical_entity is None


def test_defer_creates_review_event(db, entity_candidate):
    result = review_candidate(db, entity_candidate.id, "defer")
    assert result.event.action == "defer"


# ── Merge ─────────────────────────────────────────────────────────────────────

def test_merge_records_target_id_on_event(db, entity_candidate, claim_candidate):
    result = review_candidate(db, entity_candidate.id, "merge",
                              merge_target_id=claim_candidate.id)
    assert result.event.action == "merge"
    assert result.event.merge_target_id == claim_candidate.id


def test_merge_sets_merged_state(db, entity_candidate, claim_candidate):
    review_candidate(db, entity_candidate.id, "merge", merge_target_id=claim_candidate.id)
    db.refresh(entity_candidate)
    assert entity_candidate.review_state == "merged"


def test_merge_without_target_raises(db, entity_candidate):
    with pytest.raises(ReviewError, match="merge_target_id"):
        review_candidate(db, entity_candidate.id, "merge")


# ── Edited payload ────────────────────────────────────────────────────────────

def test_approve_with_edited_payload_uses_edited_payload(db, entity_candidate):
    edited = {"name": "Casterton", "type": "city"}
    result = review_candidate(db, entity_candidate.id, "approve", edited_payload=edited)
    assert result.canonical_entity.name == "Casterton"
    assert result.canonical_entity.place_kind == "city"


def test_approve_with_edited_payload_stores_before_after(db, entity_candidate):
    original = dict(entity_candidate.payload)
    edited = {"name": "Casterton", "type": "city"}
    result = review_candidate(db, entity_candidate.id, "approve", edited_payload=edited)
    assert result.event.before_payload == original
    assert result.event.after_payload == edited


def test_approve_without_edit_has_no_before_after(db, entity_candidate):
    result = review_candidate(db, entity_candidate.id, "approve")
    assert result.event.before_payload is None
    assert result.event.after_payload is None


# ── Error cases ───────────────────────────────────────────────────────────────

def test_invalid_action_raises_review_error(db, entity_candidate):
    with pytest.raises(ReviewError, match="action"):
        review_candidate(db, entity_candidate.id, "invent")


def test_candidate_not_found_raises_review_error(db):
    with pytest.raises(ReviewError, match="not found"):
        review_candidate(db, "no-such-id", "approve")
