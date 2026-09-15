"""
Alice in Wonderland regression suite for the spatial extraction pipeline.

These tests are deterministic: they mock the provider response and verify that
the parsing, validation, and persistence layers correctly accept the shaped
output — i.e. nothing is silently dropped between the model and the DB.

They are NOT live API tests. They do not call OpenAI.

Oracle source: .planning/alice-atlas-extraction-oracle.md
Prompt spec:   .planning/coronelli-spatial-extraction-prompt-v1.md
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
from app.extraction.prompts import PROMPT_VERSION
from app.extraction.provider import ExtractionResult, RawCandidate
from app.extraction.service import run_extraction


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
        title="Alice's Adventures in Wonderland",
        original_filename="alice.txt",
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


def _rc(kind: str, payload: dict, status: str = "explicit", confidence: float = 0.9,
        excerpt: str = "quote", rationale: str = "reason",
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


# ── Chapter I: rich opening ───────────────────────────────────────────────────

CH1_CANDIDATES = [
    # scene anchor
    _rc("scene_anchor", {"place": "Riverbank", "scene_role": "opening"}),
    # place entities
    _rc("entity", {"name": "Riverbank", "type": "exterior"}, excerpt="sitting on the bank"),
    _rc("entity", {"name": "Rabbit Hole", "type": "portal"}, excerpt="popped down a large rabbit-hole"),
    _rc("entity", {"name": "Rabbit-Hole Tunnel", "type": "tunnel"}, excerpt="tunnel for some way"),
    _rc("entity", {"name": "Deep Well / Fall Shaft", "type": "shaft"}, excerpt="fell down a very deep well"),
    _rc("entity", {"name": "Landing", "type": "exterior"}, status="inferred", confidence=0.7,
        excerpt="upon a heap of sticks"),
    _rc("entity", {"name": "Long Low Hall", "type": "hall"}, excerpt="long, low hall"),
    _rc("entity", {"name": "Little Door", "type": "door"}, excerpt="little door about fifteen inches high"),
    _rc("entity", {"name": "Small Passage", "type": "passage"}, excerpt="small passage"),
    _rc("entity", {"name": "Garden", "type": "site"}, temporal="discovery",
        excerpt="most beautiful garden you ever saw"),
    # topology claims
    _rc("claim", {"subject": "Rabbit Hole", "predicate": "UNDER", "object": "Hedge"},
        excerpt="rabbit-hole went straight on like a tunnel"),
    _rc("claim", {"subject": "Long Low Hall", "predicate": "CONTAINS", "object": "Little Door"},
        excerpt="little door about fifteen inches high"),
    _rc("claim", {"subject": "Little Door", "predicate": "LEADS_TO", "object": "Small Passage"},
        excerpt="leading to a small passage"),
    _rc("claim", {"subject": "Small Passage", "predicate": "OPENS_TOWARD", "object": "Garden"},
        excerpt="could see a little way"),
    _rc("claim", {"subject": "Little Door", "predicate": "BLOCKS_ACCESS_TO", "object": "Garden"},
        status="inferred", confidence=0.85,
        excerpt="was too large to get through the doorway"),
    # travel rule
    _rc("travel_rule",
        {"traveler": "Alice", "can_traverse": True,
         "route": "Riverbank -> Rabbit Hole -> Rabbit-Hole Tunnel -> Fall Shaft -> Landing -> Long Low Hall",
         "condition": None},
        excerpt="down the rabbit-hole"),
    # visual claims
    _rc("visual_claim", {"subject": "Fall Shaft", "visual_property": "contents", "value": "shelves and cupboards, maps and pictures"},
        excerpt="cupboards and book-shelves"),
    _rc("visual_claim", {"subject": "Long Low Hall", "visual_property": "lighting", "value": "row of lamps hanging from the roof"},
        excerpt="row of lamps hanging from the roof"),
    _rc("visual_claim", {"subject": "Garden", "visual_property": "appearance", "value": "bright flower-beds and cool fountains"},
        excerpt="bright flower-beds and cool fountains"),
]


def test_ch1_scene_anchor_present(db):
    section = _make_section(db, "I — Down the Rabbit-Hole", ordinal=1)
    _, candidates, _ = run_extraction(db, section.id, _provider(CH1_CANDIDATES))
    kinds = [c.kind for c in candidates]
    assert "scene_anchor" in kinds


def test_ch1_required_entities_present(db):
    section = _make_section(db, "I — Down the Rabbit-Hole", ordinal=1)
    _, candidates, _ = run_extraction(db, section.id, _provider(CH1_CANDIDATES))
    names = {c.payload.get("name") for c in candidates if c.kind == "entity"}
    assert "Rabbit Hole" in names
    assert "Long Low Hall" in names
    assert "Garden" in names


def test_ch1_at_least_one_transition_claim(db):
    section = _make_section(db, "I — Down the Rabbit-Hole", ordinal=1)
    _, candidates, _ = run_extraction(db, section.id, _provider(CH1_CANDIDATES))
    transition_predicates = {"LEADS_TO", "OPENS_TOWARD", "CONTAINS", "BLOCKS_ACCESS_TO"}
    claim_predicates = {c.payload.get("predicate") for c in candidates if c.kind == "claim"}
    assert claim_predicates & transition_predicates, f"No transition claim found; got: {claim_predicates}"


def test_ch1_scene_role_stored_in_payload(db):
    section = _make_section(db, "I — Down the Rabbit-Hole", ordinal=1)
    _, candidates, _ = run_extraction(db, section.id, _provider(CH1_CANDIDATES))
    anchors = [c for c in candidates if c.kind == "scene_anchor"]
    assert anchors
    assert anchors[0].payload.get("scene_role") == "opening"


def test_ch1_full_candidate_count_survives_pipeline(db):
    section = _make_section(db, "I — Down the Rabbit-Hole", ordinal=1)
    _, candidates, _ = run_extraction(db, section.id, _provider(CH1_CANDIDATES))
    assert len(candidates) == len(CH1_CANDIDATES), (
        f"Expected {len(CH1_CANDIDATES)} candidates but got {len(candidates)} — "
        "some were silently dropped"
    )


# ── Chapter II: Pool of Tears ─────────────────────────────────────────────────

def test_ch2_pool_located_in_long_low_hall(db):
    section = _make_section(db, "II — The Pool of Tears", ordinal=2)
    candidates_in = [
        _rc("scene_anchor", {"place": "Long Low Hall", "scene_role": "primary"}),
        _rc("entity", {"name": "Pool of Tears", "type": "body_of_water"},
            excerpt="pool of salt water"),
        _rc("claim", {"subject": "Pool of Tears", "predicate": "LOCATED_IN", "object": "Long Low Hall"},
            excerpt="reached half down the hall"),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))
    claims = [c for c in candidates if c.kind == "claim"]
    pool_in_hall = [
        c for c in claims
        if c.payload.get("subject") == "Pool of Tears"
        and c.payload.get("predicate") == "LOCATED_IN"
        and c.payload.get("object") == "Long Low Hall"
    ]
    assert pool_in_hall, "Pool of Tears LOCATED_IN Long Low Hall claim not found"


# ── Chapter III: no durable new place ────────────────────────────────────────

def test_ch3_scene_anchor_with_no_new_entity(db):
    """A chapter that revisits a known location must still yield a scene anchor."""
    section = _make_section(db, "III — A Caucus-Race and a Long Tale", ordinal=3)
    candidates_in = [
        _rc("scene_anchor", {"place": "Pool Shore / Bank", "scene_role": "primary"},
            excerpt="bank, with bright eyes"),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))
    assert len(candidates) == 1
    assert candidates[0].kind == "scene_anchor"
    assert "Pool Shore" in candidates[0].payload.get("place", "")


def test_ch3_no_new_entity_is_not_zero_candidates(db):
    """Regression: 'no new durable place' must not collapse to zero candidates."""
    section = _make_section(db, "III — A Caucus-Race and a Long Tale", ordinal=3)
    candidates_in = [
        _rc("scene_anchor", {"place": "Pool Shore / Bank", "scene_role": "primary"}),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))
    assert len(candidates) > 0


# ── Chapter IV: White Rabbit's House ─────────────────────────────────────────

def test_ch4_white_rabbits_house_contains_upstairs_room(db):
    section = _make_section(db, "IV — The Rabbit Sends in a Little Bill", ordinal=4)
    candidates_in = [
        _rc("scene_anchor", {"place": "White Rabbit's House", "scene_role": "primary"}),
        _rc("entity", {"name": "White Rabbit's House", "type": "building"}),
        _rc("entity", {"name": "Upstairs Room", "type": "room"}),
        _rc("entity", {"name": "Thick Wood", "type": "region"}),
        _rc("claim", {"subject": "White Rabbit's House", "predicate": "CONTAINS", "object": "Upstairs Room"},
            excerpt="little room"),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))
    entity_names = {c.payload.get("name") for c in candidates if c.kind == "entity"}
    assert "White Rabbit's House" in entity_names
    assert "Upstairs Room" in entity_names
    assert "Thick Wood" in entity_names
    containment = [
        c for c in candidates if c.kind == "claim"
        and c.payload.get("subject") == "White Rabbit's House"
        and c.payload.get("predicate") == "CONTAINS"
        and c.payload.get("object") == "Upstairs Room"
    ]
    assert containment, "White Rabbit's House CONTAINS Upstairs Room claim missing"


# ── Chapter VI: no compass directions ────────────────────────────────────────

# Full compass direction words that must not appear as whole words in entity names or claim predicates.
# Abbreviations like "NE"/"SW" are excluded from name checks to avoid matching common substrings
# like "house" (HOUSE contains 'SE' as a substring).
_COMPASS_PREDICATES = {
    "NORTH", "SOUTH", "EAST", "WEST",
    "NORTH_OF", "SOUTH_OF", "EAST_OF", "WEST_OF",
    "NORTHEAST", "NORTHWEST", "SOUTHEAST", "SOUTHWEST",
    "NE", "NW", "SE", "SW",
}
_COMPASS_WORDS_IN_NAMES = {"NORTH", "SOUTH", "EAST", "WEST", "NORTHEAST", "NORTHWEST", "SOUTHEAST", "SOUTHWEST"}


def test_ch6_no_compass_predicates(db):
    """Cat's two paw gestures must not become compass-bearing claims."""
    import re
    section = _make_section(db, "VI — Pig and Pepper", ordinal=6)
    candidates_in = [
        _rc("scene_anchor", {"place": "Duchess's House", "scene_role": "opening"}),
        _rc("entity", {"name": "Duchess's House", "type": "building"}),
        _rc("entity", {"name": "Cheshire Cat Tree", "type": "landmark"}),
        _rc("entity", {"name": "March Hare's House", "type": "building"}, status="inferred",
            confidence=0.6, excerpt="March Hare's house"),
        _rc("entity", {"name": "Hatter's Residence", "type": "building"}, status="inferred",
            confidence=0.5, excerpt="Mad Hatter"),
        # Correct: unknown relative direction, not a compass bearing claim
        _rc("claim", {"subject": "Cheshire Cat Tree", "predicate": "NEAR", "object": "Duchess's House"},
            status="inferred", confidence=0.6),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))
    for c in candidates:
        if c.kind == "claim":
            predicate = (c.payload.get("predicate") or "").upper()
            assert predicate not in _COMPASS_PREDICATES, (
                f"Compass predicate '{predicate}' found in Ch.VI claim — must remain unresolved"
            )
        if c.kind == "entity":
            # Check whole words only to avoid false positives like "house" containing "SE"
            name = (c.payload.get("name") or "")
            name_words = set(re.findall(r"[A-Z]+", name.upper()))
            bad = name_words & _COMPASS_WORDS_IN_NAMES
            assert not bad, (
                f"Compass word(s) {bad} found as whole word in entity name '{name}'"
            )


