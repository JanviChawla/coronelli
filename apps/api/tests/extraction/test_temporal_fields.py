"""
Contract tests for temporal_interpretation, first_revealed_at_section_id,
relation_kind, and relation_target_id on Candidate.

Invariants:
- New fields are nullable; existing candidates default safely.
- temporal_interpretation defaults to "static" when absent.
- relation_kind and relation_target_id must be set together or not at all.
- Provider-emitted values round-trip through the service into the DB.
- Invalid temporal_interpretation is coerced to "static" by the provider layer.
- "imagined" is still rejected as a status regardless of other fields.
"""
import uuid
from datetime import datetime, timezone
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import SourceDocument, SourceSection
from app.extraction.models import Candidate
from app.extraction.provider import ExtractionResult, RawCandidate
from app.extraction.service import run_catalog_extraction


# ── Shared fixtures ───────────────────────────────────────────────────────────

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
def doc_and_sections(db):
    doc = SourceDocument(
        id=str(uuid.uuid4()),
        title="Test Book",
        original_filename="test.txt",
        mime_type="text/plain",
        content_hash="abc123",
        imported_at=datetime.now(timezone.utc),
        parser_version="1.0",
        category="demo",
    )
    db.add(doc)
    sec1 = SourceSection(
        id=str(uuid.uuid4()),
        document_id=doc.id,
        ordinal=0,
        title="Chapter I",
        text="The great forest lay to the north.",
    )
    sec2 = SourceSection(
        id=str(uuid.uuid4()),
        document_id=doc.id,
        ordinal=1,
        title="Chapter II",
        text="She learned that the forest had burned.",
    )
    db.add(sec1)
    db.add(sec2)
    db.commit()
    return sec1, sec2


# ── Default / backward-compat ─────────────────────────────────────────────────

def test_existing_candidates_default_to_static(db, doc_and_sections):
    sec1, _ = doc_and_sections

    class MinimalProvider:
        def extract_catalog_only(self, section, known_names=None):
            return ExtractionResult(
                candidates=[
                    RawCandidate(
                        kind="entity",
                        payload={"name": "The Forest", "type": "region"},
                        status="explicit",
                        confidence=0.9,
                        excerpt="The great forest",
                        rationale="Named region.",
                    )
                ],
                raw_response={},
                provider="minimal",
                model="m1",
                prompt_version="0.1",
            )

    _, candidates, _ = run_catalog_extraction(db, sec1.id, MinimalProvider())
    c = candidates[0]
    assert c.temporal_interpretation == "static"
    assert c.first_revealed_at_section_id is None
    assert c.relation_kind is None
    assert c.relation_target_id is None


# ── temporal_interpretation ───────────────────────────────────────────────────

def test_discovery_interpretation_stored(db, doc_and_sections):
    sec1, sec2 = doc_and_sections

    class DiscoveryProvider:
        def extract_catalog_only(self, section, known_names=None):
            return ExtractionResult(
                candidates=[
                    RawCandidate(
                        kind="entity",
                        payload={"name": "The Forest", "type": "region"},
                        status="explicit",
                        confidence=0.9,
                        excerpt="The great forest",
                        rationale="Named region.",
                        temporal_interpretation="discovery",
                        first_revealed_at_section_id=sec2.id,
                    )
                ],
                raw_response={},
                provider="fake",
                model="m1",
                prompt_version="0.2",
            )

    _, candidates, _ = run_catalog_extraction(db, sec1.id, DiscoveryProvider())
    c = candidates[0]
    assert c.temporal_interpretation == "discovery"
    assert c.first_revealed_at_section_id == sec2.id


# ── Relational fields ─────────────────────────────────────────────────────────

def test_relation_kind_without_target_skipped_not_fatal(db, doc_and_sections):
    """One-sided relation is skipped with a warning; other candidates in the batch survive."""
    sec1, _ = doc_and_sections

    class BadRelationProvider:
        def extract_catalog_only(self, section, known_names=None):
            return ExtractionResult(
                candidates=[
                    RawCandidate(
                        kind="claim",
                        payload={"subject": "X", "predicate": "NEAR", "object": "Y"},
                        status="explicit",
                        confidence=0.8,
                        excerpt="near Y",
                        rationale="Proximity.",
                        relation_kind="supersedes",
                        relation_target_id=None,  # missing — should be skipped
                    ),
                    RawCandidate(
                        kind="entity",
                        payload={"name": "Village", "type": "settlement"},
                        status="explicit",
                        confidence=0.9,
                        excerpt="the village",
                        rationale="Named place.",
                    ),
                ],
                raw_response={},
                provider="fake",
                model="m1",
                prompt_version="0.2",
            )

    _, candidates, _ = run_catalog_extraction(db, sec1.id, BadRelationProvider())
    # Malformed candidate skipped; valid one persists
    assert len(candidates) == 1
    assert candidates[0].payload["name"] == "Village"


def test_relation_target_without_kind_skipped_not_fatal(db, doc_and_sections):
    """One-sided relation_target_id is skipped with a warning; other candidates survive."""
    sec1, _ = doc_and_sections

    class BadRelationProvider:
        def extract_catalog_only(self, section, known_names=None):
            return ExtractionResult(
                candidates=[
                    RawCandidate(
                        kind="claim",
                        payload={"subject": "X", "predicate": "NEAR", "object": "Y"},
                        status="explicit",
                        confidence=0.8,
                        excerpt="near Y",
                        rationale="Proximity.",
                        relation_kind=None,
                        relation_target_id="some-id",  # set without kind — should be skipped
                    ),
                    RawCandidate(
                        kind="entity",
                        payload={"name": "Forest", "type": "region"},
                        status="explicit",
                        confidence=0.9,
                        excerpt="the forest",
                        rationale="Named place.",
                    ),
                ],
                raw_response={},
                provider="fake",
                model="m1",
                prompt_version="0.2",
            )

    _, candidates, _ = run_catalog_extraction(db, sec1.id, BadRelationProvider())
    assert len(candidates) == 1
    assert candidates[0].payload["name"] == "Forest"
