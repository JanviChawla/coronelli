import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.synthesis.models import SynthesisItem, SynthesisRun
from app.synthesis.provider import SynthesisNotConfiguredError, get_synthesis_provider
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
