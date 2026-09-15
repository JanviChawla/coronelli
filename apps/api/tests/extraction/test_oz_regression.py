"""
Wizard of Oz regression fixture for the spatial extraction pipeline.

Deterministic pipeline assertions — no live LLM calls.

Oracle goals tested here:
  - No blank or malformed display summaries.
  - Malformed payloads (missing required field) are rejected, not persisted.
  - China Wall / hedge / gate typed as 'barrier', not 'settlement'.
  - Emerald City does not produce a duplicate MapEntity per chapter.
  - Every candidate has a source excerpt and section ID.
  - Repeated-entity provenance accumulates rather than overwrites.

Provider-quality assertions (model output vs oracle) are evaluated separately
via recorded runs and are not part of this deterministic suite.
"""
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import SourceDocument, SourceSection
from app.extraction.display import candidate_display_summary
from app.extraction.models import Candidate
from app.extraction.prompts import PROMPT_VERSION
from app.extraction.provider import ExtractionResult, RawCandidate
from app.extraction.service import run_extraction
from app.extraction.validation import validate_candidate_payload
from app.domain.review import review_candidate
from app.domain.world import MapEntity


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture()
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


def _make_section(db: Session, title: str, ordinal: int = 1, text: str = "placeholder") -> SourceSection:
    doc = SourceDocument(
        id=str(uuid.uuid4()),
        title="The Wonderful Wizard of Oz",
        original_filename="wizard_of_oz.txt",
        mime_type="text/plain",
        content_hash=str(uuid.uuid4()),
        imported_at=datetime.now(timezone.utc),
        parser_version="1.0",
        category="demo",
    )
    db.add(doc)
    section = SourceSection(
        id=str(uuid.uuid4()),
        document_id=doc.id,
        ordinal=ordinal,
        title=title,
        text=text,
    )
    db.add(section)
    db.commit()
    return section


def _provider(candidates: list[RawCandidate]):
    class _MockProvider:
        def extract(self, section, known_entities):
            return ExtractionResult(
                candidates=candidates,
                raw_response={"candidates": []},
                provider="openai",
                model="gpt-4o-mini",
                prompt_version=PROMPT_VERSION,
            )
    return _MockProvider()


def _rc(kind: str, payload: dict, status: str = "explicit", confidence: float = 0.85,
        excerpt: str = "source quote", rationale: str = "reason",
        temporal: str = "static", **kwargs) -> RawCandidate:
    return RawCandidate(
        kind=kind,
        payload=payload,
        status=status,
        confidence=confidence,
        excerpt=excerpt,
        rationale=rationale,
        temporal_interpretation=temporal,
        **kwargs,
    )


# ── Display summary: no blank rows ────────────────────────────────────────────

def test_no_blank_display_summary_entity():
    result = candidate_display_summary("entity", {"name": "Emerald City", "type": "settlement"})
    assert result and result.strip()


def test_no_blank_display_summary_claim():
    p = {"subject": "Palace of Oz", "predicate": "CONTAINS", "object": "Throne Room"}
    result = candidate_display_summary("claim", p)
    assert result and result.strip()


def test_no_blank_display_summary_visual():
    p = {"subject": "Emerald City", "visual_property": "appearance", "value": "everything green"}
    result = candidate_display_summary("visual_claim", p)
    assert result and result.strip()
    assert ":=" not in result
    assert "= " not in result or "value" not in result   # no `:=` pattern


def test_no_malformed_visual_claim_display():
    """Regression: visual_claim with all fields must never render as ':='."""
    p = {"subject": "Croquet Ground", "visual_property": "terrain", "value": "ridges and furrows"}
    result = candidate_display_summary("visual_claim", p)
    assert result == "Croquet Ground · terrain: ridges and furrows"
    assert ":=" not in result


