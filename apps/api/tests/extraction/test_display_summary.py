"""
Unit tests for deterministic candidate display summaries.

These test application code only — no LLM calls, no DB, no provider.
"""
import pytest

from app.extraction.display import candidate_display_summary
from app.extraction.validation import validate_candidate_payload


# ── candidate_display_summary ─────────────────────────────────────────────────

class TestEntitySummary:
    def test_full(self):
        assert candidate_display_summary("entity", {"name": "Long Low Hall", "type": "hall"}) == "Long Low Hall (hall)"

    def test_no_type(self):
        assert candidate_display_summary("entity", {"name": "Mystery Place"}) == "Mystery Place"

    def test_no_name(self):
        result = candidate_display_summary("entity", {"type": "room"})
        assert "room" in result

    def test_never_empty(self):
        result = candidate_display_summary("entity", {})
        assert result  # non-empty string


class TestClaimSummary:
    def test_full(self):
        p = {"subject": "Tree Door", "predicate": "LEADS_TO", "object": "Long Low Hall"}
        assert candidate_display_summary("claim", p) == "Tree Door LEADS_TO Long Low Hall"

    def test_missing_predicate_shows_available_parts(self):
        p = {"subject": "Tree Door", "object": "Long Low Hall"}
        result = candidate_display_summary("claim", p)
        assert "Tree Door" in result
        assert result  # non-empty

    def test_empty_payload_is_labeled(self):
        result = candidate_display_summary("claim", {})
        assert result == "(incomplete claim)"


class TestTravelRuleSummary:
    def test_with_traveler(self):
        p = {"traveler": "Alice", "route": "Riverbank -> Rabbit Hole -> Long Low Hall", "can_traverse": True}
        result = candidate_display_summary("travel_rule", p)
        assert result == "Alice: Riverbank -> Rabbit Hole -> Long Low Hall"

    def test_null_traveler_shows_route_only(self):
        p = {"traveler": None, "route": "Hall -> Door -> Garden", "can_traverse": True}
        result = candidate_display_summary("travel_rule", p)
        assert result == "Hall -> Door -> Garden"

    def test_no_route_uses_traveler(self):
        p = {"traveler": "Dorothy", "can_traverse": True}
        result = candidate_display_summary("travel_rule", p)
        assert "Dorothy" in result

    def test_empty_payload_is_labeled(self):
        result = candidate_display_summary("travel_rule", {})
        assert result == "(unnamed route)"


class TestVisualClaimSummary:
    def test_full(self):
        p = {"subject": "Long Low Hall", "visual_property": "lighting", "value": "row of lamps hanging from the roof"}
        assert candidate_display_summary("visual_claim", p) == "Long Low Hall · lighting: row of lamps hanging from the roof"

    def test_croquet_ground_example(self):
        p = {"subject": "Croquet Ground", "visual_property": "terrain", "value": "ridges and furrows"}
        assert candidate_display_summary("visual_claim", p) == "Croquet Ground · terrain: ridges and furrows"

    def test_missing_value_shows_what_exists(self):
        p = {"subject": "Hall", "visual_property": "lighting"}
        result = candidate_display_summary("visual_claim", p)
        assert "Hall" in result
        assert result  # non-empty; not ": ="

    def test_empty_payload_is_labeled(self):
        result = candidate_display_summary("visual_claim", {})
        assert result == "(incomplete visual claim)"


class TestSceneAnchorSummary:
    def test_opening(self):
        p = {"place": "Riverbank", "scene_role": "opening"}
        assert candidate_display_summary("scene_anchor", p) == "Opening scene · Riverbank"

    def test_primary(self):
        p = {"place": "Trial Court", "scene_role": "primary"}
        assert candidate_display_summary("scene_anchor", p) == "Primary scene · Trial Court"

    def test_ending(self):
        p = {"place": "Emerald City", "scene_role": "ending"}
        assert candidate_display_summary("scene_anchor", p) == "Ending scene · Emerald City"

    def test_no_role(self):
        result = candidate_display_summary("scene_anchor", {"place": "Long Low Hall"})
        assert "Long Low Hall" in result

    def test_empty_payload_is_labeled(self):
        result = candidate_display_summary("scene_anchor", {})
        assert result == "(unresolved scene)"


