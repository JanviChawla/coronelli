import logging

from sqlalchemy.orm import Session

from app.db.models import SourceSection
from app.domain.world import MapClaim, MapEntity, MapTravelRule
from app.extraction.models import Candidate

_log = logging.getLogger(__name__)

_CONTAINMENT_PREDICATES = {"CONTAINS", "LOCATED_IN", "PART_OF"}


def _find_provenance_section(session: Session, document_id: str, name: str) -> str | None:
    """Return the id of the earliest section containing a candidate that names this entity."""
    name_lower = name.lower()
    sections = (
        session.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .order_by(SourceSection.ordinal)
        .all()
    )
    for section in sections:
        candidates = (
            session.query(Candidate)
            .filter(Candidate.section_id == section.id)
            .all()
        )
        for c in candidates:
            p = c.payload or {}
            candidate_names = [p.get("name", ""), p.get("subject", ""), p.get("object", "")]
            if any(n and n.lower() == name_lower for n in candidate_names):
                return section.id
    return None


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
        provenance_section_id=_find_provenance_section(session, document_id, name),
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
        raise ValueError("entity payload missing 'name'.")
    return _find_or_create_entity(session, document_id, name, payload.get("type"), payload)


def _resolve_entity_id(session: Session, document_id: str, name: str | None) -> str | None:
    if not name:
        return None
    name_lower = name.lower().strip()
    entities = (
        session.query(MapEntity)
        .filter(
            MapEntity.provenance_document_id == document_id,
            MapEntity.state == "active",
        )
        .all()
    )
    # 1. Exact name match
    for e in entities:
        if e.name.lower() == name_lower:
            return e.id
    # 2. Alias match
    for e in entities:
        for alias in (e.aliases or []):
            if alias and alias.lower() == name_lower:
                return e.id
    # 3. Substring match: handles "Hudson" → "Hudson River", "Tappan Zee" → "Tappan Zee"
    #    Only match when one name is a clean prefix/suffix of the other to avoid false positives.
    for e in entities:
        ename = e.name.lower()
        if name_lower in ename or ename in name_lower:
            return e.id
    return None


def _normalize_containment(payload: dict) -> dict:
    """Normalize CONTAINS / PART_OF → LOCATED_IN with correct subject/object direction.

    Canonical form: LOCATED_IN(subject=contained, object=container).
    - LOCATED_IN(A, B): A is inside B — already canonical, no change.
    - CONTAINS(A, B): A contains B → LOCATED_IN(B, A), flip subject and object.
    - PART_OF(A, B): A is part of B → LOCATED_IN(A, B), same direction, rename predicate.
    """
    predicate = (payload.get("predicate") or "").upper()
    if predicate not in _CONTAINMENT_PREDICATES or predicate == "LOCATED_IN":
        return payload
    if predicate == "CONTAINS":
        return {**payload, "predicate": "LOCATED_IN", "subject": payload.get("object"), "object": payload.get("subject")}
    # PART_OF: same direction as LOCATED_IN, just rename
    return {**payload, "predicate": "LOCATED_IN"}


def _approve_claim(
    session: Session,
    document_id: str,
    payload: dict,
    claim_type: str,
    confidence: float | None = None,
) -> MapClaim:
    if claim_type == "spatial":
        payload = _normalize_containment(payload)
    subject_ref = _resolve_entity_id(session, document_id, payload.get("subject"))
    object_id = _resolve_entity_id(session, document_id, payload.get("object"))
    claim = MapClaim(
        claim_type=claim_type,
        subject_ref=subject_ref,
        predicate=payload.get("predicate"),
        object_refs=[object_id] if object_id else None,
        status="explicit",
        confidence=confidence,
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
        raise ValueError("same_as payload missing 'a'.")

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


def _approve_visual_palette(session: Session, document_id: str, payload: dict) -> None:
    entity_name = (payload.get("entity_name") or "").strip()
    colors = payload.get("colors")
    if not entity_name or not isinstance(colors, dict):
        return
    entity_id = _resolve_entity_id(session, document_id, entity_name)
    if not entity_id:
        _log.warning("visual_palette: could not resolve entity '%s' — skipping", entity_name)
        return
    entity = session.query(MapEntity).filter(MapEntity.id == entity_id).first()
    if entity is None:
        return
    entity.payload = {**(entity.payload or {}), "colors": colors}
    session.flush()


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
