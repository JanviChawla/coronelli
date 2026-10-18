"""
Direct unit tests for validate_candidate_payload.

The function raises ValueError on invalid payloads, returns None on success.
"""
import pytest

from app.extraction.validation import validate_candidate_payload


# ── entity ────────────────────────────────────────────────────────────────────

def test_entity_valid_passes():
    validate_candidate_payload("entity", {"name": "Wonderland", "type": "region"})


def test_entity_missing_name_raises():
    with pytest.raises(ValueError, match="name"):
        validate_candidate_payload("entity", {"type": "region"})


def test_entity_blank_name_raises():
    with pytest.raises(ValueError, match="name"):
        validate_candidate_payload("entity", {"name": "   ", "type": "region"})


def test_entity_missing_type_raises():
    with pytest.raises(ValueError, match="type"):
        validate_candidate_payload("entity", {"name": "Wonderland"})


def test_entity_invalid_type_raises():
    with pytest.raises(ValueError, match="not an allowed entity type"):
        validate_candidate_payload("entity", {"name": "Wonderland", "type": "galaxy"})


def test_entity_prop_name_raises():
    with pytest.raises(ValueError, match="non-place pattern"):
        validate_candidate_payload("entity", {"name": "magic potion", "type": "landmark"})


def test_entity_hallucination_check_raises_when_name_absent_from_excerpt():
    with pytest.raises(ValueError, match="hallucinated"):
        validate_candidate_payload(
            "entity",
            {"name": "Hogwarts", "type": "building"},
            excerpt="Alice fell down the rabbit-hole.",
        )


def test_entity_hallucination_check_passes_when_no_excerpt():
    # No excerpt provided — validation should not penalise
    validate_candidate_payload("entity", {"name": "Hogwarts", "type": "building"}, excerpt="")


def test_entity_valid_with_kind_descriptor_normalises():
    payload = {"name": "Wonderland", "type": "region", "kind_descriptor": "river"}
    validate_candidate_payload("entity", payload)
    assert payload["kind_descriptor"] == "water"  # alias resolved


def test_entity_unknown_kind_descriptor_stripped():
    payload = {"name": "Wonderland", "type": "region", "kind_descriptor": "galaxy"}
    validate_candidate_payload("entity", payload)
    assert "kind_descriptor" not in payload


def test_entity_valid_tier_passes():
    validate_candidate_payload(
        "entity", {"name": "Wonderland", "type": "region", "tier": "surface"}
    )


def test_entity_invalid_tier_raises():
    with pytest.raises(ValueError, match="tier"):
        validate_candidate_payload(
            "entity", {"name": "Wonderland", "type": "region", "tier": "stratosphere"}
        )


# ── claim ─────────────────────────────────────────────────────────────────────

def test_claim_valid_passes():
    validate_candidate_payload(
        "claim",
        {"subject": "Rabbit-Hole", "predicate": "LEADS_TO", "object": "Long Passage"},
    )


def test_claim_missing_subject_raises():
    with pytest.raises(ValueError, match="subject"):
        validate_candidate_payload(
            "claim", {"predicate": "LEADS_TO", "object": "Long Passage"}
        )


def test_claim_missing_predicate_raises():
    with pytest.raises(ValueError, match="predicate"):
        validate_candidate_payload(
            "claim", {"subject": "Rabbit-Hole", "object": "Long Passage"}
        )


def test_claim_missing_object_raises():
    with pytest.raises(ValueError, match="object"):
        validate_candidate_payload(
            "claim", {"subject": "Rabbit-Hole", "predicate": "LEADS_TO"}
        )


def test_claim_invalid_predicate_raises():
    with pytest.raises(ValueError, match="not an allowed predicate"):
        validate_candidate_payload(
            "claim",
            {"subject": "A", "predicate": "DESTROYS", "object": "B"},
        )


def test_claim_non_spatial_subject_raises():
    with pytest.raises(ValueError, match="non-spatial phrase"):
        validate_candidate_payload(
            "claim",
            {"subject": "absence of light", "predicate": "LOCATED_IN", "object": "Cave"},
        )


def test_claim_non_spatial_object_raises():
    with pytest.raises(ValueError, match="non-spatial phrase"):
        validate_candidate_payload(
            "claim",
            {"subject": "Cave", "predicate": "LOCATED_IN", "object": "presence of water"},
        )


# ── visual_claim ──────────────────────────────────────────────────────────────

def test_visual_claim_valid_passes():
    validate_candidate_payload(
        "visual_claim",
        {"subject": "Hall of Mirrors", "category": "architecture", "observation": "gilded columns"},
    )


def test_visual_claim_missing_subject_raises():
    with pytest.raises(ValueError, match="subject"):
        validate_candidate_payload(
            "visual_claim",
            {"category": "architecture", "observation": "gilded columns"},
        )


def test_visual_claim_invalid_category_raises():
    with pytest.raises(ValueError, match="not an allowed category"):
        validate_candidate_payload(
            "visual_claim",
            {"subject": "Hall", "category": "vibes", "observation": "spooky"},
        )


# ── travel_rule ───────────────────────────────────────────────────────────────

def test_travel_rule_valid_passes():
    validate_candidate_payload(
        "travel_rule",
        {"route": "Rabbit-Hole -> Long Passage", "can_traverse": True},
    )


def test_travel_rule_missing_route_raises():
    with pytest.raises(ValueError, match="route"):
        validate_candidate_payload("travel_rule", {"can_traverse": True})


def test_travel_rule_missing_can_traverse_raises():
    with pytest.raises(ValueError, match="can_traverse"):
        validate_candidate_payload("travel_rule", {"route": "A -> B"})


# ── scene_anchor ──────────────────────────────────────────────────────────────

def test_scene_anchor_valid_passes():
    validate_candidate_payload(
        "scene_anchor", {"place": "Rabbit-Hole", "scene_role": "opening"}
    )


def test_scene_anchor_invalid_role_raises():
    with pytest.raises(ValueError, match="scene_role"):
        validate_candidate_payload(
            "scene_anchor", {"place": "Rabbit-Hole", "scene_role": "climax"}
        )


# ── unknown kind ──────────────────────────────────────────────────────────────

def test_unknown_kind_passes_silently():
    # validate_candidate_payload has no else branch for unknown kinds — it's a no-op
    validate_candidate_payload("unknown_kind", {"foo": "bar"})
