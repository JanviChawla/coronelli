import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.db.models import SourceDocument, SourceSection
from app.domain.world import EntityMention, MapClaim, MapEntity, MapTravelRule
from app.evaluation.oracle import evaluate_atlas

router = APIRouter(tags=["atlas"])


# ── Shared provenance helper ───────────────────────────────────────────────────

def _provenance(document_id: str | None, section_id: str | None) -> dict:
    return {"document_id": document_id, "section_id": section_id}


def _discovery(entity: MapEntity) -> dict | None:
    if not entity.provenance_section_id:
        return None
    return {
        "becomes_visible_at": _provenance(
            entity.provenance_document_id, entity.provenance_section_id
        ),
        "visibility_policy": "not-rendered-before-discovery",
    }


# ── Internal atlas API ─────────────────────────────────────────────────────────

class ClaimOut(BaseModel):
    id: str
    claim_type: str
    predicate: str | None
    subject_ref: str | None
    object_refs: list | None
    payload: dict
    confidence: float | None
    excerpt: str | None = None
    status: str = "explicit"
    provenance: dict

    model_config = {"from_attributes": True}


class AtlasEntityOut(BaseModel):
    id: str
    name: str
    place_kind: str | None
    aliases: list | None
    state: str
    status: str
    provenance_document_id: str | None
    provenance_section_id: str | None
    provenance: dict
    discovery: dict | None
    payload: dict
    claims: list[ClaimOut]


class TravelRuleOut(BaseModel):
    id: str
    traveler: str | None
    route: str | None
    can_traverse: bool | None
    condition: str | None
    payload: dict

    model_config = {"from_attributes": True}


class AtlasResponse(BaseModel):
    document_id: str
    entities: list[AtlasEntityOut]
    travel_rules: list[TravelRuleOut]
    entity_count: int
    claim_count: int
    travel_rule_count: int


@router.get("/api/documents/{document_id}/atlas", response_model=AtlasResponse)
def get_atlas(document_id: str, db: Session = Depends(get_db)) -> AtlasResponse:
    entities = (
        db.query(MapEntity)
        .filter(
            MapEntity.provenance_document_id == document_id,
            MapEntity.state == "active",
        )
        .order_by(MapEntity.name)
        .all()
    )

    all_claims = (
        db.query(MapClaim)
        .filter(
            MapClaim.provenance_document_id == document_id,
            MapClaim.state == "active",
        )
        .all()
    )

    travel_rules = (
        db.query(MapTravelRule)
        .filter(
            MapTravelRule.provenance_document_id == document_id,
            MapTravelRule.state == "active",
        )
        .all()
    )

    claims_by_entity: dict[str, list[MapClaim]] = {}
    for claim in all_claims:
        if claim.subject_ref:
            claims_by_entity.setdefault(claim.subject_ref, []).append(claim)

    entity_outs = [
        AtlasEntityOut(
            id=e.id,
            name=e.name,
            place_kind=e.place_kind,
            aliases=e.aliases,
            state=e.state,
            status=e.status,
            provenance_document_id=e.provenance_document_id,
            provenance_section_id=e.provenance_section_id,
            provenance=_provenance(e.provenance_document_id, e.provenance_section_id),
            discovery=_discovery(e),
            payload=e.payload,
            claims=[
                ClaimOut(
                    id=c.id,
                    claim_type=c.claim_type,
                    predicate=c.predicate,
                    subject_ref=c.subject_ref,
                    object_refs=c.object_refs,
                    payload=c.payload,
                    confidence=c.confidence,
                    excerpt=c.excerpt,
                    status=c.status,
                    provenance=_provenance(c.provenance_document_id, c.provenance_section_id),
                )
                for c in claims_by_entity.get(e.id, [])
            ],
        )
        for e in entities
    ]

    return AtlasResponse(
        document_id=document_id,
        entities=entity_outs,
        travel_rules=[TravelRuleOut.model_validate(r) for r in travel_rules],
        entity_count=len(entities),
        claim_count=len(all_claims),
        travel_rule_count=len(travel_rules),
    )


# ── Entity mentions ───────────────────────────────────────────────────────────

