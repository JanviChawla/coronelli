import logging

from sqlalchemy.orm import Session

from app.db.models import SourceSection
from app.domain.world import EntityMention, MapEntity
from app.extraction.models import Candidate

_log = logging.getLogger(__name__)


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


def apply_scene_anchor_counts(session: Session, document_id: str) -> None:
    """Tally scene_anchor candidates per entity and write anchor_count to entity payload.

    Each section's spatial pass emits one scene_anchor for the primary setting.
    Counting how many sections anchor on each place gives the clearest signal of
    narrative centrality — far more reliable than any heuristic we could compute later.
    """
    sections = (
        session.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .all()
    )
    section_ids = [s.id for s in sections]
    if not section_ids:
        return

    anchor_candidates = (
        session.query(Candidate)
        .filter(
            Candidate.section_id.in_(section_ids),
            Candidate.kind == "scene_anchor",
        )
        .all()
    )
    if not anchor_candidates:
        return

    # Count anchors and collect narrative roles per raw place name
    counts: dict[str, int] = {}
    roles: dict[str, list[str]] = {}
    for c in anchor_candidates:
        place_name = (c.payload.get("place") or "").strip()
        if place_name:
            counts[place_name] = counts.get(place_name, 0) + 1
            role = (c.payload.get("narrative_role") or "").strip()
            if role:
                roles.setdefault(place_name, []).append(role)

    # Build name→entity lookup including aliases
    entities = (
        session.query(MapEntity)
        .filter(MapEntity.provenance_document_id == document_id, MapEntity.state == "active")
        .all()
    )
    entity_by_name: dict[str, MapEntity] = {}
    for e in entities:
        entity_by_name[e.name.lower()] = e
        for alias in (e.aliases or []):
            if alias and alias.lower() not in entity_by_name:
                entity_by_name[alias.lower()] = e

    resolved = 0
    for place_name, count in counts.items():
        pnl = place_name.lower()
        entity = entity_by_name.get(pnl)
        if entity is None:
            # Substring fallback: "the Great Hall" → "Great Hall"
            for en, ent in entity_by_name.items():
                if pnl in en or en in pnl:
                    entity = ent
                    break
        if entity:
            prev = (entity.payload or {}).get("anchor_count", 0)
            new_payload = {**(entity.payload or {}), "anchor_count": max(prev, count)}
            place_roles = roles.get(place_name, [])
            if place_roles:
                existing = new_payload.get("narrative_roles") or []
                merged = list(dict.fromkeys(existing + place_roles))
                new_payload["narrative_roles"] = merged
            entity.payload = new_payload
            resolved += 1

    session.flush()
    _log.info(
        "Scene anchor counts: %d unique place names → %d entities resolved for document %s",
        len(counts), resolved, document_id,
    )


def apply_catalog_fields(session: Session, document_id: str) -> None:
    """Copy significance and description (from catalog note) into entity payload.

    Synthesis entity consolidation doesn't forward significance or note — this
    pass fills them from the highest-confidence non-rejected catalog candidate
    for each entity, ensuring every entity has these fields regardless of how
    it was created (synthesis vs. gap-fill).
    """
    sections = (
        session.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .all()
    )
    section_ids = [s.id for s in sections]
    if not section_ids:
        return

    candidates = (
        session.query(Candidate)
        .filter(
            Candidate.section_id.in_(section_ids),
            Candidate.kind == "entity",
            Candidate.review_state != "rejected",
        )
        .order_by(Candidate.confidence.desc())
        .all()
    )

    sig_by_name: dict[str, str] = {}
    note_by_name: dict[str, str] = {}
    kd_by_name: dict[str, str] = {}
    for c in candidates:
        p = c.payload or {}
        name = (p.get("name") or "").strip().lower()
        if not name:
            continue
        sig = (p.get("significance") or "").strip()
        if sig and name not in sig_by_name:
            sig_by_name[name] = sig
        note = (p.get("note") or "").strip()
        if note and name not in note_by_name:
            note_by_name[name] = note
        kd = (p.get("kind_descriptor") or "").strip()
        if kd and name not in kd_by_name:
            kd_by_name[name] = kd

    if not sig_by_name and not note_by_name and not kd_by_name:
        return

    entities = (
        session.query(MapEntity)
        .filter(MapEntity.provenance_document_id == document_id, MapEntity.state == "active")
        .all()
    )

    filled = 0
    for entity in entities:
        payload = dict(entity.payload or {})
        changed = False
        lookup = [entity.name.lower()] + [a.lower() for a in (entity.aliases or []) if a]

        if not payload.get("significance"):
            for n in lookup:
                if n in sig_by_name:
                    payload["significance"] = sig_by_name[n]
                    changed = True
                    break

        if not payload.get("description"):
            for n in lookup:
                if n in note_by_name:
                    payload["description"] = note_by_name[n]
                    changed = True
                    break

        if not payload.get("kind_descriptor"):
            for n in lookup:
                if n in kd_by_name:
                    payload["kind_descriptor"] = kd_by_name[n]
                    changed = True
                    break

        if changed:
            entity.payload = payload
            filled += 1

    if filled:
        session.flush()
    _log.info(
        "Catalog fields: enriched %d entities with significance/description for document %s",
        filled, document_id,
    )


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
