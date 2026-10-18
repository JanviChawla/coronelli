import hashlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Callable

_log = logging.getLogger(__name__)

from sqlalchemy.orm import Session

from app.db.models import SourceSection
from app.extraction.models import Candidate, ExtractionRun
from app.extraction.prompts import (
    GLOBAL_CATALOG_GAP_VERSION,
    GLOBAL_CATALOG_VERSION,
    GLOBAL_EVIDENCE_VERSION,
    GLOBAL_ENRICHMENT_VERSION,
    GLOBAL_EVIDENCE_CONTAINMENT_VERSION,
    GLOBAL_EVIDENCE_DEDUP_VERSION,
)
from app.extraction.provider import ExtractionProvider
from app.extraction.validation import validate_candidate_payload

_STALE_RUN_MINUTES = 15

_COST_PER_TOKEN: dict[str, dict[str, float]] = {
    "gpt-4o-mini": {"input": 0.150 / 1_000_000, "output": 0.600 / 1_000_000},
    "gpt-4o":      {"input": 2.500 / 1_000_000, "output": 10.000 / 1_000_000},
}


class ExtractionError(RuntimeError):
    pass


def _section_content_hash(section: SourceSection) -> str:
    return hashlib.sha256((section.text or "").encode()).hexdigest()


def _compute_cost(
    model: str,
    input_tokens: int | None,
    output_tokens: int | None,
) -> float | None:
    rates = _COST_PER_TOKEN.get(model)
    if not rates or input_tokens is None or output_tokens is None:
        return None
    return input_tokens * rates["input"] + output_tokens * rates["output"]


def _save_candidates(
    session: Session,
    run: "ExtractionRun",
    section_id: str,
    result: "ExtractionResult",
    fallback_text: str = "",
) -> list["Candidate"]:
    _log.info("_save_candidates: received %d raw candidates from provider", len(result.candidates))
    candidates: list[Candidate] = []
    for i, rc in enumerate(result.candidates):
        has_kind = bool(rc.relation_kind)
        has_target = bool(rc.relation_target_id)
        if has_kind != has_target:
            _log.warning(
                "Candidate %d skipped: relation_kind and relation_target_id must both be set or both null",
                i,
            )
            continue
        try:
            validate_candidate_payload(rc.kind, rc.payload, rc.excerpt or "")
        except ValueError as exc:
            # For entity candidates with a contextual-only excerpt, fall back to the full
            # section text before discarding — the gap prompt explicitly finds places
            # implied by movement events whose excerpt won't contain the place name.
            if fallback_text and rc.kind == "entity" and "no significant word in excerpt" in str(exc):
                try:
                    validate_candidate_payload(rc.kind, rc.payload, fallback_text)
                    _log.info(
                        "Candidate %d accepted via section-text fallback (excerpt was contextual): %s",
                        i, rc.payload.get("name"),
                    )
                except ValueError:
                    _log.warning("Candidate %d skipped: invalid %s payload — %s", i, rc.kind, exc)
                    continue
            else:
                _log.warning("Candidate %d skipped: invalid %s payload — %s", i, rc.kind, exc)
                continue
        c = Candidate(
            extraction_run_id=run.id,
            section_id=section_id,
            kind=rc.kind,
            payload=rc.payload,
            status=rc.status,
            confidence=rc.confidence,
            excerpt=rc.excerpt,
            rationale=rc.rationale,
            review_state="proposed",
            ordinal=i,
            temporal_interpretation=rc.temporal_interpretation,
            first_revealed_at_section_id=rc.first_revealed_at_section_id,
            relation_kind=rc.relation_kind,
            relation_target_id=rc.relation_target_id,
        )
        session.add(c)
        candidates.append(c)
    _log.info("_save_candidates: saved %d / %d candidates", len(candidates), len(result.candidates))
    return candidates


def _make_run(session: Session, section_id: str, content_hash: str) -> "ExtractionRun":
    run = ExtractionRun(
        section_id=section_id,
        status="running",
        provider="",
        model="",
        prompt_version="",
        section_content_hash=content_hash,
    )
    session.add(run)
    session.flush()
    return run