class EntityMentionOut(BaseModel):
    id: str
    entity_id: str
    document_id: str
    section_id: str
    section_ordinal: int
    mention_kind: str

    model_config = {"from_attributes": True}


@router.get("/api/documents/{document_id}/entity-mentions", response_model=list[EntityMentionOut])
def get_entity_mentions(document_id: str, db: Session = Depends(get_db)) -> list[EntityMentionOut]:
    mentions = (
        db.query(EntityMention)
        .filter(EntityMention.document_id == document_id)
        .order_by(EntityMention.section_ordinal)
        .all()
    )
    return [EntityMentionOut.model_validate(m) for m in mentions]


# ── Atlas Package v0.1 export ──────────────────────────────────────────────────

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

    # Build lookup tables
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

    # ── Manifest ────────────────────────────────────────────────────────────────
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

    # ── Sources ─────────────────────────────────────────────────────────────────
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

    # ── World — entities ────────────────────────────────────────────────────────
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

    # ── World — claims ──────────────────────────────────────────────────────────
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

    # ── World — routes ──────────────────────────────────────────────────────────
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


# ── Place suggestions (autocomplete from section text) ───────────────────────

_CAP_SEQUENCE = re.compile(r'\b([A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,}){0,3})\b')
_COMMON_STARTERS = {
    "The", "A", "An", "In", "On", "At", "By", "He", "She", "They", "It", "We",
    "I", "You", "His", "Her", "Its", "Their", "Our", "My", "This", "That",
    "Then", "When", "But", "And", "Or", "So", "As", "If", "Up", "Down",
    "Now", "All", "No", "Not", "There", "Here", "With", "From", "For",
    "After", "Before", "Into", "Over", "Out", "Was", "Were", "Had",
    "Has", "Have", "Could", "Would", "Should", "May", "Might", "Will",
}


@router.get("/api/documents/{document_id}/place-suggestions", response_model=list[str])
def get_place_suggestions(document_id: str, db: Session = Depends(get_db)) -> list[str]:
    sections = (
        db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .order_by(SourceSection.ordinal)
        .all()
    )
    suggestions: set[str] = set()
    for section in sections:
        text = section.content or ""
        for m in _CAP_SEQUENCE.finditer(text):
            phrase = m.group(1).strip()
            first_word = phrase.split()[0]
            if first_word in _COMMON_STARTERS:
                continue
            if len(phrase) >= 3:
                suggestions.add(phrase)
    return sorted(suggestions)


# ── Manual entity creation ────────────────────────────────────────────────────

class ManualEntityRequest(BaseModel):
    name: str
    type: str | None = None
    spatial_level: int | None = None


class ManualEntityResponse(BaseModel):
    id: str
    name: str


@router.post("/api/documents/{document_id}/manual-entity", response_model=ManualEntityResponse)
def add_manual_entity(document_id: str, body: ManualEntityRequest, db: Session = Depends(get_db)):
    from fastapi import HTTPException
    from app.extraction.models import Candidate, ExtractionRun

    if not body.name or not body.name.strip():
        raise HTTPException(status_code=422, detail="name is required")

    first_section = (
        db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .order_by(SourceSection.ordinal)
        .first()
    )
    if not first_section:
        raise HTTPException(status_code=404, detail="Document has no sections")

    # Find or create the manual stub ExtractionRun for this document (keyed by section)
    stub_run = (
        db.query(ExtractionRun)
        .filter(
            ExtractionRun.section_id == first_section.id,
            ExtractionRun.status == "manual",
        )
        .first()
    )
    if not stub_run:
        now = datetime.now(timezone.utc)
        stub_run = ExtractionRun(
            section_id=first_section.id,
            status="manual",
            provider="manual",
            model="manual",
            prompt_version="manual-entry",
            started_at=now,
            completed_at=now,
        )
        db.add(stub_run)
        db.flush()

    payload: dict = {"name": body.name.strip(), "type": body.type or "place", "aliases": []}
    if body.spatial_level is not None:
        payload["spatial_level"] = body.spatial_level

    candidate = Candidate(
        extraction_run_id=stub_run.id,
        section_id=first_section.id,
        kind="entity",
        payload=payload,
        status="explicit",
        confidence=1.0,
        excerpt="",
        rationale="Manually added by user",
        review_state="approved",
        ordinal=9999,
        source="manual",
    )
    db.add(candidate)
    db.commit()

    return ManualEntityResponse(id=candidate.id, name=body.name.strip())


