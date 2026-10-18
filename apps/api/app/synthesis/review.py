import logging

from sqlalchemy.orm import Session

from app.synthesis.models import SynthesisItem
from app.synthesis.review_approve import (
    _approve_claim,
    _approve_entity,
    _approve_reveal_event,
    _approve_route,
    _approve_same_as,
    _approve_visual_palette,
)
from app.synthesis.review_enrich import (
    _fill_entity_gaps,
    _write_entity_mentions,
    apply_catalog_fields,
    apply_scene_anchor_counts,
)

# Re-export so existing callers (service.py) can still import from this module
__all__ = [
    "canonicalize_synthesis_run",
    "apply_scene_anchor_counts",
    "apply_catalog_fields",
    "_approve_claim",
    "_approve_visual_palette",
]

_log = logging.getLogger(__name__)

_CANONICALIZE_PRIORITY = {
    "entity": 0,
    "claim": 1,
    "route": 1,
    "visual_claim": 1,
    "same_as": 2,
    "reveal_event": 3,
    "unresolved": 99,
}


def canonicalize_synthesis_run(
    session: Session,
    items: list[SynthesisItem],
    document_id: str,
) -> int:
    """Auto-canonicalize all synthesis items in dependency order.

    Processes: entity → claim/route/visual_claim → same_as → reveal_event.
    Returns the count of canonical records written.
    """
    sorted_items = sorted(items, key=lambda i: _CANONICALIZE_PRIORITY.get(i.kind, 50))
    canonical_count = 0

    # Pass 1: entities only — must exist before any claim resolution runs
    for item in sorted_items:
        if item.kind != "entity":
            continue
        payload = item.payload or {}
        try:
            _approve_entity(session, document_id, payload)
            canonical_count += 1
            item.review_state = "approved"
        except Exception:
            _log.warning(
                "Auto-canonicalize failed for entity item (id=%s)", item.id, exc_info=True,
            )

    # Gap-fill: mint any catalog entity synthesis dropped, so claim resolution can reference them
    canonical_count += _fill_entity_gaps(session, document_id)

    # Pass 2: claims, routes, same_as, reveal_events — all entities now exist
    for item in sorted_items:
        if item.kind == "entity":
            continue
        payload = item.payload or {}
        try:
            if item.kind == "claim":
                _approve_claim(session, document_id, payload, "spatial", item.confidence)
                canonical_count += 1
            elif item.kind == "route":
                _approve_route(session, document_id, payload)
                canonical_count += 1
            elif item.kind == "visual_claim":
                _approve_claim(session, document_id, payload, "visual", item.confidence)
                canonical_count += 1
            elif item.kind == "same_as":
                _approve_same_as(session, document_id, payload)
            elif item.kind == "reveal_event":
                _approve_reveal_event(session, document_id, payload)
            # unresolved: no canonical write
            item.review_state = "approved"
        except Exception:
            _log.warning(
                "Auto-canonicalize failed for %s item (id=%s)", item.kind, item.id, exc_info=True,
            )

    _write_entity_mentions(session, document_id)
    return canonical_count
