import hashlib
import os
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.db.models import SourceSection
from app.domain.world import MapEntity
from app.extraction.models import Candidate, ExtractionRun
from app.extraction.openai_provider import ExtractionNotConfiguredError, get_provider
from app.extraction.prompts import (
    COMBINED_PROMPT_VERSION,
    CATALOG_SYSTEM_PROMPT, CATALOG_USER_TEMPLATE,
    EVIDENCE_SYSTEM_PROMPT, EVIDENCE_USER_TEMPLATE,
)
from app.extraction.service import ExtractionError, _COST_PER_TOKEN, _section_content_hash, run_extraction

router = APIRouter(tags=["extraction"])

_PREFLIGHT_OUTPUT_TOKEN_ESTIMATE = 200  # conservative output estimate for cost preview


class RunResponse(BaseModel):
    id: str
    section_id: str
    status: str
    provider: str
    model: str
    prompt_version: str
    error: str | None
    started_at: datetime
    completed_at: datetime | None
    input_tokens: int | None
    output_tokens: int | None
    estimated_cost_usd: float | None
    section_content_hash: str | None

    model_config = {"from_attributes": True}


class CandidateResponse(BaseModel):
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
    display_summary: str

    model_config = {"from_attributes": True}


class ExtractResponse(BaseModel):
    run: RunResponse
    candidates: list[CandidateResponse]
    from_cache: bool


class PreflightResponse(BaseModel):
    section_id: str
    title: str | None
    sections_to_send: int
    prompt_version: str
    estimated_input_tokens: int
    estimated_cost_usd: float | None
    cache_valid: bool
    cached_run_id: str | None


@router.get("/api/sections/{section_id}/extract/preflight", response_model=PreflightResponse)
def extract_preflight(section_id: str, db: Session = Depends(get_db)) -> PreflightResponse:
    section = db.get(SourceSection, section_id)
    if section is None:
        raise HTTPException(status_code=404, detail=f"Section '{section_id}' not found.")

    content_hash = _section_content_hash(section)

    cached_run = (
        db.query(ExtractionRun)
        .filter(
            ExtractionRun.section_id == section_id,
            ExtractionRun.status == "completed",
            ExtractionRun.section_content_hash == content_hash,
            ExtractionRun.prompt_version == COMBINED_PROMPT_VERSION,
        )
        .order_by(ExtractionRun.completed_at.desc())
        .first()
    )

    catalog_user = CATALOG_USER_TEMPLATE.format(
        section_order=section.ordinal,
        title=section.title or "(untitled)",
        text=section.text or "",
        known_names_json="[]",
    )
    evidence_user = EVIDENCE_USER_TEMPLATE.format(
        section_order=section.ordinal,
        title=section.title or "(untitled)",
        text=section.text or "",
        place_catalog_json="[]",
    )
    estimated_input_tokens = (
        (len(CATALOG_SYSTEM_PROMPT) + len(catalog_user)) // 4
        + (len(EVIDENCE_SYSTEM_PROMPT) + len(evidence_user)) // 4
    )

    model = os.environ.get("OPENAI_EXTRACTION_MODEL")
    rates = _COST_PER_TOKEN.get(model or "") if model else None
    if rates:
        estimated_cost_usd = (
            estimated_input_tokens * rates["input"]
            + _PREFLIGHT_OUTPUT_TOKEN_ESTIMATE * rates["output"]
        )
    else:
        estimated_cost_usd = None

    return PreflightResponse(
        section_id=section_id,
        title=section.title,
        sections_to_send=2,
        prompt_version=COMBINED_PROMPT_VERSION,
        estimated_input_tokens=estimated_input_tokens,
        estimated_cost_usd=estimated_cost_usd,
        cache_valid=cached_run is not None,
        cached_run_id=cached_run.id if cached_run else None,
    )


@router.post("/api/sections/{section_id}/extract", response_model=ExtractResponse, status_code=201)
def extract_section(
    section_id: str,
    force: bool = Query(default=False, description="Re-run even if a cached result exists."),
    db: Session = Depends(get_db),
) -> ExtractResponse:
    try:
        provider = get_provider()
    except ExtractionNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    section = db.get(SourceSection, section_id)
    if section is None:
        raise HTTPException(status_code=404, detail=f"Section '{section_id}' not found.")

    # Build cumulative catalog from entity candidates in all PRIOR sections of this document
    prior_sections = (
        db.query(SourceSection)
        .filter(
            SourceSection.document_id == section.document_id,
            SourceSection.ordinal < section.ordinal,
        )
        .all()
    )
    prior_sec_ids = [s.id for s in prior_sections]
    prior_entity_candidates = (
        db.query(Candidate)
        .filter(
            Candidate.section_id.in_(prior_sec_ids),
            Candidate.kind == "entity",
        )
        .all()
    ) if prior_sec_ids else []

    existing_entities = (
        db.query(MapEntity)
        .filter(
            MapEntity.provenance_document_id == section.document_id,
            MapEntity.state == "active",
        )
        .all()
    )

    seen_names: set[str] = set()
    cumulative_catalog: list[dict] = []
    for c in prior_entity_candidates:
        name = (c.payload.get("name") or "").strip()
        if name and name not in seen_names:
            seen_names.add(name)
            cumulative_catalog.append({
                "name": name,
                "type": c.payload.get("type", ""),
                "aliases": c.payload.get("aliases") or [],
            })
    for e in existing_entities:
        if e.name and e.name not in seen_names:
            seen_names.add(e.name)
            cumulative_catalog.append({
                "name": e.name,
                "type": e.place_kind or "",
                "aliases": list(e.aliases or []),
            })

    try:
        run, candidates, from_cache = run_extraction(
            db, section_id, provider,
            known_entities=None,
            cumulative_catalog=cumulative_catalog,
            force=force,
        )
    except ExtractionError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        raise HTTPException(status_code=500, detail=msg) from exc

    return ExtractResponse(
        run=RunResponse.model_validate(run),
        candidates=[CandidateResponse.model_validate(c) for c in candidates],
        from_cache=from_cache,
    )


@router.get("/api/extraction-runs/{run_id}", response_model=RunResponse)
def get_run(run_id: str, db: Session = Depends(get_db)) -> RunResponse:
    run = db.get(ExtractionRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Extraction run '{run_id}' not found.")
    return RunResponse.model_validate(run)