def test_visual_claim_missing_value_produces_partial_not_empty():
    """Missing value renders something useful — not ':='."""
    p = {"subject": "Emerald City", "visual_property": "appearance"}
    result = candidate_display_summary("visual_claim", p)
    assert result
    assert ":=" not in result
    assert "Emerald City" in result


def test_claim_missing_predicate_produces_partial_not_empty():
    """Claim with missing predicate renders subject+object — not '→ → '."""
    p = {"subject": "Palace", "object": "Throne Room"}
    result = candidate_display_summary("claim", p)
    assert result
    assert "Palace" in result
    assert "→ → " not in result
    assert "  " not in result  # no double spaces from empty predicate


# ── Payload validation: reject malformed candidates before persistence ─────────

def test_visual_claim_missing_observation_fails_validation():
    with pytest.raises(ValueError, match="observation|category"):
        validate_candidate_payload("visual_claim", {"subject": "Emerald City", "category": "atmosphere"})


def test_malformed_visual_claim_skipped_not_persisted(db):
    """A visual_claim with missing 'value' is logged and skipped — not a blank DB row."""
    section = _make_section(db, "XIV — The Winged Monkeys", ordinal=14)
    bad_visual = RawCandidate(
        kind="visual_claim",
        payload={"subject": "Emerald City", "category": "atmosphere"},  # missing 'observation'
        status="explicit",
        confidence=0.85,
        excerpt="everything green",
        rationale="visual detail",
        temporal_interpretation="static",
    )
    good_anchor = _rc("scene_anchor", {"place": "Emerald City", "scene_role": "primary"})

    _, candidates, _ = run_extraction(db, section.id, _provider([bad_visual, good_anchor]))

    kinds = [c.kind for c in candidates]
    assert "scene_anchor" in kinds
    assert "visual_claim" not in kinds, "Malformed visual_claim must be skipped, not persisted"


def test_malformed_claim_skipped_not_persisted(db):
    """A claim with missing predicate is logged and skipped — not a blank DB row."""
    section = _make_section(db, "XV — The Discovery of Oz", ordinal=15)
    bad_claim = RawCandidate(
        kind="claim",
        payload={"subject": "Palace of Oz", "object": "Throne Room"},  # missing predicate
        status="explicit",
        confidence=0.85,
        excerpt="inside the palace",
        rationale="containment",
        temporal_interpretation="static",
    )
    good_entity = _rc("entity", {"name": "Throne Room", "type": "hall"})

    _, candidates, _ = run_extraction(db, section.id, _provider([bad_claim, good_entity]))

    kinds = [c.kind for c in candidates]
    assert "entity" in kinds
    assert "claim" not in kinds, "Claim with missing predicate must be skipped, not persisted"


# ── Barrier type ──────────────────────────────────────────────────────────────

def test_barrier_type_accepted_by_validation():
    """'barrier' must be an accepted entity type (China Wall, hedges, walls)."""
    validate_candidate_payload("entity", {"name": "China Wall", "type": "barrier"})


def test_barrier_type_persisted(db):
    """An entity with type='barrier' must be persisted correctly."""
    section = _make_section(db, "XX — The Dainty China Country", ordinal=20)
    candidates_in = [
        _rc("scene_anchor", {"place": "China Country", "scene_role": "primary"}),
        _rc("entity", {"name": "China Wall", "type": "barrier"}, excerpt="a high wall"),
        _rc("entity", {"name": "China Country", "type": "region"}, excerpt="a china country"),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))
    barrier = [c for c in candidates if c.payload.get("name") == "China Wall"]
    assert barrier, "China Wall entity must be persisted"
    assert barrier[0].payload["type"] == "barrier"


# ── Repeated entity provenance (no duplicate MapEntity per chapter) ────────────

