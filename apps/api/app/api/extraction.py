import hashlib
import logging
import os
import threading
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

_log = logging.getLogger(__name__)

from app.db.engine import get_db, SessionLocal
from app.db.models import SourceSection
from app.domain.world import MapEntity
from app.extraction.models import Candidate, ExtractionRun
from app.extraction.openai_provider import ExtractionNotConfiguredError, get_provider
from app.extraction.prompts import (
    COMBINED_PROMPT_VERSION,
    CATALOG_SYSTEM_PROMPT, CATALOG_USER_TEMPLATE,
    EVIDENCE_SYSTEM_PROMPT, EVIDENCE_USER_TEMPLATE,
    GLOBAL_CATALOG_VERSION, GLOBAL_EVIDENCE_VERSION,
)
from app.extraction.service import (
    ExtractionError,
    _COST_PER_TOKEN,
    _make_run,
    _section_content_hash,
    run_extraction,
    run_catalog_extraction,
    run_catalog_gap_extraction,
    run_evidence_extraction,
)

router = APIRouter(tags=["extraction"])

_PREFLIGHT_OUTPUT_TOKEN_ESTIMATE = 200  # conservative output estimate for cost preview

# In-memory sets of document_ids with an active batch thread.
# Used only for status reporting; accuracy is best-effort (lost on server restart).
_active_catalog_batches: set[str] = set()
_active_catalog_gap_batches: set[str] = set()


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


class ExtractJobResponse(BaseModel):
    run_id: str
    status: str


class PreflightResponse(BaseModel):
    section_id: str
    title: str | None
    sections_to_send: int
    prompt_version: str
    estimated_input_tokens: int
    estimated_cost_usd: float | None
    cache_valid: bool
    cached_run_id: str | None


class ExtractionProgressResponse(BaseModel):
    status: str  # "running" | "idle"
    current_phase: str | None


@router.get("/api/sections/{section_id}/extraction/progress", response_model=ExtractionProgressResponse)
def get_extraction_progress(section_id: str, db: Session = Depends(get_db)) -> ExtractionProgressResponse:
    """Return the current sub-pass phase of an in-progress evidence extraction, for live polling."""
    run = (
        db.query(ExtractionRun)
        .filter(ExtractionRun.section_id == section_id, ExtractionRun.status == "running")
        .order_by(ExtractionRun.started_at.desc())
        .first()
    )
    if run is None:
        return ExtractionProgressResponse(status="idle", current_phase=None)
    return ExtractionProgressResponse(status="running", current_phase=run.current_phase)


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
            ExtractionRun.prompt_version.in_([COMBINED_PROMPT_VERSION, GLOBAL_EVIDENCE_VERSION]),
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


@router.post("/api/sections/{section_id}/extract/catalog", response_model=ExtractResponse, status_code=201)
def extract_section_catalog(
    section_id: str,
    force: bool = Query(default=False, description="Re-run even if a cached result exists."),
    db: Session = Depends(get_db),
) -> ExtractResponse:
    """Global pre-pass: catalog-only extraction for a single section."""
    try:
        provider = get_provider()
    except ExtractionNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    try:
        run, candidates, from_cache = run_catalog_extraction(db, section_id, provider, force=force)
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


class CatalogBatchResponse(BaseModel):
    document_id: str
    sections_total: int
    sections_done: int
    status: str  # 'running' | 'completed'


class CatalogStatusResponse(BaseModel):
    document_id: str
    sections_total: int
    sections_done: int
    status: str  # 'running' | 'completed' | 'idle'
    catalog_confirmed: bool = False


_CATALOG_CONFIRMED_VERSION = "catalog-confirmed"


def _is_catalog_confirmed(db: Session, section_ids: list[str]) -> bool:
    """Return True if the user has confirmed the catalog review for this document."""
    if not section_ids:
        return False
    return db.query(ExtractionRun).filter(
        ExtractionRun.section_id == section_ids[0],
        ExtractionRun.prompt_version == _CATALOG_CONFIRMED_VERSION,
        ExtractionRun.status == "completed",
    ).first() is not None


