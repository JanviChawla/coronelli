import json
from pathlib import Path

import jsonschema

from .models import ValidationIssue

_SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent.parent.parent.parent
    / "packages"
    / "atlas-package-v0.1"
    / "schema.json"
)


def _load_schema() -> dict:
    return json.loads(_SCHEMA_PATH.read_text())


def validate_schema(package: dict) -> list[ValidationIssue]:
    schema = _load_schema()
    validator = jsonschema.Draft202012Validator(schema)
    issues: list[ValidationIssue] = []
    for error in validator.iter_errors(package):
        path = "/" + "/".join(str(p) for p in error.absolute_path) if error.absolute_path else "/"
        issues.append(ValidationIssue(code="SCHEMA_ERROR", path=path, message=error.message))
    return issues