def test_no_duplicate_emerald_city_map_entity(db):
    """Approving 'Emerald City' from two separate sections must yield one MapEntity."""
    sec1 = _make_section(db, "XI — The Wonderful City of Oz", ordinal=11)
    sec2 = _make_section(db, "XIV — The Winged Monkeys", ordinal=14)

    # Both sections return an Emerald City entity candidate
    ec_candidate = [
        _rc("scene_anchor", {"place": "Emerald City", "scene_role": "primary"}),
        _rc("entity", {"name": "Emerald City", "type": "settlement"}, excerpt="great city"),
    ]

    # Run extraction for both sections against the same document (same doc_id via shared document)
    # Note: _make_section creates a new doc per call, so we need the same doc here.
    # Re-use sec1's document for sec2:
    sec2.document_id = sec1.document_id
    db.commit()

    _, cands1, _ = run_extraction(db, sec1.id, _provider(ec_candidate))
    _, cands2, _ = run_extraction(db, sec2.id, _provider(ec_candidate))

    # Approve Emerald City entity from both sections
    entity_cands1 = [c for c in cands1 if c.kind == "entity" and c.payload.get("name") == "Emerald City"]
    entity_cands2 = [c for c in cands2 if c.kind == "entity" and c.payload.get("name") == "Emerald City"]
    assert entity_cands1 and entity_cands2

    review_candidate(db, entity_cands1[0].id, "approve")
    review_candidate(db, entity_cands2[0].id, "approve")

    count = db.query(MapEntity).filter(MapEntity.name == "Emerald City").count()
    assert count == 1, f"Expected 1 MapEntity 'Emerald City', got {count} (one per chapter)"


# ── Excerpt and section_id always present ─────────────────────────────────────

def test_every_candidate_has_excerpt(db):
    """Every persisted candidate must have a non-empty excerpt."""
    section = _make_section(db, "XI — The Wonderful City of Oz", ordinal=11)
    candidates_in = [
        _rc("scene_anchor", {"place": "Emerald City", "scene_role": "opening"}, excerpt="entered the gates"),
        _rc("entity", {"name": "Palace of Oz", "type": "building"}, excerpt="before the palace"),
        _rc("claim", {"subject": "Palace of Oz", "predicate": "LOCATED_IN", "object": "Emerald City"},
            excerpt="inside the city"),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))
    for c in candidates:
        assert c.excerpt and c.excerpt.strip(), f"Candidate {c.kind} has blank excerpt"


def test_every_candidate_has_section_id(db):
    """Every persisted candidate must have the correct section_id."""
    section = _make_section(db, "XI — The Wonderful City of Oz", ordinal=11)
    candidates_in = [
        _rc("scene_anchor", {"place": "Emerald City", "scene_role": "primary"}),
        _rc("entity", {"name": "Throne Room", "type": "hall"}),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))
    for c in candidates:
        assert c.section_id == section.id, f"Candidate {c.kind} has wrong section_id"


# ── Display summary in full pipeline run ──────────────────────────────────────

def test_all_persisted_candidates_have_display_summary(db):
    """Every candidate returned by the pipeline must have a non-empty display_summary."""
    section = _make_section(db, "XI — The Wonderful City of Oz", ordinal=11)
    candidates_in = [
        _rc("scene_anchor", {"place": "Emerald City", "scene_role": "opening"}),
        _rc("entity", {"name": "Emerald City", "type": "settlement"}),
        _rc("entity", {"name": "Palace of Oz", "type": "building"}),
        _rc("claim", {"subject": "Palace of Oz", "predicate": "LOCATED_IN", "object": "Emerald City"}),
        _rc("travel_rule", {"traveler": "Dorothy", "can_traverse": True,
            "route": "Emerald City -> Palace of Oz -> Throne Room", "condition": None}),
        _rc("visual_claim", {"subject": "Emerald City", "category": "atmosphere",
            "observation": "everything green"}),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))

    assert len(candidates) == 6, f"Expected all 6 candidates, got {len(candidates)}"
    for c in candidates:
        summary = c.display_summary
        assert summary and summary.strip(), (
            f"Candidate kind={c.kind} payload={c.payload} has blank display_summary"
        )
