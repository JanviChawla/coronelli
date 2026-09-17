import re

_VALID_SCENE_ROLES = {"opening", "primary", "ending"}

_ALLOWED_PREDICATES = frozenset({
    # Containment / placement
    "CONTAINS", "LOCATED_IN", "PART_OF", "SURROUNDED_BY",
    # Connections / transitions
    "LEADS_TO", "PORTAL_TO", "DESCENDS_TO", "ENDS_AT",
    "OPENS_TOWARD", "HAS_OPENING", "BLOCKS_ACCESS_TO",
    # Relative position
    "ADJACENT_TO", "NEAR", "ABOVE", "UNDER", "IN_OR_ADJACENT_TO",
    "VISIBLE_FROM", "ON_BANK_OF", "FLOWS_THROUGH", "BORDERS",
    # Compass — only when explicitly stated in source text
    "NORTH_OF", "SOUTH_OF", "EAST_OF", "WEST_OF",
    "NORTHEAST_OF", "NORTHWEST_OF", "SOUTHEAST_OF", "SOUTHWEST_OF",
    # Travel
    "REACHED_FROM",
    # Identity / dedup
    "SAME_AS",
})

_ALLOWED_ENTITY_TYPES = frozenset({
    "world", "region", "island", "district", "settlement",
    "building", "hall", "room", "grounds", "landmark",
    "terrain_feature", "body_of_water", "vessel",
    "tunnel", "passage", "portal",
    "site", "court", "barrier",
})

_ALLOWED_KIND_DESCRIPTORS = frozenset({
    "tower", "hall", "settlement", "region", "forest", "water",
    "portal", "mountain", "vessel", "dungeon", "room",
    "landmark", "grounds", "building", "route",
})

_ALLOWED_TIERS = frozenset({
    "peak", "elevated", "surface", "underground", "deep",
})

_ALLOWED_VISUAL_CATEGORIES = frozenset({
    "architecture", "terrain", "light", "weather",
    "color", "material", "texture", "scale", "atmosphere", "decay", "other",
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
    t = text.strip()
    return bool(_NON_SPATIAL_PREFIX_RE.match(t) or _BARE_PRONOUN_RE.match(t))


def _looks_like_prop_not_place(name: str) -> bool:
    return bool(_PROP_WORDS_RE.search(name) or _CARD_CHARACTER_RE.match(name))


def validate_candidate_payload(kind: str, payload: dict) -> None:
    """Raise ValueError if a required payload field is missing or invalid.

    Called before persisting a Candidate. A candidate that fails this check
    is skipped with a warning — it is never persisted as a blank or partial row.

    Fields added in v4.0 (kind_descriptor, tier) are validated when present
    but not required, so existing catalog rows without them still persist.
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

        # v4.0 fields — validated when present, not required
        kind_desc = (payload.get("kind_descriptor") or "").strip().lower()
        if kind_desc and kind_desc not in _ALLOWED_KIND_DESCRIPTORS:
            raise ValueError(
                f"entity.kind_descriptor '{kind_desc}' is not an allowed descriptor"
            )

        tier = (payload.get("tier") or "").strip().lower()
        if tier and tier not in _ALLOWED_TIERS:
            raise ValueError(
                f"entity.tier '{tier}' is not an allowed tier"
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
        for segment in payload.get("route", "").split("->"):
            if _is_non_spatial_phrase(segment.strip()):
                raise ValueError(
                    f"travel_rule.route segment '{segment.strip()}' matches a non-spatial phrase pattern"
                )

    elif kind == "visual_claim":
        _require("subject")
        _require("category")
        _require("observation")
        category = (payload.get("category") or "").strip().lower()
        if category not in _ALLOWED_VISUAL_CATEGORIES:
            raise ValueError(
                f"visual_claim.category '{category}' is not an allowed category"
            )
        # palette is optional — no hard validation on color values

    elif kind == "access":
        _require("place_name")
        _require("access_type")
        access_type = (payload.get("access_type") or "").strip().lower()
        if access_type not in {"permitted", "prohibited", "conditional"}:
            raise ValueError(
                f"access.access_type '{access_type}' must be permitted, prohibited, or conditional"
            )

    elif kind == "movement":
        _require("to_place")

    elif kind == "scene_anchor":
        _require("place")
        role = (payload.get("scene_role") or "").strip()
        if role not in _VALID_SCENE_ROLES:
            raise ValueError(
                f"scene_anchor.scene_role must be one of {sorted(_VALID_SCENE_ROLES)}, got '{role}'"
            )
