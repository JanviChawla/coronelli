from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.domain.world import MapClaim, MapEntity, MapTravelRule
from app.evaluation.oracle import evaluate_atlas

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


# ── Atlas Package export ───────────────────────────────────────────────────────

@router.get("/api/documents/{document_id}/atlas-package")
def export_atlas_package(document_id: str, db: Session = Depends(get_db)) -> JSONResponse:
    from app.db.models import SourceDocument  # noqa: PLC0415
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

    entity_names = {e.id: e.name for e in entities}

    def _resolve(ref_id: str | None, payload_key: str, payload: dict) -> str:
        return payload.get(payload_key) or (entity_names.get(ref_id) if ref_id else "") or ""

    spatial_claims = [
        {
            "id": c.id,
            "subject": _resolve(c.subject_ref, "subject", c.payload),
            "predicate": c.predicate or c.payload.get("predicate", ""),
            "object": _resolve(
                c.object_refs[0] if c.object_refs else None, "object", c.payload
            ),
            "confidence": c.confidence,
        }
        for c in all_claims if c.claim_type == "spatial"
    ]

    visual_claims = [
        {
            "id": c.id,
            "subject": _resolve(c.subject_ref, "subject", c.payload),
            "visual_property": c.payload.get("visual_property", ""),
            "value": c.payload.get("value", ""),
        }
        for c in all_claims if c.claim_type == "visual"
    ]

    package = {
        "version": "1.0",
        "document_id": document_id,
        "document_title": doc.title if doc else document_id,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "entities": [
            {
                "id": e.id,
                "name": e.name,
                "type": e.place_kind,
                "aliases": list(e.aliases or []),
                "notes": e.payload.get("notes"),
            }
            for e in entities
        ],
        "spatial_claims": spatial_claims,
        "visual_claims": visual_claims,
        "routes": [
            {
                "id": r.id,
                "traveler": r.traveler,
                "from": r.payload.get("from") or "",
                "to": r.payload.get("to") or "",
                "route": r.route,
                "can_traverse": r.can_traverse,
                "condition": r.condition,
            }
            for r in travel_rules
        ],
        "statistics": {
            "entity_count": len(entities),
            "spatial_claim_count": len(spatial_claims),
            "visual_claim_count": len(visual_claims),
            "route_count": len(travel_rules),
        },
    }

    slug = (doc.title if doc else document_id)[:32].replace(" ", "-").lower()
    filename = f"atlas-{slug}.json"
    return JSONResponse(
        content=package,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
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