def _write_catalog_confirmed(db: Session, section_ids: list[str]) -> None:
    """Persist a sentinel ExtractionRun row that marks catalog review as confirmed."""
    if not section_ids:
        return
    existing = db.query(ExtractionRun).filter(
        ExtractionRun.section_id == section_ids[0],
        ExtractionRun.prompt_version == _CATALOG_CONFIRMED_VERSION,
    ).first()
    if existing:
        existing.status = "completed"
    else:
        sentinel = ExtractionRun(
            section_id=section_ids[0],
            status="completed",
            provider="",
            model="",
            prompt_version=_CATALOG_CONFIRMED_VERSION,
        )
        db.add(sentinel)
    db.commit()


def _clear_catalog_confirmed(db: Session, section_ids: list[str]) -> None:
    """Remove the confirmation sentinel (called when forcing a re-catalog)."""
    if not section_ids:
        return
    db.query(ExtractionRun).filter(
        ExtractionRun.section_id == section_ids[0],
        ExtractionRun.prompt_version == _CATALOG_CONFIRMED_VERSION,
    ).delete(synchronize_session=False)
    db.commit()


def _count_catalog_done(db: Session, section_ids: list[str]) -> int:
    if not section_ids:
        return 0
    done_ids = {
        r[0] for r in db.query(ExtractionRun.section_id).filter(
            ExtractionRun.section_id.in_(section_ids),
            ExtractionRun.status == "completed",
            ExtractionRun.prompt_version == GLOBAL_CATALOG_VERSION,
        ).all()
    }
    return len(done_ids)


def _catalog_batch_worker(document_id: str, section_ids: list[str], force: bool) -> None:
    """Background thread: run catalog extraction for every section of a document."""
    db = SessionLocal()
    try:
        try:
            provider = get_provider()
        except ExtractionNotConfiguredError as exc:
            _log.error("Catalog batch: provider not configured: %s", exc)
            return
        for section_id in section_ids:
            try:
                run_catalog_extraction(db, section_id, provider, force=force)
            except Exception as exc:
                _log.error("Catalog batch failed for section %s: %s", section_id, exc)
    finally:
        _active_catalog_batches.discard(document_id)
        db.close()


