import hashlib
import json
import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.db.models import SourceSection
from app.extraction.models import Candidate
from app.synthesis.models import SynthesisItem, SynthesisRun
from app.synthesis.provider import SynthesisProvider

_log = logging.getLogger(__name__)

_ALLOWED_KINDS = {"entity", "claim", "route", "visual_claim", "same_as", "unresolved", "reveal_event"}


def _build_evidence_ledger(session: Session, document_id: str) -> list[dict]:
    sections = (
        session.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .order_by(SourceSection.ordinal)
        .all()
    )

    ledger: list[dict] = []
    for section in sections:
        candidates = (
            session.query(Candidate)
            .filter(Candidate.section_id == section.id)
            .order_by(Candidate.ordinal)
            .all()
        )
        for c in candidates:
            ledger.append({
                "section_title": section.title,
                "section_ordinal": section.ordinal,
                "kind": c.kind,
                "payload": c.payload,
                "confidence": c.confidence,
                "excerpt": c.excerpt,
                "status": c.status,
                "review_state": c.review_state,
            })

    return ledger


def _evidence_hash(ledger: list[dict]) -> str:
    serialized = json.dumps(ledger, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(serialized.encode()).hexdigest()


def run_synthesis(
    session: Session,
    document_id: str,
    provider: SynthesisProvider,
    force: bool = False,
) -> tuple[SynthesisRun, list[SynthesisItem]]:
    ledger = _build_evidence_ledger(session, document_id)
    ledger_hash = _evidence_hash(ledger)

    if not force:
        existing = (
            session.query(SynthesisRun)
            .filter(
                SynthesisRun.document_id == document_id,
                SynthesisRun.evidence_hash == ledger_hash,
                SynthesisRun.status == "completed",
            )
            .first()
        )
        if existing:
            items = (
                session.query(SynthesisItem)
                .filter(SynthesisItem.synthesis_run_id == existing.id)
                .order_by(SynthesisItem.ordinal)
                .all()
            )
            _log.info("Synthesis cache hit for document %s (hash %s)", document_id, ledger_hash[:12])
            return existing, items

    run = SynthesisRun(
        document_id=document_id,
        status="running",
        provider="openai",
        model="gpt-4o-mini",
        synthesis_prompt_version="",
        evidence_hash=ledger_hash,
        started_at=datetime.now(timezone.utc),
    )
    session.add(run)
    session.flush()

    try:
        result = provider.synthesize(ledger)

        run.status = "completed"
        run.provider = result.provider
        run.model = result.model
        run.synthesis_prompt_version = result.synthesis_prompt_version
        run.raw_response = result.raw_response
        run.completed_at = datetime.now(timezone.utc)

        items: list[SynthesisItem] = []
        for i, raw_item in enumerate(result.items):
            if raw_item.kind not in _ALLOWED_KINDS:
                _log.warning("Synthesis item %d skipped: unknown kind '%s'", i, raw_item.kind)
                continue
            item = SynthesisItem(
                synthesis_run_id=run.id,
                document_id=document_id,
                kind=raw_item.kind,
                payload=raw_item.payload,
                confidence=raw_item.confidence,
                rationale=raw_item.rationale,
                ordinal=i,
            )
            session.add(item)
            items.append(item)

        session.commit()
        _log.info(
            "Synthesis completed for document %s: %d items (prompt v%s)",
            document_id, len(items), result.synthesis_prompt_version,
        )
        return run, items

    except Exception as exc:
        run.status = "failed"
        run.error = str(exc)
        run.completed_at = datetime.now(timezone.utc)
        session.commit()
        raise
