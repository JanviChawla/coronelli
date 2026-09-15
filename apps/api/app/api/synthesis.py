import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.domain.world import MapClaim, MapEntity, MapTravelRule
from app.synthesis.models import SynthesisItem, SynthesisRun
from app.synthesis.provider import SynthesisNotConfiguredError, get_synthesis_provider
from app.synthesis.review import SynthesisReviewError, approve_all_synthesis_entities, review_synthesis_item
from app.synthesis.service import run_synthesis

router = APIRouter(tags=["synthesis"])
_log = logging.getLogger(__name__)


class SynthesisRunOut(BaseModel):
    id: str
    document_id: str
    status: str
    provider: str
    model: str
    synthesis_prompt_version: str
    evidence_hash: str | None
    started_at: datetime
    completed_at: datetime | None
    from_cache: bool

    model_config = {"from_attributes": True}


class SynthesisItemOut(BaseModel):
    id: str
    synthesis_run_id: str
    document_id: str
    kind: str
    payload: dict
    review_state: str
    confidence: float | None
    rationale: str | None
    ordinal: int
    display_summary: str

    model_config = {"from_attributes": True}


class MapEntityOut(BaseModel):
    id: str
    name: str
    entity_kind: str
    place_kind: str | None
    aliases: list | None
    state: str

    model_config = {"from_attributes": True}


class MapClaimOut(BaseModel):
    id: str
    claim_type: str
    predicate: str | None
    state: str

    model_config = {"from_attributes": True}


class MapTravelRuleOut(BaseModel):
    id: str
    traveler: str | None
    route: str | None
    can_traverse: bool | None
    state: str

    model_config = {"from_attributes": True}


class SynthesisReviewRequest(BaseModel):
    action: str  # approve | reject | defer


class SynthesisReviewResponse(BaseModel):
    item: SynthesisItemOut
    created_entity: MapEntityOut | None
    created_claim: MapClaimOut | None
    created_travel_rule: MapTravelRuleOut | None


class SynthesisResponse(BaseModel):
    run: SynthesisRunOut
    items: list[SynthesisItemOut]
    item_count: int
    from_cache: bool


class ProvisionalAtlasResponse(BaseModel):
    document_id: str
    run_id: str | None
    items: list[SynthesisItemOut]
    item_count: int


@router.post("/api/documents/{document_id}/synthesize", response_model=SynthesisResponse, status_code=201)
def synthesize_document(
    document_id: str,
    force: bool = Query(default=False, description="Re-run even if a cached result exists."),
    db: Session = Depends(get_db),
) -> SynthesisResponse:
    try:
        provider = get_synthesis_provider()
    except SynthesisNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    cached_before = (
        db.query(SynthesisRun)
        .filter(SynthesisRun.document_id == document_id, SynthesisRun.status == "completed")
        .first()
    )

    try:
        run, items = run_synthesis(db, document_id, provider, force=force)
    except Exception as exc:
        _log.exception("Synthesis failed for document %s", document_id)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    from_cache = cached_before is not None and run.id == cached_before.id

    return SynthesisResponse(
        run=SynthesisRunOut(
            id=run.id,
            document_id=run.document_id,
            status=run.status,
            provider=run.provider,
            model=run.model,
            synthesis_prompt_version=run.synthesis_prompt_version,
            evidence_hash=run.evidence_hash,
            started_at=run.started_at,
            completed_at=run.completed_at,
            from_cache=from_cache,
        ),
        items=[SynthesisItemOut.model_validate(item) for item in items],
        item_count=len(items),
        from_cache=from_cache,
    )


@router.get("/api/documents/{document_id}/provisional-atlas", response_model=ProvisionalAtlasResponse)
def get_provisional_atlas(
    document_id: str,
    db: Session = Depends(get_db),
) -> ProvisionalAtlasResponse:
    run = (
        db.query(SynthesisRun)
        .filter(SynthesisRun.document_id == document_id, SynthesisRun.status == "completed")
        .order_by(SynthesisRun.started_at.desc())
        .first()
    )

    if run is None:
        return ProvisionalAtlasResponse(
            document_id=document_id,
            run_id=None,
            items=[],
            item_count=0,
        )

    items = (
        db.query(SynthesisItem)
        .filter(SynthesisItem.synthesis_run_id == run.id)
        .order_by(SynthesisItem.ordinal)
        .all()
    )

    return ProvisionalAtlasResponse(
        document_id=document_id,
        run_id=run.id,
        items=[SynthesisItemOut.model_validate(item) for item in items],
        item_count=len(items),
    )


@router.post("/api/synthesis-items/{item_id}/review", response_model=SynthesisReviewResponse)
def review_item(
    item_id: str,
    body: SynthesisReviewRequest,
    db: Session = Depends(get_db),
) -> SynthesisReviewResponse:
    try:
        result = review_synthesis_item(db, item_id, body.action)
    except SynthesisReviewError as exc:
        msg = str(exc)
        code = 404 if "not found" in msg else 422
        raise HTTPException(status_code=code, detail=msg) from exc

    return SynthesisReviewResponse(
        item=SynthesisItemOut.model_validate(result.item),
        created_entity=MapEntityOut.model_validate(result.created_entity) if result.created_entity else None,
        created_claim=MapClaimOut.model_validate(result.created_claim) if result.created_claim else None,
        created_travel_rule=MapTravelRuleOut.model_validate(result.created_travel_rule) if result.created_travel_rule else None,
    )


@router.post("/api/documents/{document_id}/synthesis-items/approve-entities", status_code=200)
def batch_approve_entities(
    document_id: str,
    db: Session = Depends(get_db),
) -> dict:
    approved = approve_all_synthesis_entities(db, document_id)
    return {"approved": approved, "document_id": document_id}