@router.post(
    "/api/documents/{document_id}/extract/catalog",
    response_model=CatalogBatchResponse,
    status_code=202,
)
def batch_catalog_document(
    document_id: str,
    force: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> CatalogBatchResponse:
    """Start a background catalog pass for all sections of a document.
    Returns 202 immediately. Poll GET /api/documents/{id}/extract/catalog/status for progress.
    If all sections are already cached (and force=False), returns 202 with status='completed'.
    """
    try:
        get_provider()
    except ExtractionNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    section_ids = [
        s.id for s in db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .order_by(SourceSection.ordinal)
        .all()
    ]
    if not section_ids:
        raise HTTPException(status_code=404, detail=f"Document '{document_id}' has no sections.")

    sections_done = _count_catalog_done(db, section_ids)

    if not force and sections_done == len(section_ids):
        return CatalogBatchResponse(
            document_id=document_id,
            sections_total=len(section_ids),
            sections_done=sections_done,
            status="completed",
        )

    if force:
        _clear_catalog_confirmed(db, section_ids)

    _active_catalog_batches.add(document_id)
    thread = threading.Thread(
        target=_catalog_batch_worker,
        args=(document_id, section_ids, force),
        daemon=True,
        name=f"catalog-batch-{document_id[:8]}",
    )
    thread.start()

    return CatalogBatchResponse(
        document_id=document_id,
        sections_total=len(section_ids),
        sections_done=sections_done,
        status="running",
    )


@router.get(
    "/api/documents/{document_id}/extract/catalog/status",
    response_model=CatalogStatusResponse,
)
def get_document_catalog_status(
    document_id: str,
    db: Session = Depends(get_db),
) -> CatalogStatusResponse:
    """Return catalog progress for a document: sections done, total, and running/idle/completed."""
    section_ids = [
        s.id for s in db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .order_by(SourceSection.ordinal)
        .all()
    ]
    if not section_ids:
        raise HTTPException(status_code=404, detail=f"Document '{document_id}' has no sections.")

    sections_done = _count_catalog_done(db, section_ids)
    if document_id in _active_catalog_batches:
        status = "running"
    elif sections_done == len(section_ids):
        status = "completed"
    else:
        status = "idle"

    return CatalogStatusResponse(
        document_id=document_id,
        sections_total=len(section_ids),
        sections_done=sections_done,
        status=status,
        catalog_confirmed=_is_catalog_confirmed(db, section_ids),
    )


@router.post(
    "/api/documents/{document_id}/extract/catalog/confirm",
    status_code=204,
)
def confirm_catalog_review(
    document_id: str,
    db: Session = Depends(get_db),
) -> Response:
    """Persist the user's decision to confirm the catalog review for a document."""
    section_ids = [
        s.id for s in db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .order_by(SourceSection.ordinal)
        .all()
    ]
    if not section_ids:
        raise HTTPException(status_code=404, detail=f"Document '{document_id}' has no sections.")
    _write_catalog_confirmed(db, section_ids)
    return Response(status_code=204)


def _catalog_gap_batch_worker(document_id: str, section_ids: list[str]) -> None:
    """Background thread: run gap catalog pass for every section of a document."""
    db = SessionLocal()
    try:
        try:
            provider = get_provider()
        except ExtractionNotConfiguredError as exc:
            _log.error("Catalog gap batch: provider not configured: %s", exc)
            return
        for section_id in section_ids:
            try:
                run_catalog_gap_extraction(db, section_id, provider)
            except Exception as exc:
                _log.error("Catalog gap batch failed for section %s: %s", section_id, exc)
    finally:
        _active_catalog_gap_batches.discard(document_id)
        db.close()


class CatalogGapBatchResponse(BaseModel):
    document_id: str
    sections_total: int
    status: str  # "running" | "completed"


@router.post(
    "/api/documents/{document_id}/extract/catalog-gap",
    response_model=CatalogGapBatchResponse,
    status_code=202,
)
def batch_catalog_gap_document(
    document_id: str,
    db: Session = Depends(get_db),
) -> CatalogGapBatchResponse:
    """Start a background gap-catalog pass for all sections of a document.
    Finds places missed by the initial catalog pass. Can be run multiple times.
    """
    try:
        get_provider()
    except ExtractionNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    section_ids = [
        s.id for s in db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .order_by(SourceSection.ordinal)
        .all()
    ]
    if not section_ids:
        raise HTTPException(status_code=404, detail=f"Document '{document_id}' has no sections.")

    if document_id in _active_catalog_gap_batches:
        return CatalogGapBatchResponse(
            document_id=document_id,
            sections_total=len(section_ids),
            status="running",
        )

    _active_catalog_gap_batches.add(document_id)
    thread = threading.Thread(
        target=_catalog_gap_batch_worker,
        args=(document_id, section_ids),
        daemon=True,
        name=f"catalog-gap-{document_id[:8]}",
    )
    thread.start()

    return CatalogGapBatchResponse(
        document_id=document_id,
        sections_total=len(section_ids),
        status="running",
    )


@router.get(
    "/api/documents/{document_id}/extract/catalog-gap/status",
    response_model=CatalogGapBatchResponse,
)
def get_catalog_gap_status(
    document_id: str,
    db: Session = Depends(get_db),  # noqa: ARG001
) -> CatalogGapBatchResponse:
    section_ids = [
        s.id for s in db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .all()
    ]
    status = "running" if document_id in _active_catalog_gap_batches else "completed"
    return CatalogGapBatchResponse(
        document_id=document_id,
        sections_total=len(section_ids),
        status=status,
    )


def _build_global_catalog(db: Session, document_id: str) -> list[dict]:
    """Collect all non-rejected entity candidates + active map entities for a document."""
    all_section_ids = [
        s.id for s in db.query(SourceSection).filter(
            SourceSection.document_id == document_id
        ).all()
    ]
    entity_candidates = (
        db.query(Candidate)
        .filter(
            Candidate.section_id.in_(all_section_ids),
            Candidate.kind == "entity",
            Candidate.review_state != "rejected",
        )
        .all()
    ) if all_section_ids else []

    existing_entities = (
        db.query(MapEntity)
        .filter(
            MapEntity.provenance_document_id == document_id,
            MapEntity.state == "active",
        )
        .all()
    )

    seen: set[str] = set()
    catalog: list[dict] = []
    for ec in entity_candidates:
        name = (ec.payload.get("name") or "").strip()
        if name and name not in seen:
            seen.add(name)
            entry: dict = {
                "name": name,
                "type": ec.payload.get("type", ""),
                "aliases": ec.payload.get("aliases") or [],
            }
            if ec.payload.get("spatial_level") is not None:
                entry["spatial_level"] = ec.payload["spatial_level"]
            if ec.payload.get("kind_descriptor"):
                entry["kind_descriptor"] = ec.payload["kind_descriptor"]
            if ec.payload.get("tier"):
                entry["tier"] = ec.payload["tier"]
            catalog.append(entry)
    for e in existing_entities:
        if e.name and e.name not in seen:
            seen.add(e.name)
            catalog.append({
                "name": e.name,
                "type": e.place_kind or "",
                "aliases": list(e.aliases or []),
                "kind_descriptor": (e.payload or {}).get("kind_descriptor", ""),
                "tier": (e.payload or {}).get("tier", ""),
            })
    return catalog


def _evidence_worker(run_id: str, section_id: str, global_catalog: list[dict], force: bool) -> None:
    """Background thread: runs evidence extraction with its own DB session."""
    db = SessionLocal()
    try:
        try:
            provider = get_provider()
        except ExtractionNotConfiguredError as exc:
            _log.error("Evidence worker: provider not configured: %s", exc)
            return
        run_evidence_extraction(
            db, section_id, provider, global_catalog,
            force=force, pre_created_run_id=run_id,
        )
    except Exception as exc:
        _log.error("Evidence worker failed for section %s: %s", section_id, exc)
    finally:
        db.close()


@router.post("/api/sections/{section_id}/extract/evidence", response_model=ExtractJobResponse, status_code=202)
def extract_section_evidence(
    section_id: str,
    force: bool = Query(default=False, description="Re-run even if a cached result exists."),
    db: Session = Depends(get_db),
) -> ExtractJobResponse:
    """Start evidence extraction as a background job. Returns 202 with run_id immediately.
    Poll GET /api/extraction-runs/{run_id} for status (running → completed/failed).
    """
    try:
        get_provider()  # fail fast if not configured
    except ExtractionNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    section = db.get(SourceSection, section_id)
    if section is None:
        raise HTTPException(status_code=404, detail=f"Section '{section_id}' not found.")

    # If cached result exists and force=False, return it synchronously (fast path)
    if not force:
        content_hash = _section_content_hash(section)
        existing = (
            db.query(ExtractionRun)
            .filter(
                ExtractionRun.section_id == section_id,
                ExtractionRun.status == "completed",
                ExtractionRun.section_content_hash == content_hash,
                ExtractionRun.prompt_version == GLOBAL_EVIDENCE_VERSION,
            )
            .order_by(ExtractionRun.completed_at.desc())
            .first()
        )
        if existing:
            return ExtractJobResponse(run_id=existing.id, status="completed")

    global_catalog = _build_global_catalog(db, section.document_id)

    # Pre-create the run record so the caller has a run_id to poll immediately
    content_hash = _section_content_hash(section)
    run = _make_run(db, section_id, content_hash)
    db.commit()
    run_id = run.id

    thread = threading.Thread(
        target=_evidence_worker,
        args=(run_id, section_id, global_catalog, force),
        daemon=True,
        name=f"evidence-{section_id[:8]}",
    )
    thread.start()

    return ExtractJobResponse(run_id=run_id, status="running")


@router.get("/api/extraction-runs/{run_id}", response_model=RunResponse)
def get_run(run_id: str, db: Session = Depends(get_db)) -> RunResponse:
    run = db.get(ExtractionRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Extraction run '{run_id}' not found.")
    return RunResponse.model_validate(run)
