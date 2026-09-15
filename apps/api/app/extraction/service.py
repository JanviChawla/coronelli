import hashlib
import logging
from datetime import datetime, timedelta, timezone

_log = logging.getLogger(__name__)

from sqlalchemy.orm import Session

from app.db.models import SourceSection
from app.extraction.models import Candidate, ExtractionRun
from app.extraction.prompts import COMBINED_PROMPT_VERSION as _CURRENT_PROMPT_VERSION
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


def run_extraction(
    session: Session,
    section_id: str,
    provider: ExtractionProvider,
    known_entities: list[dict] | None = None,
    cumulative_catalog: list[dict] | None = None,
    force: bool = False,
) -> tuple[ExtractionRun, list[Candidate], bool]:
    section = session.get(SourceSection, section_id)
    if section is None:
        raise ExtractionError(f"Section '{section_id}' not found.")

    content_hash = _section_content_hash(section)

    # Clean up stale "running" runs so they never permanently block re-extraction.
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=_STALE_RUN_MINUTES)
    stale = (
        session.query(ExtractionRun)
        .filter(
            ExtractionRun.section_id == section_id,
            ExtractionRun.status == "running",
            ExtractionRun.started_at < cutoff,
        )
        .all()
    )
    for sr in stale:
        sr.status = "failed"
        sr.error = "Stale run cleaned up on next extraction attempt"
    if stale:
        session.flush()

    if not force:
        existing = (
            session.query(ExtractionRun)
            .filter(
                ExtractionRun.section_id == section_id,
                ExtractionRun.status == "completed",
                ExtractionRun.section_content_hash == content_hash,
                ExtractionRun.prompt_version == _CURRENT_PROMPT_VERSION,
            )
            .order_by(ExtractionRun.completed_at.desc())
            .first()
        )
        if existing:
            cached_candidates = (
                session.query(Candidate)
                .filter(Candidate.extraction_run_id == existing.id)
                .order_by(Candidate.ordinal)
                .all()
            )
            return existing, cached_candidates, True
    else:
        # Hard re-harvest: wipe all previous candidates and runs for this section
        # so synthesis never sees a mix of old and new data.
        session.query(Candidate).filter(
            Candidate.section_id == section_id,
        ).delete(synchronize_session=False)
        session.query(ExtractionRun).filter(
            ExtractionRun.section_id == section_id,
        ).update({"status": "superseded"}, synchronize_session=False)
        session.flush()

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

    try:
        if hasattr(provider, "extract_two_pass"):
            result = provider.extract_two_pass(section, cumulative_catalog or known_entities or [])
        else:
            result = provider.extract(section, known_entities or [])
    except Exception as exc:
        run.status = "failed"
        run.error = str(exc)
        run.completed_at = datetime.now(timezone.utc)
        session.commit()
        raise ExtractionError(str(exc)) from exc

    run.status = "completed"
    run.provider = result.provider
    run.model = result.model
    run.prompt_version = result.prompt_version
    run.raw_response = result.raw_response
    run.completed_at = datetime.now(timezone.utc)
    run.input_tokens = result.input_tokens
    run.output_tokens = result.output_tokens
    run.estimated_cost_usd = _compute_cost(result.model, result.input_tokens, result.output_tokens)

    candidates: list[Candidate] = []
    for i, rc in enumerate(result.candidates):
        has_kind = bool(rc.relation_kind)
        has_target = bool(rc.relation_target_id)
        if has_kind != has_target:
            _log.warning(
                "Candidate %d skipped: relation_kind and relation_target_id must both be set or both null "
                "(kind=%r, target=%r)",
                i, rc.relation_kind, rc.relation_target_id,
            )
            continue

        try:
            validate_candidate_payload(rc.kind, rc.payload)
        except ValueError as exc:
            _log.warning(
                "Candidate %d skipped: invalid %s payload — %s. Raw payload: %s",
                i, rc.kind, exc, rc.payload,
            )
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

    session.commit()
    session.refresh(run)
    for c in candidates:
        session.refresh(c)

    return run, candidates, False
