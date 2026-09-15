"""Unit tests for the atlas evaluation oracle module."""
import pytest
from app.evaluation.oracle import evaluate_atlas, evaluate_claims, evaluate_entities


# ── Entity recall / precision ──────────────────────────────────────────────────

def test_perfect_recall_and_precision():
    result = evaluate_entities(
        approved_names=["Emerald City", "Yellow Brick Road"],
        oracle_names=["Emerald City", "Yellow Brick Road"],
    )
    assert result.entity_recall == 1.0
    assert result.entity_precision == 1.0
    assert set(result.found_entities) == {"Emerald City", "Yellow Brick Road"}
    assert result.missed_entities == []
    assert result.extra_entities == []


def test_partial_recall():
    result = evaluate_entities(
        approved_names=["Emerald City"],
        oracle_names=["Emerald City", "Yellow Brick Road", "Kansas"],
    )
    assert result.entity_recall == pytest.approx(1 / 3, rel=1e-3)
    assert "Emerald City" in result.found_entities
    assert "Yellow Brick Road" in result.missed_entities
    assert "Kansas" in result.missed_entities


def test_extra_entities_reduce_precision():
    result = evaluate_entities(
        approved_names=["Emerald City", "Phantom Place", "Ghost Realm"],
        oracle_names=["Emerald City"],
    )
    assert result.entity_precision == pytest.approx(1 / 3, rel=1e-3)
    assert "Phantom Place" in result.extra_entities
    assert "Ghost Realm" in result.extra_entities


def test_case_insensitive_matching():
    result = evaluate_entities(
        approved_names=["emerald city", "YELLOW BRICK ROAD"],
        oracle_names=["Emerald City", "Yellow Brick Road"],
    )
    assert result.entity_recall == 1.0
    assert result.entity_precision == 1.0


def test_whitespace_trimmed():
    result = evaluate_entities(
        approved_names=["  Emerald City  "],
        oracle_names=["Emerald City"],
    )
    assert result.entity_recall == 1.0


def test_empty_oracle_gives_full_recall():
    result = evaluate_entities(approved_names=["Emerald City"], oracle_names=[])
    assert result.entity_recall == 1.0
    assert result.entity_precision == 0.0


def test_empty_approved_gives_zero_recall():
    result = evaluate_entities(approved_names=[], oracle_names=["Emerald City"])
    assert result.entity_recall == 0.0
    assert result.missed_entities == ["Emerald City"]


def test_both_empty():
    result = evaluate_entities(approved_names=[], oracle_names=[])
    assert result.entity_recall == 1.0
    assert result.entity_precision == 0.0


# ── Claim recall ───────────────────────────────────────────────────────────────

def test_claim_recall_hit():
    oracle = [{"subject": "Palace", "predicate": "LOCATED_IN", "object": "Emerald City"}]
    approved = [{"subject": "palace", "predicate": "located_in", "object": "emerald city"}]
    recall, found, missed = evaluate_claims(approved, oracle)
    assert recall == 1.0
    assert len(found) == 1
    assert missed == []


def test_claim_recall_miss():
    oracle = [{"subject": "Palace", "predicate": "LOCATED_IN", "object": "Emerald City"}]
    recall, found, missed = evaluate_claims([], oracle)
    assert recall == 0.0
    assert missed == oracle
    assert found == []


def test_claim_partial_recall():
    oracle = [
        {"subject": "Palace", "predicate": "LOCATED_IN", "object": "Emerald City"},
        {"subject": "Throne Room", "predicate": "CONTAINS", "object": "Throne"},
    ]
    approved = [{"subject": "palace", "predicate": "located_in", "object": "emerald city"}]
    recall, found, missed = evaluate_claims(approved, oracle)
    assert recall == pytest.approx(0.5, rel=1e-3)
    assert len(found) == 1
    assert len(missed) == 1


def test_empty_oracle_claims_returns_none_recall():
    recall, found, missed = evaluate_claims([{"subject": "A", "predicate": "B", "object": "C"}], [])
    assert recall is None
    assert found == []
    assert missed == []


# ── Combined evaluate_atlas ───────────────────────────────────────────────────

def test_evaluate_atlas_entities_only():
    result = evaluate_atlas(
        approved_names=["Emerald City", "Kansas"],
        oracle_names=["Emerald City", "Kansas", "Yellow Brick Road"],
    )
    assert result.entity_recall == pytest.approx(2 / 3, rel=1e-3)
    assert result.claim_recall is None


def test_evaluate_atlas_with_claims():
    oracle_claims = [{"subject": "Kansas", "predicate": "LEADS_TO", "object": "Oz"}]
    result = evaluate_atlas(
        approved_names=["Kansas", "Oz"],
        oracle_names=["Kansas", "Oz"],
        approved_claims=[{"subject": "kansas", "predicate": "leads_to", "object": "oz"}],
        oracle_claims=oracle_claims,
    )
    assert result.entity_recall == 1.0
    assert result.claim_recall == 1.0
