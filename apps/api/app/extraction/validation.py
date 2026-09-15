import re

_VALID_SCENE_ROLES = {"opening", "primary", "ending"}

_ALLOWED_PREDICATES = frozenset({
    # Containment / placement
    "CONTAINS", "LOCATED_IN", "IN_OR_ADJACENT_TO",
    # Transitions
    "LEADS_TO", "OPENS_TOWARD", "HAS_OPENING", "BLOCKS_ACCESS_TO",
    # Relative position
    "ADJACENT_TO", "NEAR", "UNDER", "ABOVE", "DESCENDS_TO", "ENDS_AT",
    # Compass directions — only when source text explicitly states a direction
    "NORTH_OF", "SOUTH_OF", "EAST_OF", "WEST_OF",
    "NORTHEAST_OF", "NORTHWEST_OF", "SOUTHEAST_OF", "SOUTHWEST_OF",
    # Enclosure
    "SURROUNDED_BY",
    # Identity / provenance
    "REACHED_FROM", "SAME_AS",
})

_ALLOWED_ENTITY_TYPES = frozenset({
    "world", "region", "island", "settlement", "landmark", "building", "room", "hall",
    "tunnel", "shaft", "passage", "portal", "door", "exterior", "terrain_feature",
    "body_of_water", "site", "court", "barrier",
})

_NON_SPATIAL_PREFIX_RE = re.compile(
    r"^(absence of|presence of|lack of|group of|crowd of)\b",
    re.IGNORECASE,
)
_BARE_PRONOUN_RE = re.compile(r"^(it|this|that|there)$", re.IGNORECASE)

_PROP_WORDS_RE = re.compile(
    r"\b(key|bottle|potion|thimble|tart|tarts|biscuit)\b",
    re.IGNORECASE,
)
_CARD_CHARACTER_RE = re.compile(r"^(knave|bishop|rook|pawn)\s+of\b", re.IGNORECASE)


def _is_non_spatial_phrase(text: str) -> bool:
    """Return True when *text* is clearly not a place name."""
    t = text.strip()
    return bool(_NON_SPATIAL_PREFIX_RE.match(t) or _BARE_PRONOUN_RE.match(t))


def _looks_like_prop_not_place(name: str) -> bool:
    """Return True for obvious non-place entity names (props, card characters)."""
    return bool(_PROP_WORDS_RE.search(name) or _CARD_CHARACTER_RE.match(name))


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
        entity_type = (payload.get("type") or "").strip().lower()
        if entity_type not in _ALLOWED_ENTITY_TYPES:
            raise ValueError(
                f"entity.type '{entity_type}' is not an allowed entity type"
            )
        if _looks_like_prop_not_place(payload.get("name", "")):
            raise ValueError(
                f"entity.name '{payload.get('name', '')}' matches an excluded non-place pattern"
            )

    elif kind == "claim":
        _require("subject")
        _require("predicate")
        _require("object")
        predicate = payload.get("predicate", "").strip().upper()
        if predicate not in _ALLOWED_PREDICATES:
            raise ValueError(
                f"claim.predicate '{predicate}' is not an allowed predicate"
            )
        if _is_non_spatial_phrase(payload.get("subject", "")):
            raise ValueError(
                f"claim.subject '{payload.get('subject', '')}' matches a non-spatial phrase pattern"
            )
        if _is_non_spatial_phrase(payload.get("object", "")):
            raise ValueError(
                f"claim.object '{payload.get('object', '')}' matches a non-spatial phrase pattern"
            )

    elif kind == "travel_rule":
        _require("route")
        if payload.get("can_traverse") is None:
            raise ValueError("travel_rule payload missing required field 'can_traverse'")
        route = payload.get("route", "")
        for segment in route.split("->"):
            if _is_non_spatial_phrase(segment.strip()):
                raise ValueError(
                    f"travel_rule.route segment '{segment.strip()}' matches a non-spatial phrase pattern"
                )

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