def _finish_run(run: "ExtractionRun", result: "ExtractionResult", prompt_version: str) -> None:
    run.status = "completed"
    run.provider = result.provider
    run.model = result.model
    run.prompt_version = prompt_version
    run.raw_response = result.raw_response
    run.completed_at = datetime.now(timezone.utc)
    run.input_tokens = result.input_tokens
    run.output_tokens = result.output_tokens
    run.estimated_cost_usd = _compute_cost(result.model, result.input_tokens, result.output_tokens)


def run_catalog_extraction(
    session: Session,
    section_id: str,
    provider: "ExtractionProvider",
    force: bool = False,
) -> tuple["ExtractionRun", list["Candidate"], bool]:
    """Global pre-pass: catalog-only extraction, stores entity candidates for this section."""
    from app.extraction.provider import ExtractionProvider  # noqa: F401

    section = session.get(SourceSection, section_id)
    if section is None:
        raise ExtractionError(f"Section '{section_id}' not found.")

    # Build known_names — prefer confirmed MapEntities (per-section confirmations),
    # then fall back to unconfirmed prior-section candidates for backward compat.
    from app.domain.world import MapEntity as _MapEntity  # local to avoid circular

    seen: set[str] = set()
    known_names: list[dict] = []

    confirmed = session.query(_MapEntity).filter(
        _MapEntity.provenance_document_id == section.document_id,
        _MapEntity.state == "active",
    ).all()
    for e in confirmed:
        name = (e.name or "").strip()
        if name and name not in seen:
            seen.add(name)
            known_names.append({"name": name, "type": e.place_kind or ""})
        for alias in (e.aliases or []):
            a = (alias or "").strip()
            if a and a not in seen:
                seen.add(a)

    prior_sec_ids = [
        s.id for s in session.query(SourceSection).filter(
            SourceSection.document_id == section.document_id,
            SourceSection.ordinal < section.ordinal,
        ).all()
    ]
    if prior_sec_ids:
        for c in session.query(Candidate).filter(
            Candidate.section_id.in_(prior_sec_ids),
            Candidate.kind == "entity",
        ).all():
            name = (c.payload.get("name") or "").strip()
            if name and name not in seen:
                seen.add(name)
                known_names.append({"name": name, "type": c.payload.get("type", "")})

    content_hash = _section_content_hash(section)

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=_STALE_RUN_MINUTES)
    stale = (
        session.query(ExtractionRun)
        .filter(
            ExtractionRun.section_id == section_id,
            ExtractionRun.status == "running",
            ExtractionRun.prompt_version == GLOBAL_CATALOG_VERSION,
            ExtractionRun.started_at < cutoff,
        )
        .all()
    )
    for sr in stale:
        sr.status = "failed"
        sr.error = "Stale run cleaned up"
    if stale:
        session.flush()

    if not force:
        existing = (
            session.query(ExtractionRun)
            .filter(
                ExtractionRun.section_id == section_id,
                ExtractionRun.status == "completed",
                ExtractionRun.section_content_hash == content_hash,
                ExtractionRun.prompt_version == GLOBAL_CATALOG_VERSION,
            )
            .order_by(ExtractionRun.completed_at.desc())
            .first()
        )
        if existing:
            cached = (
                session.query(Candidate)
                .filter(Candidate.extraction_run_id == existing.id)
                .order_by(Candidate.ordinal)
                .all()
            )
            return existing, cached, True
    else:
        # Wipe all previous candidates and runs for this section, but preserve manually-added ones
        session.query(Candidate).filter(
            Candidate.section_id == section_id,
            Candidate.source != "manual",
        ).delete(synchronize_session=False)
        session.query(ExtractionRun).filter(
            ExtractionRun.section_id == section_id,
        ).update({"status": "superseded"}, synchronize_session=False)
        session.flush()

    run = _make_run(session, section_id, content_hash)

    try:
        result = provider.extract_catalog_only(section, known_names=known_names)
    except Exception as exc:
        run.status = "failed"
        run.error = str(exc)
        run.completed_at = datetime.now(timezone.utc)
        session.commit()
        raise ExtractionError(str(exc)) from exc

    _finish_run(run, result, GLOBAL_CATALOG_VERSION)
    candidates = _save_candidates(session, run, section_id, result)
    session.commit()
    session.refresh(run)
    for c in candidates:
        session.refresh(c)

    return run, candidates, False


