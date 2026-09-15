import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.db.models import SourceSection
from app.domain.world import MapClaim, MapEntity, MapTravelRule
from app.extraction.models import Candidate
from app.synthesis.models import SynthesisItem, SynthesisRun
from app.synthesis.provider import SynthesisProvider
from app.synthesis.review import canonicalize_synthesis_run

_log = logging.getLogger(__name__)

_ALLOWED_KINDS = {"entity", "claim", "route", "visual_claim", "access", "movement", "same_as", "unresolved", "reveal_event"}
_STALE_RUN_MINUTES = 15


def _build_evidence_ledger(session: Session, document_id: str) -> list[dict]:
    sections = (
        session.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .order_by(SourceSection.ordinal)
        .all()
    )

    # Collect candidates, restricting each section to its most recent completed run.
    from app.extraction.models import ExtractionRun
    ledger: list[dict] = []
    for section in sections:
        if section.section_kind != "narrative":
            continue
        # Find the most recent completed run for this section.
        latest_run = (
            session.query(ExtractionRun)
            .filter(
                ExtractionRun.section_id == section.id,
                ExtractionRun.status == "completed",
            )
            .order_by(ExtractionRun.completed_at.desc())
            .first()
        )
        if latest_run is None:
            continue
        candidates = (
            session.query(Candidate)
            .filter(
                Candidate.section_id == section.id,
                Candidate.extraction_run_id == latest_run.id,
            )
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

    # Deduplicate entity candidates in Python — keep the highest-confidence
    # record per normalized name. This cuts 200+ repetitions to ~60 unique places
    # before the LLM sees them, dramatically reducing input size.
    seen_names: dict[str, int] = {}  # normalized name → index in deduped list
    deduped: list[dict] = []
    non_entity: list[dict] = []
    for item in ledger:
        if item["kind"] != "entity":
            non_entity.append(item)
            continue
        name = (item["payload"].get("name") or "").strip().lower()
        if not name:
            non_entity.append(item)
            continue
        if name not in seen_names:
            seen_names[name] = len(deduped)
            deduped.append(item)
        elif item["confidence"] > deduped[seen_names[name]]["confidence"]:
            deduped[seen_names[name]] = item

    _log.info(
        "Evidence ledger for %s: %d raw entity candidates → %d unique; %d evidence items",
        document_id, len(ledger) - len(non_entity), len(deduped), len(non_entity),
    )
    return deduped + non_entity


def _evidence_hash(ledger: list[dict]) -> str:
    serialized = json.dumps(ledger, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(serialized.encode()).hexdigest()


def _has_canonical_records(session: Session, document_id: str) -> bool:
    return (
        session.query(MapEntity)
        .filter(
            MapEntity.provenance_document_id == document_id,
            MapEntity.state == "active",
        )
        .first()
    ) is not None


def _supersede_canonical_records(session: Session, document_id: str) -> None:
    for model in (MapEntity, MapClaim, MapTravelRule):
        session.query(model).filter(
            model.provenance_document_id == document_id,
            model.state == "active",
        ).update({"state": "superseded"}, synchronize_session=False)


def run_synthesis(
    session: Session,
    document_id: str,
    provider: SynthesisProvider,
    force: bool = False,
) -> tuple[SynthesisRun, list[SynthesisItem]]:
    ledger = _build_evidence_ledger(session, document_id)
    ledger_hash = _evidence_hash(ledger)

    # Clean up stale "running" runs so they never permanently block re-synthesis.
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=_STALE_RUN_MINUTES)
    stale_count = (
        session.query(SynthesisRun)
        .filter(
            SynthesisRun.document_id == document_id,
            SynthesisRun.status == "running",
            SynthesisRun.started_at < cutoff,
        )
        .update(
            {"status": "failed", "error": "Stale run cleaned up on next synthesis attempt"},
            synchronize_session=False,
        )
    )
    if stale_count:
        session.flush()
        _log.info("Marked %d stale synthesis run(s) as failed for document %s", stale_count, document_id)

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
            # Canonicalize if records were lost (e.g. fresh DB restored from backup)
            if not _has_canonical_records(session, document_id):
                canonicalize_synthesis_run(session, items, document_id)
                session.commit()
            return existing, items

    # Fresh run: supersede any existing canonical records first
    _supersede_canonical_records(session, document_id)

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
        entity_ledger = [item for item in ledger if item["kind"] == "entity"]
        evidence_ledger = [item for item in ledger if item["kind"] != "entity"]
        if hasattr(provider, "synthesize_two_pass"):
            result = provider.synthesize_two_pass(entity_ledger, evidence_ledger)
        else:
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

        session.flush()
        canonical_count = canonicalize_synthesis_run(session, items, document_id)
        session.commit()
        _log.info(
            "Synthesis completed for document %s: %d items, %d canonical records (prompt v%s)",
            document_id, len(items), canonical_count, result.synthesis_prompt_version,
        )
        return run, items

    except Exception as exc:
        run.status = "failed"
        run.error = str(exc)
        run.completed_at = datetime.now(timezone.utc)
        session.commit()
        raise
