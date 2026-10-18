"""Synthesis pass — layout computation and graph normalization. No LLM required."""

import math
from typing import Any


GOLDEN_ANGLE = 2.39996323  # radians (≈ 137.508°)

CONTAINMENT_PREDICATES = {"LOCATED_IN", "CONTAINS"}
TRAVEL_PREDICATES = {"LEADS_TO", "HAS_OPENING", "PORTAL_TO"}


def compute_layout(
    places: list[dict[str, Any]],
    claims: list[dict[str, Any]],
) -> dict[str, tuple[float, float]]:
    """
    Compute XZ positions for all confirmed, non-edge places.

    Returns {place_id: (x, z)}.

    Algorithm:
    1. Build a parent→children map from LOCATED_IN/CONTAINS claims.
    2. Detect and break cycles greedily (claim from the earlier section wins).
    3. Place root nodes (no parent) on a circle using the golden angle.
    4. Recursively place children on a radial ring of radius parent_radius * 0.5.
    5. Orphaned nodes (cycle victims) go on an outer ring beyond all roots.
    """
    place_map = {p["id"]: p for p in places}
    place_ids = set(place_map)

    # ── 1. Build raw parent→children map ─────────────────────────────────────
    parent_of: dict[str, str] = {}  # child_id → parent_id
    children_of: dict[str, list[str]] = {pid: [] for pid in place_ids}

    containment_claims = [
        c for c in claims
        if c.get("claim_type") == "spatial"
        and c.get("predicate") in CONTAINMENT_PREDICATES
        and c.get("subject_id") in place_ids
        and c.get("object_id") in place_ids
    ]

    # Sort by section ordinal so earlier sections win cycle-breaking
    containment_claims.sort(key=lambda c: c.get("section_ordinal", 0))

    for claim in containment_claims:
        pred = claim["predicate"]
        if pred == "LOCATED_IN":
            child_id, parent_id = claim["subject_id"], claim["object_id"]
        else:  # CONTAINS
            child_id, parent_id = claim["object_id"], claim["subject_id"]

        if child_id not in parent_of:
            parent_of[child_id] = parent_id

    # ── 2. Cycle detection and breaking ──────────────────────────────────────
    def has_cycle(start: str, visited: set[str]) -> bool:
        cur = start
        seen: set[str] = set()
        while cur in parent_of:
            if cur in seen:
                return True
            seen.add(cur)
            cur = parent_of[cur]
        return False

    orphaned: set[str] = set()
    for child_id in list(parent_of.keys()):
        if has_cycle(child_id, set()):
            # Break the cycle by orphaning this child
            orphaned.add(child_id)
            del parent_of[child_id]

    # Build children map from clean parent_of
    for child_id, pid in parent_of.items():
        if pid in children_of:
            children_of[pid].append(child_id)

    roots = [pid for pid in place_ids if pid not in parent_of and pid not in orphaned]

    # ── 3. Place roots on a golden-angle spiral ───────────────────────────────
    root_count = max(len(roots), 1)
    root_radius = max(3.5, root_count * 0.95)

    positions: dict[str, tuple[float, float]] = {}

    for i, root_id in enumerate(roots):
        angle = i * GOLDEN_ANGLE
        r = root_radius
        positions[root_id] = (r * math.cos(angle), r * math.sin(angle))

    # ── 4. Recursively place children ─────────────────────────────────────────
    def place_children(parent_id: str, parent_x: float, parent_z: float, parent_r: float) -> None:
        kids = children_of.get(parent_id, [])
        if not kids:
            return
        child_r = max(parent_r * 0.5, 0.4)
        for j, child_id in enumerate(kids):
            angle = j * GOLDEN_ANGLE
            cx = parent_x + child_r * math.cos(angle)
            cz = parent_z + child_r * math.sin(angle)
            positions[child_id] = (cx, cz)
            place_children(child_id, cx, cz, child_r)

    for root_id in roots:
        if root_id in positions:
            rx, rz = positions[root_id]
            place_children(root_id, rx, rz, root_radius)

    # ── 5. Orphaned nodes on outer ring ───────────────────────────────────────
    outer_radius = root_radius + 4.0
    for k, orphan_id in enumerate(sorted(orphaned)):
        angle = k * GOLDEN_ANGLE
        positions[orphan_id] = (
            outer_radius * math.cos(angle),
            outer_radius * math.sin(angle),
        )

    # Any confirmed place not yet positioned (shouldn't happen, but be safe)
    unpositioned = [pid for pid in place_ids if pid not in positions]
    fallback_r = outer_radius + 2.0
    for m, pid in enumerate(unpositioned):
        angle = m * GOLDEN_ANGLE
        positions[pid] = (fallback_r * math.cos(angle), fallback_r * math.sin(angle))

    return positions


def normalize_containment(claims: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Normalise CONTAINS → LOCATED_IN (canonical direction is child LOCATED_IN parent).
    Returns a new list; does not mutate the input.
    """
    result = []
    for claim in claims:
        if claim.get("predicate") == "CONTAINS":
            flipped = dict(claim)
            flipped["predicate"] = "LOCATED_IN"
            flipped["subject_id"], flipped["object_id"] = (
                claim["object_id"],
                claim["subject_id"],
            )
            result.append(flipped)
        else:
            result.append(claim)
    return result


def consolidate_palettes(
    places: list[dict[str, Any]],
    visual_claims: list[dict[str, Any]],
) -> dict[str, list[dict[str, str]]]:
    """
    Merge visual claims into per-place palettes.
    Most-mentioned hex wins when multiple claims exist for the same place.
    Returns {place_id: [{hex, label}]}.
    """
    from collections import Counter, defaultdict

    hex_counts: dict[str, Counter] = defaultdict(Counter)
    hex_labels: dict[str, dict[str, str]] = defaultdict(dict)

    for claim in visual_claims:
        subject_id = claim.get("subject_id")
        palette = claim.get("payload", {}).get("palette") if claim.get("payload") else None
        if not subject_id or not palette:
            continue
        for swatch in palette:
            h = swatch.get("hex", "")
            l = swatch.get("label", "")
            if h:
                hex_counts[subject_id][h] += 1
                if h not in hex_labels[subject_id]:
                    hex_labels[subject_id][h] = l

    result: dict[str, list[dict[str, str]]] = {}
    for place_id, counts in hex_counts.items():
        sorted_hexes = sorted(counts.items(), key=lambda kv: -kv[1])[:5]
        result[place_id] = [
            {"hex": h, "label": hex_labels[place_id].get(h, "")} for h, _ in sorted_hexes
        ]
    return result