def run_catalog_gap_extraction(
    session: Session,
    section_id: str,
    provider: "ExtractionProvider",
) -> tuple["ExtractionRun", list["Candidate"]]:
    """Gap pass: re-read section with already-found entities as context, find missed places."""
    section = session.get(SourceSection, section_id)
    if section is None:
        raise ExtractionError(f"Section '{section_id}' not found.")

    # Collect every current entity candidate for this section (catalog + prior gap runs)
    already_found: list[dict] = []
    seen: set[str] = set()
    for c in session.query(Candidate).filter(
        Candidate.section_id == section_id,
        Candidate.kind == "entity",
    ).all():
        name = (c.payload.get("name") or "").strip()
        if name and name.lower() not in seen:
            seen.add(name.lower())
            entry: dict = {"name": name, "type": c.payload.get("type", "")}
            if c.payload.get("kind_descriptor"):
                entry["kind_descriptor"] = c.payload["kind_descriptor"]
            if c.payload.get("tier"):
                entry["tier"] = c.payload["tier"]
            already_found.append(entry)

    content_hash = _section_content_hash(section)
    run = _make_run(session, section_id, content_hash)

    try:
        result = provider.extract_catalog_gap(section, already_found=already_found)
    except Exception as exc:
        run.status = "failed"
        run.error = str(exc)
        run.completed_at = datetime.now(timezone.utc)
        session.commit()
        raise ExtractionError(str(exc)) from exc

    _finish_run(run, result, GLOBAL_CATALOG_GAP_VERSION)
    candidates = _save_candidates(session, run, section_id, result, fallback_text=section.text or "")
    session.commit()
    session.refresh(run)
    for c in candidates:
        session.refresh(c)

    return run, candidates


def run_evidence_extraction(
    session: Session,
    section_id: str,
    provider: "ExtractionProvider",
    global_catalog: list[dict],
    pre_created_run_id: str | None = None,
) -> tuple["ExtractionRun", list["Candidate"]]:
    """Global evidence pass: always runs fresh — no caching of completed results."""
    section = session.get(SourceSection, section_id)
    if section is None:
        raise ExtractionError(f"Section '{section_id}' not found.")

    content_hash = _section_content_hash(section)

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=_STALE_RUN_MINUTES)
    stale = (
        session.query(ExtractionRun)
        .filter(
            ExtractionRun.section_id == section_id,
            ExtractionRun.status == "running",
            ExtractionRun.prompt_version == GLOBAL_EVIDENCE_VERSION,
            ExtractionRun.started_at < cutoff,
        )
        .all()
    )
    for sr in stale:
        sr.status = "failed"
        sr.error = "Stale run cleaned up"
    if stale:
        session.flush()

    # Always wipe previous evidence results; leave catalog candidates intact
    evidence_run_ids = [
        r.id for r in session.query(ExtractionRun).filter(
            ExtractionRun.section_id == section_id,
            ExtractionRun.prompt_version == GLOBAL_EVIDENCE_VERSION,
        ).all()
    ]
    if evidence_run_ids:
        session.query(Candidate).filter(
            Candidate.extraction_run_id.in_(evidence_run_ids),
        ).delete(synchronize_session=False)
    session.query(ExtractionRun).filter(
        ExtractionRun.section_id == section_id,
        ExtractionRun.prompt_version == GLOBAL_EVIDENCE_VERSION,
    ).update({"status": "superseded"}, synchronize_session=False)
    session.flush()

    if pre_created_run_id:
        run = session.get(ExtractionRun, pre_created_run_id)
        if run is None:
            raise ExtractionError(f"Pre-created run '{pre_created_run_id}' not found.")
    else:
        run = _make_run(session, section_id, content_hash)
        session.commit()  # visible to progress polling immediately

    def _phase_callback(phase: str) -> None:
        run.current_phase = phase
        session.commit()
        from app import events as ev
        ev.emit(section.document_id, "phase_change", stage="evidence", phase=phase, section_id=section_id)

    try:
        result = provider.extract_evidence_only(section, global_catalog, phase_callback=_phase_callback)
    except Exception as exc:
        run.status = "failed"
        run.error = str(exc)
        run.completed_at = datetime.now(timezone.utc)
        session.commit()
        raise ExtractionError(str(exc)) from exc

    _finish_run(run, result, GLOBAL_EVIDENCE_VERSION)
    candidates = _save_candidates(session, run, section_id, result)
    session.commit()
    session.refresh(run)
    for c in candidates:
        session.refresh(c)

    return run, candidates


