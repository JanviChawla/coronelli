"""
Task 7: Extraction service tests using a FakeProvider.

Invariants under test:
- run_extraction stores an immutable ExtractionRun and two proposed Candidates.
- No canonical entity/claim records are created.
- A failed provider response persists a failed run with zero candidates.
- Candidates are linked to the run and section by ID.
- Re-running a section creates a new distinct run (old run still readable).
"""
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import SourceDocument, SourceSection
from app.extraction.models import Candidate, ExtractionRun
from app.extraction.provider import ExtractionProvider, ExtractionResult, RawCandidate
from app.extraction.service import ExtractionError, run_extraction


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
def section(db):
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
    sec = SourceSection(
        id=str(uuid.uuid4()),
        document_id=doc.id,
        ordinal=0,
        title="Chapter I",
        text="The village of Casterbridge lay amid the cornfields.",
    )
    db.add(sec)
    db.commit()
    return sec


class FakeProvider:
    """Returns two fixed proposed candidates."""

    def extract(self, section: SourceSection, known_entities: list[dict]) -> ExtractionResult:
        return ExtractionResult(
            candidates=[
                RawCandidate(
                    kind="entity",
                    payload={"name": "Casterbridge", "type": "settlement"},
                    status="explicit",
                    confidence=0.95,
                    excerpt="The village of Casterbridge",
                    rationale="Named settlement mentioned directly.",
                ),
                RawCandidate(
                    kind="claim",
                    payload={"subject": "Casterbridge", "predicate": "located_amid", "object": "cornfields"},
                    status="inferred",
                    confidence=0.7,
                    excerpt="lay amid the cornfields",
                    rationale="Spatial relationship inferred from prose.",
                ),
            ],
            raw_response={"model": "fake", "tokens": 42},
            provider="fake",
            model="fake-v1",
            prompt_version="0.1",
        )


class FailingProvider:
    """Simulates a provider that raises an error."""

    def extract(self, section: SourceSection, known_entities: list[dict]) -> ExtractionResult:
        raise RuntimeError("Provider unavailable.")


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_run_stores_extraction_run(db, section):
    run, candidates, _ = run_extraction(db, section.id, FakeProvider())
    assert run.id is not None
    assert run.section_id == section.id
    assert run.status == "completed"
    assert run.provider == "fake"
    assert run.model == "fake-v1"
    assert run.prompt_version == "0.1"
    assert run.error is None


def test_run_stores_two_candidates(db, section):
    run, candidates, _ = run_extraction(db, section.id, FakeProvider())
    assert len(candidates) == 2
    assert all(c.extraction_run_id == run.id for c in candidates)
    assert all(c.section_id == section.id for c in candidates)
    assert all(c.review_state == "proposed" for c in candidates)


def test_candidates_have_expected_fields(db, section):
    _, candidates, _ = run_extraction(db, section.id, FakeProvider())
    entity = next(c for c in candidates if c.kind == "entity")
    claim = next(c for c in candidates if c.kind == "claim")

    assert entity.payload == {"name": "Casterbridge", "type": "settlement"}
    assert entity.status == "explicit"
    assert entity.confidence == pytest.approx(0.95)
    assert "Casterbridge" in entity.excerpt

    assert claim.status == "inferred"
    assert claim.confidence == pytest.approx(0.7)


def test_failed_provider_persists_failed_run(db, section):
    with pytest.raises(ExtractionError):
        run_extraction(db, section.id, FailingProvider())

    runs = db.query(ExtractionRun).all()
    assert len(runs) == 1
    assert runs[0].status == "failed"
    assert "Provider unavailable" in runs[0].error
    assert db.query(Candidate).count() == 0


def test_force_creates_new_run(db, section):
    """force=True always calls the provider and creates a new run."""
    run1, _, _ = run_extraction(db, section.id, FakeProvider())
    run2, _, _ = run_extraction(db, section.id, FakeProvider(), force=True)
    assert run1.id != run2.id
    assert db.query(ExtractionRun).count() == 2


def test_unknown_section_raises(db):
    with pytest.raises(ExtractionError, match="not found"):
        run_extraction(db, "no-such-id", FakeProvider())


def test_raw_response_stored_on_run(db, section):
    run, _, _ = run_extraction(db, section.id, FakeProvider())
    assert run.raw_response == {"model": "fake", "tokens": 42}