# ── Chapter VII: non-Euclidean tree-door transition ──────────────────────────

def test_ch7_tree_door_leads_to_long_low_hall(db):
    section = _make_section(db, "VII — A Mad Tea-Party", ordinal=7)
    candidates_in = [
        _rc("scene_anchor", {"place": "Tea Table", "scene_role": "opening"}),
        _rc("entity", {"name": "Tree Door", "type": "portal"}, excerpt="door in the tree"),
        _rc("claim", {"subject": "Tree Door", "predicate": "LEADS_TO", "object": "Long Low Hall"},
            excerpt="found herself back in the long hall"),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))
    tree_door_claims = [
        c for c in candidates if c.kind == "claim"
        and c.payload.get("subject") == "Tree Door"
        and c.payload.get("predicate") == "LEADS_TO"
        and c.payload.get("object") == "Long Low Hall"
    ]
    assert tree_door_claims, "Tree Door LEADS_TO Long Low Hall claim not found"


def test_ch7_garden_discovery_update_preserved(db):
    """Garden advances from visible (Ch.I) to entered (Ch.VII); the update must survive."""
    section = _make_section(db, "VII — A Mad Tea-Party", ordinal=7)
    candidates_in = [
        _rc("scene_anchor", {"place": "Garden", "scene_role": "ending"}),
        _rc("entity", {"name": "Garden", "type": "site"}, temporal="world_state_change",
            status="inferred", confidence=0.8,
            excerpt="at last she came upon it"),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))
    garden_entity = [c for c in candidates if c.kind == "entity" and c.payload.get("name") == "Garden"]
    assert garden_entity
    assert garden_entity[0].temporal_interpretation == "world_state_change"


