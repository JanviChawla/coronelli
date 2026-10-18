"""
Tests for run_catalog_gap_extraction, run_evidence_extraction, and run_global_enrichment.

Infrastructure mirrors test_service.py: in-memory SQLite, FakeProvider pattern.
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
from app.extraction.prompts import (
    GLOBAL_CATALOG_GAP_VERSION,
    GLOBAL_EVIDENCE_VERSION,
    GLOBAL_ENRICHMENT_VERSION,
    GLOBAL_EVIDENCE_CONTAINMENT_VERSION,
    GLOBAL_EVIDENCE_DEDUP_VERSION,
)
from app.extraction.provider import ExtractionResult, RawCandidate
from app.extraction.service import (
    ExtractionError,
    run_catalog_gap_extraction,
    run_evidence_extraction,
    run_global_enrichment,
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
def doc_and_section(db):
    doc = SourceDocument(
        id=str(uuid.uuid4()),
        title="Wonderland",
        original_filename="wonder.txt",
        mime_type="text/plain",
        content_hash="dead1234",
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
        text="Alice fell down the rabbit-hole into a long passage lined with cupboards.",
    )
    db.add(sec)
    db.commit()
    return doc, sec


def _section(doc_and_section):
    _, sec = doc_and_section
    return sec


def _entity_candidate(name="Rabbit-Hole"):
    return RawCandidate(
        kind="entity",
        payload={"name": name, "type": "tunnel"},
        status="explicit",
        confidence=0.9,
        excerpt=f"fell down the {name.lower()}",
        rationale="Named passage.",
    )


def _claim_candidate():
    return RawCandidate(
        kind="claim",
        payload={"subject": "Rabbit-Hole", "predicate": "LEADS_TO", "object": "Long Passage"},
        status="inferred",
        confidence=0.75,
        excerpt="fell down the rabbit-hole into a long passage",
        rationale="Traversal implied.",
    )


# ── FakeProviders ─────────────────────────────────────────────────────────────

class FakeGapProvider:
    def extract_catalog_gap(self, section, already_found=None) -> ExtractionResult:
        return ExtractionResult(
            candidates=[_entity_candidate("Long Passage")],
            raw_response={"model": "fake"},
            provider="fake",
            model="fake-v1",
            prompt_version="gap-0.1",
        )


class FakeEvidenceProvider:
    def extract_evidence_only(self, section, global_catalog, phase_callback=None) -> ExtractionResult:
        if phase_callback:
            phase_callback("spatial")
        return ExtractionResult(
            candidates=[_claim_candidate()],
            raw_response={"model": "fake"},
            provider="fake",
            model="fake-v1",
            prompt_version="ev-0.1",
        )


class FakeEnrichmentProvider:
    def run_global_enrichment(self, global_catalog, phase_callback=None, passes=None) -> ExtractionResult:
        return ExtractionResult(
            candidates=[
                RawCandidate(
                    kind="entity",
                    payload={"name": "Rabbit-Hole", "type": "tunnel"},
                    status="explicit",
                    confidence=0.88,
                    excerpt="fell down the rabbit-hole",
                    rationale="Containment sweep hit.",
                ),
            ],
            raw_response={"model": "fake"},
            provider="fake",
            model="fake-v1",
            prompt_version="enrich-0.1",
        )


class FailingProvider:
    def extract_catalog_gap(self, section, already_found=None):
        raise RuntimeError("gap provider failed")

    def extract_evidence_only(self, section, global_catalog, phase_callback=None):
        raise RuntimeError("evidence provider failed")

    def run_global_enrichment(self, global_catalog, phase_callback=None, passes=None):
        raise RuntimeError("enrichment provider failed")


# ── run_catalog_gap_extraction ────────────────────────────────────────────────

def test_gap_happy_path_stores_candidates(db, doc_and_section):
    _, sec = doc_and_section
    run, candidates = run_catalog_gap_extraction(db, sec.id, FakeGapProvider())
    assert run.status == "completed"
    assert run.prompt_version == GLOBAL_CATALOG_GAP_VERSION
    assert len(candidates) == 1
    assert candidates[0].payload["name"] == "Long Passage"
    assert candidates[0].section_id == sec.id


def test_gap_unknown_section_raises(db):
    with pytest.raises(ExtractionError, match="not found"):
        run_catalog_gap_extraction(db, "no-such-id", FakeGapProvider())


def test_gap_failed_provider_persists_failed_run(db, doc_and_section):
    _, sec = doc_and_section
    with pytest.raises(ExtractionError):
        run_catalog_gap_extraction(db, sec.id, FailingProvider())
    runs = db.query(ExtractionRun).all()
    assert len(runs) == 1
    assert runs[0].status == "failed"
    assert "gap provider failed" in runs[0].error
    assert db.query(Candidate).count() == 0


def test_gap_uses_already_found_entities(db, doc_and_section):
    _, sec = doc_and_section
    # Pre-seed a catalog candidate so it appears in `already_found`
    prior_run = ExtractionRun(
        section_id=sec.id,
        status="completed",
        provider="fake",
        model="fake",
        prompt_version="5.0-catalog",
        started_at=datetime.now(timezone.utc),
        completed_at=datetime.now(timezone.utc),
    )
    db.add(prior_run)
    db.flush()
    prior_cand = Candidate(
        extraction_run_id=prior_run.id,
        section_id=sec.id,
        kind="entity",
        payload={"name": "Rabbit-Hole", "type": "tunnel"},
        status="explicit",
        confidence=0.9,
        excerpt="fell down the rabbit-hole",
        rationale=".",
        review_state="proposed",
        ordinal=0,
        temporal_interpretation="static",
    )
    db.add(prior_cand)
    db.commit()

    captured = {}

    class CapturingGapProvider:
        def extract_catalog_gap(self, section, already_found=None):
            captured["already_found"] = already_found
            return ExtractionResult(
                candidates=[],
                raw_response={},
                provider="fake",
                model="fake",
                prompt_version="gap",
            )

    run_catalog_gap_extraction(db, sec.id, CapturingGapProvider())
    assert any(e["name"] == "Rabbit-Hole" for e in captured.get("already_found", []))


# ── run_evidence_extraction ───────────────────────────────────────────────────

def test_evidence_happy_path_stores_candidates(db, doc_and_section):
    _, sec = doc_and_section
    catalog = [{"name": "Rabbit-Hole", "type": "tunnel"}]
    run, candidates = run_evidence_extraction(db, sec.id, FakeEvidenceProvider(), catalog)
    assert run.status == "completed"
    assert run.prompt_version == GLOBAL_EVIDENCE_VERSION
    assert len(candidates) == 1
    assert candidates[0].kind == "claim"


def test_evidence_unknown_section_raises(db):
    with pytest.raises(ExtractionError, match="not found"):
        run_evidence_extraction(db, "no-such-id", FakeEvidenceProvider(), [])


def test_evidence_failed_provider_persists_failed_run(db, doc_and_section):
    _, sec = doc_and_section
    with pytest.raises(ExtractionError):
        run_evidence_extraction(db, sec.id, FailingProvider(), [])
    runs = db.query(ExtractionRun).all()
    assert any(r.status == "failed" for r in runs)
    assert db.query(Candidate).count() == 0


def test_evidence_pre_created_run_id_is_used(db, doc_and_section):
    _, sec = doc_and_section
    pre_run = ExtractionRun(
        section_id=sec.id,
        status="running",
        provider="",
        model="",
        prompt_version=GLOBAL_EVIDENCE_VERSION,
        started_at=datetime.now(timezone.utc),
    )
    db.add(pre_run)
    db.commit()

    _, candidates = run_evidence_extraction(
        db, sec.id, FakeEvidenceProvider(), [], pre_created_run_id=pre_run.id
    )
    db.refresh(pre_run)
    assert pre_run.status == "completed"
    assert all(c.extraction_run_id == pre_run.id for c in candidates)


def test_evidence_supersedes_previous_run(db, doc_and_section):
    _, sec = doc_and_section
    catalog = [{"name": "Rabbit-Hole", "type": "tunnel"}]
    run1, _ = run_evidence_extraction(db, sec.id, FakeEvidenceProvider(), catalog)
    run2, _ = run_evidence_extraction(db, sec.id, FakeEvidenceProvider(), catalog)
    db.refresh(run1)
    assert run1.status == "superseded"
    assert run2.status == "completed"


# ── run_global_enrichment ─────────────────────────────────────────────────────

def test_enrichment_happy_path_stores_candidates(db, doc_and_section):
    doc, _ = doc_and_section
    catalog = [{"name": "Rabbit-Hole", "type": "tunnel"}]
    run, candidates = run_global_enrichment(db, doc.id, FakeEnrichmentProvider(), catalog)
    assert run.status == "completed"
    assert run.prompt_version == GLOBAL_ENRICHMENT_VERSION
    assert len(candidates) == 1
    assert run.section_id is None  # document-scoped


def test_enrichment_unknown_document_still_runs(db, doc_and_section):
    # No section required — document-level run uses document_id only
    doc, _ = doc_and_section
    run, candidates = run_global_enrichment(db, doc.id, FakeEnrichmentProvider(), [{"name": "x", "type": "site"}])
    assert run.status == "completed"


def test_enrichment_failed_provider_persists_failed_run(db, doc_and_section):
    doc, _ = doc_and_section
    with pytest.raises(ExtractionError):
        run_global_enrichment(db, doc.id, FailingProvider(), [])
    runs = db.query(ExtractionRun).filter(ExtractionRun.document_id == doc.id).all()
    assert any(r.status == "failed" for r in runs)


def test_enrichment_containment_pass_uses_correct_version(db, doc_and_section):
    doc, _ = doc_and_section
    run, _ = run_global_enrichment(
        db, doc.id, FakeEnrichmentProvider(),
        [{"name": "Rabbit-Hole", "type": "tunnel"}],
        passes=["containment"],
    )
    assert run.prompt_version == GLOBAL_EVIDENCE_CONTAINMENT_VERSION


def test_enrichment_dedup_pass_uses_correct_version(db, doc_and_section):
    doc, _ = doc_and_section
    run, _ = run_global_enrichment(
        db, doc.id, FakeEnrichmentProvider(),
        [{"name": "Rabbit-Hole", "type": "tunnel"}],
        passes=["dedup"],
    )
    assert run.prompt_version == GLOBAL_EVIDENCE_DEDUP_VERSION


def test_enrichment_supersedes_previous_run(db, doc_and_section):
    doc, _ = doc_and_section
    catalog = [{"name": "Rabbit-Hole", "type": "tunnel"}]
    run1, _ = run_global_enrichment(db, doc.id, FakeEnrichmentProvider(), catalog)
    run2, _ = run_global_enrichment(db, doc.id, FakeEnrichmentProvider(), catalog)
    db.refresh(run1)
    assert run1.status == "superseded"
    assert run2.status == "completed"
