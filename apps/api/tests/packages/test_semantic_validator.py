import copy
import json
from pathlib import Path

import pytest

from app.packages.semantic_validator import validate_semantics

FIXTURES = Path(__file__).resolve().parent.parent.parent.parent.parent / "packages" / "atlas-package-v0.1" / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


@pytest.mark.parametrize("fixture_file", [
    "geographic-compass.json",
    "topological-portal.json",
    "mobile-vessel.json",
])
def test_valid_fixture_returns_no_issues(fixture_file):
    package = _load(fixture_file)
    issues = validate_semantics(package)
    assert issues == [], f"Expected no issues for {fixture_file}, got: {issues}"


def test_dangling_entity_ref_in_layout_element():
    package = _load("geographic-compass.json")
    package["layouts"][0]["elements"][0]["entityRef"] = "nonexistent-place"
    issues = validate_semantics(package)
    codes = [i.code for i in issues]
    assert "DANGLING_REF" in codes


def test_invalid_discovery_section_ref():
    package = _load("geographic-compass.json")
    package["world"]["entities"][0]["discovery"]["becomesVisibleAt"]["sectionId"] = "scene-99"
    issues = validate_semantics(package)
    codes = [i.code for i in issues]
    assert "INVALID_DISCOVERY_REF" in codes


def test_mobile_layout_anchor_without_interpretation():
    package = _load("mobile-vessel.json")
    package["world"]["entities"][1]["mapBehavior"]["coordinatePolicy"] = "layout-anchor-allowed"
    issues = validate_semantics(package)
    codes = [i.code for i in issues]
    assert "MOBILE_ANCHOR_REQUIRES_INTERPRETATION" in codes


def test_portal_styled_as_stated_road():
    package = _load("topological-portal.json")
    gate_element = next(
        e for e in package["layouts"][0]["elements"]
        if e.get("travelRuleRef") == "mirror-gate"
    )
    gate_element["kind"] = "stated-road"
    issues = validate_semantics(package)
    codes = [i.code for i in issues]
    assert "PORTAL_STYLED_AS_ROAD" in codes