class TestUnknownKind:
    def test_unknown_kind_returns_labeled(self):
        result = candidate_display_summary("future_kind", {"foo": "bar"})
        assert "(future_kind)" in result


# ── validate_candidate_payload ────────────────────────────────────────────────

class TestEntityValidation:
    def test_valid(self):
        validate_candidate_payload("entity", {"name": "Long Low Hall", "type": "hall"})  # no exception

    def test_missing_name(self):
        with pytest.raises(ValueError, match="name"):
            validate_candidate_payload("entity", {"type": "hall"})

    def test_blank_name(self):
        with pytest.raises(ValueError, match="name"):
            validate_candidate_payload("entity", {"name": "  ", "type": "hall"})

    def test_missing_type(self):
        with pytest.raises(ValueError, match="type"):
            validate_candidate_payload("entity", {"name": "Hall"})

    def test_barrier_type_accepted(self):
        validate_candidate_payload("entity", {"name": "China Wall", "type": "barrier"})  # no exception


class TestClaimValidation:
    def test_valid(self):
        validate_candidate_payload("claim", {"subject": "A", "predicate": "LEADS_TO", "object": "B"})

    def test_missing_predicate(self):
        with pytest.raises(ValueError, match="predicate"):
            validate_candidate_payload("claim", {"subject": "A", "object": "B"})

    def test_missing_subject(self):
        with pytest.raises(ValueError, match="subject"):
            validate_candidate_payload("claim", {"predicate": "LEADS_TO", "object": "B"})

    def test_missing_object(self):
        with pytest.raises(ValueError, match="object"):
            validate_candidate_payload("claim", {"subject": "A", "predicate": "LEADS_TO"})


class TestTravelRuleValidation:
    def test_valid(self):
        validate_candidate_payload("travel_rule", {"route": "A -> B", "can_traverse": True})

    def test_missing_route(self):
        with pytest.raises(ValueError, match="route"):
            validate_candidate_payload("travel_rule", {"can_traverse": True})

    def test_missing_can_traverse(self):
        with pytest.raises(ValueError, match="can_traverse"):
            validate_candidate_payload("travel_rule", {"route": "A -> B"})

    def test_null_traveler_accepted(self):
        validate_candidate_payload("travel_rule", {"traveler": None, "route": "A -> B", "can_traverse": True})


class TestVisualClaimValidation:
    def test_valid(self):
        validate_candidate_payload("visual_claim", {"subject": "Hall", "visual_property": "lighting", "value": "dark"})

    def test_missing_value(self):
        with pytest.raises(ValueError, match="value"):
            validate_candidate_payload("visual_claim", {"subject": "Hall", "visual_property": "lighting"})

    def test_blank_value(self):
        with pytest.raises(ValueError, match="value"):
            validate_candidate_payload("visual_claim", {"subject": "Hall", "visual_property": "lighting", "value": ""})

    def test_missing_visual_property(self):
        with pytest.raises(ValueError, match="visual_property"):
            validate_candidate_payload("visual_claim", {"subject": "Hall", "value": "dark"})


class TestSceneAnchorValidation:
    def test_valid_opening(self):
        validate_candidate_payload("scene_anchor", {"place": "Riverbank", "scene_role": "opening"})

    def test_valid_primary(self):
        validate_candidate_payload("scene_anchor", {"place": "Hall", "scene_role": "primary"})

    def test_valid_ending(self):
        validate_candidate_payload("scene_anchor", {"place": "Garden", "scene_role": "ending"})

    def test_missing_place(self):
        with pytest.raises(ValueError, match="place"):
            validate_candidate_payload("scene_anchor", {"scene_role": "opening"})

    def test_invalid_scene_role(self):
        with pytest.raises(ValueError, match="scene_role"):
            validate_candidate_payload("scene_anchor", {"place": "Hall", "scene_role": "climax"})

    def test_missing_scene_role(self):
        with pytest.raises(ValueError, match="scene_role"):
            validate_candidate_payload("scene_anchor", {"place": "Hall"})
