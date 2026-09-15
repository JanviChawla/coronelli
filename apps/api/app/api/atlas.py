from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.domain.world import MapClaim, MapEntity, MapTravelRule

router = APIRouter(tags=["atlas"])


class ClaimOut(BaseModel):
    id: str
    claim_type: str
    predicate: str | None
    subject_ref: str | None
    object_refs: list | None
    payload: dict
    confidence: float | None

    model_config = {"from_attributes": True}


class AtlasEntityOut(BaseModel):
    id: str
    name: str
    place_kind: str | None
    aliases: list | None
    state: str
    provenance_section_id: str | None
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
            provenance_section_id=e.provenance_section_id,
            payload=e.payload,
            claims=[ClaimOut.model_validate(c) for c in claims_by_entity.get(e.id, [])],
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
