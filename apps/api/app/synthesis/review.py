import logging

from sqlalchemy.orm import Session

from app.db.models import SourceSection
from app.domain.world import EntityMention, MapClaim, MapEntity, MapTravelRule
from app.extraction.models import Candidate
from app.synthesis.models import SynthesisItem

_log = logging.getLogger(__name__)

_CANONICALIZE_PRIORITY = {
    "entity": 0,
    "claim": 1,
    "route": 1,
    "visual_claim": 1,
    "access": 1,
    "movement": 1,
    "same_as": 2,
    "reveal_event": 3,
    "unresolved": 99,
}


# ── Provenance helpers ────────────────────────────────────────────────────────

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


# ── Per-kind canonicalization helpers ─────────────────────────────────────────

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


# ── Entity mentions ───────────────────────────────────────────────────────────

def _write_entity_mentions(session: Session, document_id: str) -> None:
    """Write one EntityMention per (entity, section) pair that references the entity.

    Scans per-section candidates to find which sections reference each canonical entity
    by name or alias. Replaces any existing mentions for the document.
    """
    entities = (
        session.query(MapEntity)
        .filter(MapEntity.provenance_document_id == document_id, MapEntity.state == "active")
        .all()
    )
    if not entities:
        return

    entity_by_name: dict[str, MapEntity] = {}
    for e in entities:
        entity_by_name[e.name.lower()] = e
        for alias in (e.aliases or []):
            if alias and alias.lower() not in entity_by_name:
                entity_by_name[alias.lower()] = e

    sections = (
        session.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .order_by(SourceSection.ordinal)
        .all()
    )

    session.query(EntityMention).filter(
        EntityMention.document_id == document_id
    ).delete(synchronize_session=False)

    for section in sections:
        candidates = (
            session.query(Candidate)
            .filter(Candidate.section_id == section.id)
            .all()
        )
        seen: dict[str, str] = {}  # entity_id → mention_kind
        for c in candidates:
            p = c.payload or {}
            for raw_name in [p.get("name"), p.get("subject"), p.get("object")]:
                if not raw_name:
                    continue
                entity = entity_by_name.get(str(raw_name).lower())
                if entity and entity.id not in seen:
                    kind = "origin" if entity.provenance_section_id == section.id else "referenced"
                    seen[entity.id] = kind

        for entity_id, kind in seen.items():
            session.add(EntityMention(
                entity_id=entity_id,
                document_id=document_id,
                section_id=section.id,
                section_ordinal=section.ordinal,
                mention_kind=kind,
                payload={},
            ))

    session.flush()


# ── Public canonicalization function ─────────────────────────────────────────

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
    for item in sorted_items:
        payload = item.payload or {}
        try:
            if item.kind == "entity":
                _approve_entity(session, document_id, payload)
                canonical_count += 1
            elif item.kind == "claim":
                _approve_claim(session, document_id, payload, "spatial")
                canonical_count += 1
            elif item.kind == "route":
                _approve_route(session, document_id, payload)
                canonical_count += 1
            elif item.kind == "visual_claim":
                _approve_claim(session, document_id, payload, "visual")
                canonical_count += 1
            elif item.kind == "access":
                _approve_claim(session, document_id, payload, "access")
                canonical_count += 1
            elif item.kind == "movement":
                _approve_route(session, document_id, payload)
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
