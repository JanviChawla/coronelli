import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.api.atlas_read import _discovery, _provenance
from app.db.engine import get_db
from app.db.models import SourceDocument, SourceSection
from app.domain.world import MapClaim, MapEntity, MapTravelRule
from app.extraction.models import Candidate

router = APIRouter(tags=["atlas"])


@router.get("/api/documents/{document_id}/atlas.json")
def export_atlas_json(document_id: str, db: Session = Depends(get_db)) -> JSONResponse:
    doc = db.get(SourceDocument, document_id)

    entities = (
        db.query(MapEntity)
        .filter(MapEntity.provenance_document_id == document_id, MapEntity.state == "active")
        .order_by(MapEntity.name)
        .all()
    )
    all_claims = (
        db.query(MapClaim)
        .filter(MapClaim.provenance_document_id == document_id, MapClaim.state == "active")
        .all()
    )
    travel_rules = (
        db.query(MapTravelRule)
        .filter(MapTravelRule.provenance_document_id == document_id, MapTravelRule.state == "active")
        .all()
    )

    active_entity_ids = {e.id for e in entities}
    entity_by_id = {e.id: e for e in entities}

    located_in: dict[str, str] = {}
    for claim in sorted(all_claims, key=lambda c: 1 if c.status == "manual" else 0):
        if claim.predicate == "CONTAINS":
            if claim.object_refs and claim.object_refs[0] in active_entity_ids:
                contained_id = claim.object_refs[0]
                if claim.subject_ref in entity_by_id:
                    located_in[contained_id] = entity_by_id[claim.subject_ref].name
        elif claim.predicate == "LOCATED_IN" or claim.predicate == "PART_OF":
            if claim.subject_ref in active_entity_ids and claim.object_refs:
                container_id = claim.object_refs[0]
                if container_id in entity_by_id:
                    located_in[claim.subject_ref] = entity_by_id[container_id].name

    _sections = db.query(SourceSection).filter(SourceSection.document_id == document_id).all()
    section_ids = {s.id for s in _sections}
    section_by_id = {s.id: s for s in _sections}
    entity_candidates = (
        db.query(Candidate)
        .filter(
            Candidate.kind == "entity",
            Candidate.status != "rejected",
            Candidate.excerpt != "",
            Candidate.section_id.in_(section_ids),
        )
        .order_by(Candidate.ordinal)
        .all()
    )
    excerpt_by_name: dict[str, str] = {}
    for cand in entity_candidates:
        cname = (cand.payload or {}).get("name", "").lower()
        if cname and cname not in excerpt_by_name and cand.excerpt:
            excerpt_by_name[cname] = cand.excerpt.strip()

    def _first_excerpt(entity: MapEntity) -> str | None:
        exc = excerpt_by_name.get(entity.name.lower())
        if exc:
            return exc
        for alias in (entity.aliases or []):
            exc = excerpt_by_name.get(alias.lower())
            if exc:
                return exc
        return None

    def _id_to_name(eid: str | None) -> str | None:
        return entity_by_id[eid].name if eid and eid in entity_by_id else None

    world_entities = [
        {
            "id": e.id,
            "name": e.name,
            "kind": e.place_kind,
            "kind_descriptor": (e.payload or {}).get("kind_descriptor"),
            "tier": (e.payload or {}).get("tier"),
            "spatial_level": (e.payload or {}).get("spatial_level"),
            "colors": (e.payload or {}).get("colors"),
            "aliases": list(e.aliases or []),
            "located_in": located_in.get(e.id),
            "excerpt": _first_excerpt(e),
            "anchor_count": (e.payload or {}).get("anchor_count", 0),
            "narrative_roles": (e.payload or {}).get("narrative_roles", []),
            "significance": (e.payload or {}).get("significance"),
            "description": (e.payload or {}).get("description"),
            "observations": (e.payload or {}).get("observations", []),
            "first_seen": {
                "section_id": e.provenance_section_id,
                "section_title": section_by_id[e.provenance_section_id].title
                    if e.provenance_section_id in section_by_id else None,
                "section_ordinal": section_by_id[e.provenance_section_id].ordinal
                    if e.provenance_section_id in section_by_id else None,
            } if e.provenance_section_id else None,
        }
        for e in entities
    ]

    spatial_claims = []
    visual_claims = []
    for c in all_claims:
        if not c.subject_ref or not c.predicate:
            continue
        object_id = c.object_refs[0] if c.object_refs else None
        if c.claim_type == "spatial":
            spatial_claims.append({
                "id": c.id,
                "subject": _id_to_name(c.subject_ref) or c.payload.get("subject"),
                "predicate": c.predicate,
                "object": _id_to_name(object_id) or c.payload.get("object"),
                "bidirectional": c.payload.get("bidirectional"),
                "confidence": c.confidence,
                "status": c.status,
                "excerpt": c.excerpt,
            })
        elif c.claim_type == "visual":
            visual_claims.append({
                "id": c.id,
                "subject": _id_to_name(c.subject_ref) or c.payload.get("subject"),
                "visual_property": c.payload.get("visual_property") or c.payload.get("category", ""),
                "value": c.payload.get("value") or c.payload.get("observation", ""),
                "section_title": c.payload.get("section_title", ""),
                "palette": c.payload.get("palette"),
                "permanent": c.payload.get("permanent"),
                "view": c.payload.get("view"),
                "confidence": c.confidence,
                "status": c.status,
            })

    routes = [
        {
            "id": r.id,
            "traveler": r.traveler,
            "from": r.payload.get("from"),
            "to": r.payload.get("to"),
            "via": r.payload.get("via"),
            "can_traverse": r.can_traverse,
            "condition": r.condition,
            "bidirectional": r.payload.get("bidirectional"),
            "transport_mode": r.payload.get("transport_mode"),
            "notes": r.payload.get("notes"),
        }
        for r in travel_rules
    ]

    package = {
        "format": "coronelli-atlas-v1",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "document": {
            "id": document_id,
            "title": doc.title if doc else document_id,
        },
        "entities": world_entities,
        "spatial_claims": spatial_claims,
        "visual_claims": visual_claims,
        "routes": routes,
    }

    raw_slug = re.sub(r'[^a-z0-9]+', '-', (doc.title if doc else document_id).lower()).strip('-')
    filename = f"atlas-{raw_slug[:40]}.json"
    return JSONResponse(
        content=package,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/api/documents/{document_id}/atlas-package")
def export_atlas_package(document_id: str, db: Session = Depends(get_db)) -> JSONResponse:
    doc = db.get(SourceDocument, document_id)

    sections = (
        db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .order_by(SourceSection.ordinal)
        .all()
    )

    entities = (
        db.query(MapEntity)
        .filter(MapEntity.provenance_document_id == document_id, MapEntity.state == "active")
        .order_by(MapEntity.name)
        .all()
    )
    all_claims = (
        db.query(MapClaim)
        .filter(MapClaim.provenance_document_id == document_id, MapClaim.state == "active")
        .all()
    )
    travel_rules = (
        db.query(MapTravelRule)
        .filter(MapTravelRule.provenance_document_id == document_id, MapTravelRule.state == "active")
        .all()
    )

    entity_by_id: dict[str, MapEntity] = {e.id: e for e in entities}
    entity_id_by_name: dict[str, str] = {e.name.lower(): e.id for e in entities}
    for e in entities:
        for alias in (e.aliases or []):
            if alias.lower() not in entity_id_by_name:
                entity_id_by_name[alias.lower()] = e.id

    def _name_to_id(name: str | None) -> str | None:
        return entity_id_by_name.get(name.lower()) if name else None

    def _id_to_name(entity_id: str | None) -> str | None:
        return entity_by_id[entity_id].name if entity_id and entity_id in entity_by_id else None

    manifest = {
        "package_id": str(uuid.uuid4()),
        "format_version": "atlas-package-v0.1",
        "profile": "single-file-json",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "generator": "coronelli",
        "entity_count": len(entities),
        "claim_count": len(all_claims),
        "route_count": len(travel_rules),
        "source_count": 1,
    }

    sources = [
        {
            "document_id": document_id,
            "title": doc.title if doc else document_id,
            "sections": [
                {
                    "section_id": s.id,
                    "ordinal": s.ordinal,
                    "title": s.title,
                }
                for s in sections
            ],
        }
    ]

    world_entities = []
    for e in entities:
        world_entities.append({
            "id": e.id,
            "name": e.name,
            "type": e.place_kind,
            "aliases": list(e.aliases or []),
            "status": e.status,
            "provenance": _provenance(e.provenance_document_id, e.provenance_section_id),
            "discovery": _discovery(e),
            "notes": e.payload.get("notes"),
        })

    spatial_claims = []
    visual_claims = []
    for c in all_claims:
        object_id = c.object_refs[0] if c.object_refs else None
        prov = _provenance(c.provenance_document_id, c.provenance_section_id)

        if c.claim_type == "spatial":
            spatial_claims.append({
                "id": c.id,
                "subject_id": c.subject_ref,
                "subject_name": _id_to_name(c.subject_ref) or c.payload.get("subject"),
                "predicate": c.predicate or c.payload.get("predicate"),
                "object_id": object_id,
                "object_name": _id_to_name(object_id) or c.payload.get("object"),
                "status": c.status,
                "confidence": c.confidence,
                "provenance": prov,
                "excerpt": c.excerpt,
            })
        elif c.claim_type == "visual":
            visual_claims.append({
                "id": c.id,
                "subject_id": c.subject_ref,
                "subject_name": _id_to_name(c.subject_ref) or c.payload.get("subject"),
                "visual_property": c.payload.get("visual_property") or c.payload.get("category", ""),
                "value": c.payload.get("value") or c.payload.get("observation", ""),
                "status": c.status,
                "provenance": prov,
            })

    world_routes = []
    for r in travel_rules:
        from_name = r.payload.get("from")
        to_name = r.payload.get("to")
        via_name = r.payload.get("via")
        world_routes.append({
            "id": r.id,
            "traveler": r.traveler,
            "from_id": _name_to_id(from_name),
            "from_name": from_name,
            "to_id": _name_to_id(to_name),
            "to_name": to_name,
            "via_id": _name_to_id(via_name),
            "via_name": via_name,
            "can_traverse": r.can_traverse,
            "condition": r.condition,
            "provenance": _provenance(r.provenance_document_id, r.provenance_section_id),
        })

    package = {
        "format": "atlas-package-v0.1-single",
        "manifest": manifest,
        "sources": sources,
        "world": {
            "entities": world_entities,
            "spatial_claims": spatial_claims,
            "visual_claims": visual_claims,
            "routes": world_routes,
        },
    }

    slug = (doc.title if doc else document_id)[:32].replace(" ", "-").lower()
    filename = f"atlas-{slug}-v0.1.json"
    return JSONResponse(
        content=package,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
