import json
from pathlib import Path

import pytest

from app.packages.schema_validator import validate_schema

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
    issues = validate_schema(package)
    assert issues == [], f"Expected no issues for {fixture_file}, got: {issues}"


def test_missing_manifest_fails():
    package = _load("geographic-compass.json")
    del package["manifest"]
    issues = validate_schema(package)
    assert any(i.code == "SCHEMA_ERROR" for i in issues)


def test_invalid_format_version_fails():
    package = _load("geographic-compass.json")
    package["manifest"]["formatVersion"] = "99.0"
    issues = validate_schema(package)
    assert any(i.code == "SCHEMA_ERROR" for i in issues)


def test_missing_layouts_array_fails():
    package = _load("geographic-compass.json")
    del package["layouts"]
    issues = validate_schema(package)
    assert any(i.code == "SCHEMA_ERROR" for i in issues)