# ── Entity merge ──────────────────────────────────────────────────────────────

class EntityMergeRequest(BaseModel):
    keep_id: str   # stays active, gains aliases
    drop_id: str   # becomes alias, state → "merged"


class EntityMergeResponse(BaseModel):
    merged: bool
    canonical_entity_id: str
    canonical_entity_name: str
    new_aliases: list[str]


@router.post("/api/entities/merge", response_model=EntityMergeResponse)
def merge_entities(body: EntityMergeRequest, db: Session = Depends(get_db)):
    from fastapi import HTTPException
    keep = db.get(MapEntity, body.keep_id)
    drop = db.get(MapEntity, body.drop_id)
    if not keep or not drop:
        raise HTTPException(status_code=404, detail="One or both entities not found")
    if keep.id == drop.id:
        raise HTTPException(status_code=422, detail="Cannot merge an entity with itself")
    if keep.state != "active" or drop.state != "active":
        raise HTTPException(status_code=422, detail="Both entities must be active")

    # Absorb drop's name and aliases into keep's alias list
    new_aliases = list(keep.aliases or [])
    for name in [drop.name, *(drop.aliases or [])]:
        if name and name != keep.name and name not in new_aliases:
            new_aliases.append(name)
    keep.aliases = new_aliases

    # Redirect active claims: subject_ref
    db.query(MapClaim).filter(
        MapClaim.subject_ref == body.drop_id,
        MapClaim.state == "active",
    ).update({"subject_ref": body.keep_id}, synchronize_session=False)

    # Redirect active claims: object_refs (JSON array — must iterate in Python)
    object_claims = (
        db.query(MapClaim)
        .filter(MapClaim.state == "active")
        .all()
    )
    for c in object_claims:
        if c.object_refs and body.drop_id in c.object_refs:
            c.object_refs = [body.keep_id if r == body.drop_id else r for r in c.object_refs]

    drop.state = "merged"
    db.commit()
    db.refresh(keep)

    return EntityMergeResponse(
        merged=True,
        canonical_entity_id=keep.id,
        canonical_entity_name=keep.name,
        new_aliases=new_aliases,
    )


# ── Oracle evaluation ──────────────────────────────────────────────────────────

class OracleRequest(BaseModel):
    expected_entities: list[str]
    expected_claims: list[dict] = []


class OracleResultOut(BaseModel):
    document_id: str
    entity_recall: float
    entity_precision: float
    found_entities: list[str]
    missed_entities: list[str]
    extra_entities: list[str]
    claim_recall: float | None
    found_claims: list[dict]
    missed_claims: list[dict]


@router.post("/api/documents/{document_id}/atlas/evaluate", response_model=OracleResultOut)
def evaluate_document_atlas(
    document_id: str,
    body: OracleRequest,
    db: Session = Depends(get_db),
) -> OracleResultOut:
    entities = (
        db.query(MapEntity)
        .filter(MapEntity.provenance_document_id == document_id, MapEntity.state == "active")
        .all()
    )
    approved_names = [e.name for e in entities]

    all_claims = (
        db.query(MapClaim)
        .filter(
            MapClaim.provenance_document_id == document_id,
            MapClaim.state == "active",
            MapClaim.claim_type == "spatial",
        )
        .all()
    )
    approved_claims = [
        {
            "subject": c.payload.get("subject", ""),
            "predicate": c.predicate or "",
            "object": c.payload.get("object", ""),
        }
        for c in all_claims
    ]

    result = evaluate_atlas(
        approved_names=approved_names,
        oracle_names=body.expected_entities,
        approved_claims=approved_claims,
        oracle_claims=body.expected_claims if body.expected_claims else None,
    )

    return OracleResultOut(
        document_id=document_id,
        entity_recall=result.entity_recall,
        entity_precision=result.entity_precision,
        found_entities=result.found_entities,
        missed_entities=result.missed_entities,
        extra_entities=result.extra_entities,
        claim_recall=result.claim_recall,
        found_claims=result.found_claims,
        missed_claims=result.missed_claims,
    )
