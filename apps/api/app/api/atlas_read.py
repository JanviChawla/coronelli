from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.db.models import SourceSection
from app.domain.world import EntityMention, MapClaim, MapEntity, MapTravelRule
from app.extraction.models import Candidate

router = APIRouter(tags=["atlas"])


# ── Shared provenance helpers ─────────────────────────────────────────────────

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


# ── Output models ─────────────────────────────────────────────────────────────

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


class EntityMentionOut(BaseModel):
    id: str
    entity_id: str
    document_id: str
    section_id: str
    section_ordinal: int
    mention_kind: str

    model_config = {"from_attributes": True}


# ── GET /atlas ────────────────────────────────────────────────────────────────

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

    active_entity_ids = {e.id for e in entities}

    claims_by_entity: dict[str, list[MapClaim]] = {}
    for claim in sorted(all_claims, key=lambda c: 0 if c.status == "manual" else 1):
        if not claim.subject_ref:
            continue
        if not claim.predicate and claim.claim_type != "visual":
            continue
        if claim.object_refs and claim.subject_ref in claim.object_refs:
            continue
        if claim.object_refs and not all(oid in active_entity_ids for oid in claim.object_refs):
            continue
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


# ── GET /entity-mentions ──────────────────────────────────────────────────────

@router.get("/api/documents/{document_id}/entity-mentions", response_model=list[EntityMentionOut])
def get_entity_mentions(document_id: str, db: Session = Depends(get_db)) -> list[EntityMentionOut]:
    mentions = (
        db.query(EntityMention)
        .filter(EntityMention.document_id == document_id)
        .order_by(EntityMention.section_ordinal)
        .all()
    )
    return [EntityMentionOut.model_validate(m) for m in mentions]


# ── GET /atlas/entities/{id}/excerpts ─────────────────────────────────────────

@router.get("/api/documents/{document_id}/atlas/entities/{entity_id}/excerpts")
def get_entity_excerpts(document_id: str, entity_id: str, db: Session = Depends(get_db)):
    from fastapi import HTTPException

    entity = db.get(MapEntity, entity_id)
    if not entity or entity.provenance_document_id != document_id:
        raise HTTPException(status_code=404, detail="Entity not found")

    names = {entity.name.lower()}
    for alias in (entity.aliases or []):
        names.add(alias.lower())

    section_ids = {s.id for s in db.query(SourceSection.id).filter(SourceSection.document_id == document_id).all()}

    all_candidates = (
        db.query(Candidate, SourceSection)
        .join(SourceSection, Candidate.section_id == SourceSection.id, isouter=True)
        .filter(
            Candidate.kind == "entity",
            Candidate.status != "rejected",
            Candidate.excerpt != "",
            Candidate.section_id.in_(section_ids),
        )
        .all()
    )

    seen_excerpts: set[str] = set()
    results = []
    for candidate, section in all_candidates:
        cname = (candidate.payload or {}).get("name", "")
        if cname.lower() not in names:
            continue
        exc = (candidate.excerpt or "").strip()
        if not exc or exc in seen_excerpts:
            continue
        seen_excerpts.add(exc)
        results.append({
            "excerpt": exc,
            "section_title": section.title if section else None,
            "section_ordinal": section.ordinal if section else None,
        })

    results.sort(key=lambda r: r["section_ordinal"] or 0)
    return results

