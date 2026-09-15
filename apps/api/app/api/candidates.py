from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.domain.review import ReviewError, ReviewEvent, review_candidate as _review_candidate
from app.domain.world import MapClaim, MapEntity
from app.extraction.models import Candidate

router = APIRouter(tags=["candidates"])


# ── Pydantic response models ──────────────────────────────────────────────────

class CandidateOut(BaseModel):
    id: str
    extraction_run_id: str
    section_id: str
    kind: str
    payload: dict
    status: str
    confidence: float
    excerpt: str
    rationale: str
    review_state: str
    ordinal: int
    temporal_interpretation: str
    first_revealed_at_section_id: str | None
    relation_kind: str | None
    relation_target_id: str | None

    model_config = {"from_attributes": True}


class MapEntityOut(BaseModel):
    id: str
    name: str
    entity_kind: str
    place_kind: str | None
    parent_id: str | None
    map_behavior: str | None
    status: str
    state: str
    provenance_document_id: str | None
    provenance_section_id: str | None
    candidate_id: str | None
    payload: dict
    created_at: datetime

    model_config = {"from_attributes": True}


class MapClaimOut(BaseModel):
    id: str
    claim_type: str
    subject_ref: str | None
    predicate: str | None
    object_refs: list | None
    status: str
    confidence: float | None
    provenance_document_id: str | None
    provenance_section_id: str | None
    excerpt: str | None
    state: str
    candidate_id: str | None
    payload: dict
    created_at: datetime

    model_config = {"from_attributes": True}


class ReviewEventOut(BaseModel):
    id: str
    candidate_id: str
    action: str
    before_payload: dict | None
    after_payload: dict | None
    merge_target_id: str | None
    rationale: str | None
    canonical_entity_id: str | None
    canonical_claim_id: str | None
    canonical_travel_rule_id: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ReviewRequest(BaseModel):
    action: str
    edited_payload: dict | None = None
    merge_target_id: str | None = None
    rationale: str | None = None


class ReviewResponse(BaseModel):
    event: ReviewEventOut
    canonical_entity: MapEntityOut | None
    canonical_claim: MapClaimOut | None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/api/sections/{section_id}/candidates", response_model=list[CandidateOut])
def list_section_candidates(section_id: str, db: Session = Depends(get_db)):
    candidates = (
        db.query(Candidate)
        .filter(Candidate.section_id == section_id)
        .order_by(Candidate.ordinal)
        .all()
    )
    return [CandidateOut.model_validate(c) for c in candidates]


@router.get("/api/candidates/{candidate_id}", response_model=CandidateOut)
def get_candidate(candidate_id: str, db: Session = Depends(get_db)):
    candidate = db.get(Candidate, candidate_id)
    if candidate is None:
        raise HTTPException(status_code=404, detail=f"Candidate '{candidate_id}' not found.")
    return CandidateOut.model_validate(candidate)


@router.post("/api/candidates/{candidate_id}/review", response_model=ReviewResponse, status_code=200)
def review(candidate_id: str, body: ReviewRequest, db: Session = Depends(get_db)):
    try:
        result = _review_candidate(
            db,
            candidate_id,
            action=body.action,
            edited_payload=body.edited_payload,
            merge_target_id=body.merge_target_id,
            rationale=body.rationale,
        )
    except ReviewError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        raise HTTPException(status_code=422, detail=msg) from exc

    return ReviewResponse(
        event=ReviewEventOut.model_validate(result.event),
        canonical_entity=MapEntityOut.model_validate(result.canonical_entity)
        if result.canonical_entity else None,
        canonical_claim=MapClaimOut.model_validate(result.canonical_claim)
        if result.canonical_claim else None,
    )


@router.post("/api/sections/{section_id}/candidates/approve-all", status_code=200)
def approve_all_section_candidates(section_id: str, db: Session = Depends(get_db)):
    proposed = (
        db.query(Candidate)
        .filter(Candidate.section_id == section_id, Candidate.review_state == "proposed")
        .order_by(Candidate.ordinal)
        .all()
    )
    approved = 0
    for c in proposed:
        try:
            _review_candidate(db, c.id, action="approve")
            approved += 1
        except ReviewError:
            pass
    return {"approved": approved, "section_id": section_id}


@router.get("/api/map-entities", response_model=list[MapEntityOut])
def list_map_entities(db: Session = Depends(get_db)):
    entities = db.query(MapEntity).filter(MapEntity.state == "active").order_by(MapEntity.name).all()
    return [MapEntityOut.model_validate(e) for e in entities]


@router.get("/api/map-claims", response_model=list[MapClaimOut])
def list_map_claims(db: Session = Depends(get_db)):
    claims = db.query(MapClaim).filter(MapClaim.state == "active").all()
    return [MapClaimOut.model_validate(c) for c in claims]
