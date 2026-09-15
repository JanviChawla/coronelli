from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.domain.world import MapClaim, MapEntity, MapTravelRule
from app.synthesis.models import SynthesisItem

_VALID_ACTIONS = {"approve", "reject", "defer"}

_ACTION_TO_STATE = {
    "approve": "approved",
    "reject": "rejected",
    "defer": "deferred",
}


class SynthesisReviewError(Exception):
    pass


@dataclass
class SynthesisReviewResult:
    item: SynthesisItem
    created_entity: MapEntity | None = field(default=None)
    created_claim: MapClaim | None = field(default=None)
    created_travel_rule: MapTravelRule | None = field(default=None)


# ── Per-kind approval helpers ─────────────────────────────────────────────────

def _find_or_create_entity(session: Session, document_id: str, name: str, place_kind: str | None, payload: dict) -> MapEntity:
    existing = (
        session.query(MapEntity)
        .filter(
            MapEntity.name == name,
            MapEntity.provenance_document_id == document_id,
            MapEntity.state == "active",
        )
        .first()
    )
    if existing:
        return existing

    entity = MapEntity(
        name=name,
        entity_kind="place",
        place_kind=place_kind,
        status="explicit",
        state="active",
        provenance_document_id=document_id,
        provenance_section_id=None,
        candidate_id=None,
        payload=payload,
        aliases=list(payload.get("aliases") or []),
    )
    session.add(entity)
    session.flush()
    return entity


def _approve_entity(session: Session, document_id: str, payload: dict) -> MapEntity:
    name = (payload.get("name") or "").strip()
    if not name:
        raise SynthesisReviewError("entity payload missing 'name'.")
    return _find_or_create_entity(session, document_id, name, payload.get("type"), payload)


def _resolve_entity_id(session: Session, document_id: str, name: str | None) -> str | None:
    if not name:
        return None
    entity = (
        session.query(MapEntity)
        .filter(
            MapEntity.name == name,
            MapEntity.provenance_document_id == document_id,
            MapEntity.state == "active",
        )
        .first()
    )
    return entity.id if entity else None


def _approve_claim(session: Session, document_id: str, payload: dict, claim_type: str) -> MapClaim:
    subject_ref = _resolve_entity_id(session, document_id, payload.get("subject"))
    object_id = _resolve_entity_id(session, document_id, payload.get("object"))
    claim = MapClaim(
        claim_type=claim_type,
        subject_ref=subject_ref,
        predicate=payload.get("predicate"),
        object_refs=[object_id] if object_id else None,
        status="explicit",
        confidence=None,
        state="active",
        provenance_document_id=document_id,
        provenance_section_id=None,
        excerpt=None,
        candidate_id=None,
        payload=payload,
    )
    session.add(claim)
    session.flush()
    return claim


def _approve_route(session: Session, document_id: str, payload: dict) -> MapTravelRule:
    frm = payload.get("from", "")
    to = payload.get("to", "")
    route_str = f"{frm} → {to}" if (frm and to) else frm or to or ""
    raw_traverse = payload.get("can_traverse")
    travel_rule = MapTravelRule(
        traveler=payload.get("traveler"),
        can_traverse=bool(raw_traverse) if raw_traverse is not None else None,
        route=route_str or None,
        condition=payload.get("condition"),
        status="explicit",
        state="active",
        provenance_document_id=document_id,
        provenance_section_id=None,
        candidate_id=None,
        payload=payload,
    )
    session.add(travel_rule)
    session.flush()
    return travel_rule


def _approve_same_as(session: Session, document_id: str, payload: dict) -> MapEntity:
    a_name = (payload.get("a") or "").strip()
    b_name = (payload.get("b") or "").strip()
    if not a_name:
        raise SynthesisReviewError("same_as payload missing 'a'.")

    canonical = _find_or_create_entity(session, document_id, a_name, None, payload)

    current_aliases = list(canonical.aliases or [])
    if b_name and b_name not in current_aliases and b_name != a_name:
        current_aliases.append(b_name)
        canonical.aliases = current_aliases

    if b_name:
        b_entity = (
            session.query(MapEntity)
            .filter(
                MapEntity.name == b_name,
                MapEntity.provenance_document_id == document_id,
                MapEntity.state == "active",
            )
            .first()
        )
        if b_entity and b_entity.id != canonical.id:
            b_entity.state = "merged"

    session.flush()
    return canonical


def _approve_reveal_event(session: Session, document_id: str, payload: dict) -> None:
    entity_name = (payload.get("entity_name") or "").strip()
    section_ordinal = payload.get("section_ordinal")
    if not entity_name:
        return

    entity = (
        session.query(MapEntity)
        .filter(
            MapEntity.name == entity_name,
            MapEntity.provenance_document_id == document_id,
            MapEntity.state == "active",
        )
        .first()
    )
    if entity is None:
        return

    if entity.provenance_section_id is None and section_ordinal is not None:
        from app.db.models import SourceSection  # noqa: PLC0415
        section = (
            session.query(SourceSection)
            .filter(
                SourceSection.document_id == document_id,
                SourceSection.ordinal == section_ordinal,
            )
            .first()
        )
        if section:
            entity.provenance_section_id = section.id
            session.flush()


# ── Public service function ───────────────────────────────────────────────────

def review_synthesis_item(
    session: Session,
    item_id: str,
    action: str,
) -> SynthesisReviewResult:
    if action not in _VALID_ACTIONS:
        raise SynthesisReviewError(f"Invalid action '{action}'. Must be one of: {sorted(_VALID_ACTIONS)}.")

    item = session.get(SynthesisItem, item_id)
    if item is None:
        raise SynthesisReviewError(f"SynthesisItem '{item_id}' not found.")

    entity: MapEntity | None = None
    claim: MapClaim | None = None
    travel_rule: MapTravelRule | None = None

    if action == "approve":
        document_id = item.document_id
        payload = item.payload

        if item.kind == "entity":
            entity = _approve_entity(session, document_id, payload)
        elif item.kind == "claim":
            claim = _approve_claim(session, document_id, payload, "spatial")
        elif item.kind == "route":
            travel_rule = _approve_route(session, document_id, payload)
        elif item.kind == "visual_claim":
            claim = _approve_claim(session, document_id, payload, "visual")
        elif item.kind == "same_as":
            entity = _approve_same_as(session, document_id, payload)
        elif item.kind == "reveal_event":
            _approve_reveal_event(session, document_id, payload)
        # unresolved: no domain write

    item.review_state = _ACTION_TO_STATE[action]
    session.commit()

    return SynthesisReviewResult(
        item=item,
        created_entity=entity,
        created_claim=claim,
        created_travel_rule=travel_rule,
    )


def approve_all_synthesis_entities(
    session: Session,
    document_id: str,
) -> int:
    items = (
        session.query(SynthesisItem)
        .filter(
            SynthesisItem.document_id == document_id,
            SynthesisItem.kind == "entity",
            SynthesisItem.review_state == "provisional",
        )
        .order_by(SynthesisItem.ordinal)
        .all()
    )
    approved = 0
    for item in items:
        try:
            review_synthesis_item(session, item.id, "approve")
            approved += 1
        except SynthesisReviewError:
            pass
    return approved