def run_global_enrichment(
    session: Session,
    document_id: str,
    provider: "ExtractionProvider",
    global_catalog: list[dict],
    passes: list[str] | None = None,
) -> tuple["ExtractionRun", list["Candidate"]]:
    """Document-scoped enrichment: containment sweep + dedup, run once after catalog is complete."""
    # Determine the prompt_version to use for this run
    if passes == ["containment"]:
        run_version = GLOBAL_EVIDENCE_CONTAINMENT_VERSION
    elif passes == ["dedup"]:
        run_version = GLOBAL_EVIDENCE_DEDUP_VERSION
    else:
        run_version = GLOBAL_ENRICHMENT_VERSION

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=_STALE_RUN_MINUTES)
    stale = (
        session.query(ExtractionRun)
        .filter(
            ExtractionRun.document_id == document_id,
            ExtractionRun.section_id.is_(None),
            ExtractionRun.status == "running",
            ExtractionRun.prompt_version == run_version,
            ExtractionRun.started_at < cutoff,
        )
        .all()
    )
    for sr in stale:
        sr.status = "failed"
        sr.error = "Stale run cleaned up"
    if stale:
        session.flush()

    # Supersede previous runs of the same version for this document
    session.query(ExtractionRun).filter(
        ExtractionRun.document_id == document_id,
        ExtractionRun.section_id.is_(None),
        ExtractionRun.prompt_version == run_version,
    ).update({"status": "superseded"}, synchronize_session=False)
    session.flush()

    run = ExtractionRun(
        document_id=document_id,
        section_id=None,
        status="running",
        provider="",
        model="",
        prompt_version="",
        started_at=datetime.now(timezone.utc),
    )
    session.add(run)
    session.commit()

    try:
        result = provider.run_global_enrichment(global_catalog, passes=passes)
    except Exception as exc:
        run.status = "failed"
        run.error = str(exc)
        run.completed_at = datetime.now(timezone.utc)
        session.commit()
        raise ExtractionError(str(exc)) from exc

    _finish_run(run, result, run_version)

    candidates: list[Candidate] = []
    for i, rc in enumerate(result.candidates):
        try:
            validate_candidate_payload(rc.kind, rc.payload, rc.excerpt or "")
        except ValueError as exc:
            _log.warning("Enrichment candidate %d skipped: %s", i, exc)
            continue
        c = Candidate(
            extraction_run_id=run.id,
            section_id=None,
            kind=rc.kind,
            payload=rc.payload,
            status=rc.status,
            confidence=rc.confidence,
            excerpt=rc.excerpt,
            rationale=rc.rationale,
            review_state="proposed",
            ordinal=i,
            temporal_interpretation="static",
        )
        session.add(c)
        candidates.append(c)

    session.commit()
    session.refresh(run)
    _log.info("Global enrichment saved %d candidates for document %s", len(candidates), document_id)
    return run, candidates