# ── Chapter IX: Trial Court, unknown geography ───────────────────────────────

def test_ch9_trial_court_entity_present(db):
    section = _make_section(db, "IX — Who Stole the Tarts?", ordinal=9)
    candidates_in = [
        _rc("scene_anchor", {"place": "Trial Court", "scene_role": "primary"}),
        _rc("entity", {"name": "Trial Court", "type": "court"}, excerpt="court of justice"),
        _rc("entity", {"name": "Jury Box", "type": "room"}, excerpt="jury-box"),
        _rc("claim", {"subject": "Trial Court", "predicate": "CONTAINS", "object": "Jury Box"},
            status="inferred", confidence=0.8),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))
    names = {c.payload.get("name") for c in candidates if c.kind == "entity"}
    assert "Trial Court" in names


def test_ch9_court_geography_unresolved(db):
    """No claim should place Trial Court inside a palace, garden, or specific enclosure."""
    section = _make_section(db, "IX — Who Stole the Tarts?", ordinal=9)
    candidates_in = [
        _rc("scene_anchor", {"place": "Trial Court", "scene_role": "primary"}),
        _rc("entity", {"name": "Trial Court", "type": "court"}),
        # Only the arrival route claim is acceptable — not LOCATED_IN Garden/Palace
        _rc("claim", {"subject": "Trial Court", "predicate": "REACHED_FROM", "object": "Queen's Croquet Ground"},
            status="explicit", confidence=0.85,
            excerpt="came upon the trial"),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))
    forbidden_containers = {"Garden", "Palace", "Queen's Palace", "Wonderland Palace"}
    bad_claims = [
        c for c in candidates if c.kind == "claim"
        and c.payload.get("subject") == "Trial Court"
        and c.payload.get("predicate") == "LOCATED_IN"
        and c.payload.get("object") in forbidden_containers
    ]
    assert not bad_claims, f"Unresolved geography invented: {bad_claims}"


