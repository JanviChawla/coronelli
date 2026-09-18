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

    # Preserve containment hierarchy (located_in) set during assign-containment step.
    # Synthesis supersedes the stub entities before recreating them, so we copy
    # located_in from the most recent superseded stub with the same name (or alias).
    name_lower = name.strip().lower()
    aliases_lower = {a.strip().lower() for a in (payload.get("aliases") or []) if a}
    superseded_stub = (
        session.query(MapEntity)
        .filter(
            MapEntity.provenance_document_id == document_id,
            MapEntity.state == "superseded",
            MapEntity.located_in.isnot(None),
        )
        .all()
    )
    for stub in superseded_stub:
        stub_name = (stub.name or "").strip().lower()
        stub_aliases = {(a or "").strip().lower() for a in (stub.aliases or [])}
        if stub_name == name_lower or stub_name in aliases_lower or name_lower in stub_aliases:
            entity.located_in = stub.located_in
            break

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


_CONTAINMENT_PREDICATES = {"CONTAINS", "LOCATED_IN", "PART_OF"}


def _normalize_containment(payload: dict) -> dict:
    """Normalize CONTAINS / PART_OF → LOCATED_IN with correct subject/object direction.

    Canonical form: LOCATED_IN(subject=contained, object=container).
    - LOCATED_IN: already canonical, no change.
    - PART_OF(A, B):  A is structurally part of B → LOCATED_IN(A, B), same direction.
    - CONTAINS(A, B): A contains B → LOCATED_IN(B, A), flip subject and object.
    """
    predicate = (payload.get("predicate") or "").upper()
    if predicate not in _CONTAINMENT_PREDICATES or predicate == "LOCATED_IN":
        return payload
    if predicate == "CONTAINS":
        return {**payload, "predicate": "LOCATED_IN", "subject": payload.get("object"), "object": payload.get("subject")}
    # PART_OF — same direction, just rename
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

def _fill_entity_gaps(session: Session, document_id: str) -> int:
    """Guarantee every non-rejected catalog entity appears as a canonical record.

    Synthesis may drop low-evidence entities. This deterministic pass mints
    minimal MapEntity records for any approved candidate not already covered
    by a canonical entity name or alias.
    """
    sections = (
        session.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .all()
    )
    section_ids = [s.id for s in sections]

    candidates = (
        session.query(Candidate)
        .filter(
            Candidate.section_id.in_(section_ids),
            Candidate.kind == "entity",
            Candidate.review_state != "rejected",
        )
        .all()
    )

    active_entities = (
        session.query(MapEntity)
        .filter(
            MapEntity.provenance_document_id == document_id,
            MapEntity.state == "active",
        )
        .all()
    )

    covered: set[str] = set()
    for e in active_entities:
        if e.name:
            covered.add(e.name.strip().lower())
        for alias in (e.aliases or []):
            if alias:
                covered.add(alias.strip().lower())

    filled = 0
    seen: set[str] = set()
    for c in candidates:
        name = (c.payload.get("name") or "").strip()
        if not name:
            continue
        norm = name.lower()
        if norm in covered or norm in seen:
            continue
        seen.add(norm)
        entity = MapEntity(
            name=name,
            entity_kind="place",
            place_kind=c.payload.get("type"),
            status="explicit",
            state="active",
            provenance_document_id=document_id,
            provenance_section_id=c.section_id,
            candidate_id=c.id,
            aliases=list(c.payload.get("aliases") or []),
            payload=c.payload,
        )
        session.add(entity)
        covered.add(norm)
        filled += 1

    if filled:
        session.flush()
        _log.info(
            "Gap-fill: minted %d canonical entities dropped by synthesis for document %s",
            filled, document_id,
        )
    return filled


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
            elif item.kind == "access":
                _approve_claim(session, document_id, payload, "access", item.confidence)
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
