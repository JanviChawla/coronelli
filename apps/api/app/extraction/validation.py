_VALID_SCENE_ROLES = {"opening", "primary", "ending"}


def validate_candidate_payload(kind: str, payload: dict) -> None:
    """Raise ValueError if a required payload field is missing or blank.

    Called before persisting a Candidate. A candidate that fails this check
    is skipped with a warning — it is never persisted as a blank or partial row.
    """
    def _require(field: str) -> None:
        if not (payload.get(field) or "").strip():
            raise ValueError(f"{kind} payload missing required field '{field}'")

    if kind == "entity":
        _require("name")
        _require("type")

    elif kind == "claim":
        _require("subject")
        _require("predicate")
        _require("object")

    elif kind == "travel_rule":
        _require("route")
        if payload.get("can_traverse") is None:
            raise ValueError("travel_rule payload missing required field 'can_traverse'")

    elif kind == "visual_claim":
        _require("subject")
        _require("visual_property")
        _require("value")

    elif kind == "scene_anchor":
        _require("place")
        role = (payload.get("scene_role") or "").strip()
        if role not in _VALID_SCENE_ROLES:
            raise ValueError(
                f"scene_anchor.scene_role must be one of {sorted(_VALID_SCENE_ROLES)}, got '{role}'"
            )