# ── Pipeline integrity: relation guard ───────────────────────────────────────

def test_one_sided_relation_skipped_not_fatal(db):
    """A candidate with relation_kind but no relation_target_id must be skipped,
    not raise an error that kills the whole section."""
    section = _make_section(db, "Any Chapter", ordinal=1)
    candidates_in = [
        _rc("scene_anchor", {"place": "Some Place", "scene_role": "primary"}),
        # Bad candidate: relation_kind without relation_target_id
        RawCandidate(
            kind="entity",
            payload={"name": "Place X", "type": "hall"},
            status="explicit",
            confidence=0.8,
            excerpt="quote",
            rationale="reason",
            temporal_interpretation="static",
            relation_kind="supersedes",
            relation_target_id=None,  # missing — should be skipped, not fatal
        ),
        _rc("entity", {"name": "Place Y", "type": "room"}),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))
    # The bad candidate is gone but the rest survive
    names = {c.payload.get("name") for c in candidates if c.kind == "entity"}
    assert "Place X" not in names, "Malformed relation candidate should have been skipped"
    assert "Place Y" in names, "Valid candidate after bad one should survive"


def test_null_traveler_accepted(db):
    """travel_rule.traveler may be null per the v1 prompt spec."""
    section = _make_section(db, "Any Chapter", ordinal=1)
    candidates_in = [
        _rc("scene_anchor", {"place": "Hall", "scene_role": "primary"}),
        _rc("travel_rule",
            {"traveler": None, "can_traverse": True, "route": "Hall -> Door -> Garden", "condition": None},
            excerpt="passage led to the garden"),
    ]
    _, candidates, _ = run_extraction(db, section.id, _provider(candidates_in))
    travel = [c for c in candidates if c.kind == "travel_rule"]
    assert travel, "travel_rule with null traveler must be accepted"
    assert travel[0].payload.get("traveler") is None
