import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.db.models import SourceSection
from app.domain.world import MapClaim, MapEntity, MapTravelRule
from app.extraction.models import Candidate
from app.extraction.prompts import GLOBAL_CATALOG_VERSION, GLOBAL_EVIDENCE_VERSION
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
        # Global two-pass: catalog run holds entities, evidence run holds everything else.
        # Collect from both separately; fall back to most-recent single run for legacy data.
        catalog_run = (
            session.query(ExtractionRun)
            .filter(
                ExtractionRun.section_id == section.id,
                ExtractionRun.status == "completed",
                ExtractionRun.prompt_version == GLOBAL_CATALOG_VERSION,
            )
            .order_by(ExtractionRun.completed_at.desc())
            .first()
        )
        evidence_run = (
            session.query(ExtractionRun)
            .filter(
                ExtractionRun.section_id == section.id,
                ExtractionRun.status == "completed",
                ExtractionRun.prompt_version == GLOBAL_EVIDENCE_VERSION,
            )
            .order_by(ExtractionRun.completed_at.desc())
            .first()
        )

        run_ids: list[str] = []
        if catalog_run or evidence_run:
            # New global two-pass — union entity + evidence candidates
            if catalog_run:
                run_ids.append(catalog_run.id)
            if evidence_run:
                run_ids.append(evidence_run.id)
        else:
            # Legacy single-run — use most recent completed run
            legacy_run = (
                session.query(ExtractionRun)
                .filter(
                    ExtractionRun.section_id == section.id,
                    ExtractionRun.status == "completed",
                )
                .order_by(ExtractionRun.completed_at.desc())
                .first()
            )
            if legacy_run is None:
                continue
            run_ids.append(legacy_run.id)

        candidates = (
            session.query(Candidate)
            .filter(
                Candidate.section_id == section.id,
                Candidate.extraction_run_id.in_(run_ids),
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

    # Deduplicate entity candidates in Python — merge all per-section occurrences
    # of the same place into ONE record. The merged record carries the best payload
    # (highest-confidence name/type/aliases) PLUS a section_mentions list so the
    # entity consolidation LLM can still populate per-section observations.
    # This collapses e.g. 20 "Prythian" rows into 1 record with 20 section mentions.
    seen_names: dict[str, int] = {}  # normalized name → index in entity_deduped
    entity_deduped: list[dict] = []
    non_entity: list[dict] = []
    for item in ledger:
        if item["kind"] != "entity":
            non_entity.append(item)
            continue
        name = (item["payload"].get("name") or "").strip().lower()
        if not name:
            non_entity.append(item)
            continue
        mention = {
            "section_title": item.get("section_title"),
            "section_ordinal": item.get("section_ordinal"),
            "excerpt": item.get("excerpt", ""),
        }
        if name not in seen_names:
            seen_names[name] = len(entity_deduped)
            merged = dict(item)
            merged["section_mentions"] = [mention]
            entity_deduped.append(merged)
        else:
            existing = entity_deduped[seen_names[name]]
            existing["section_mentions"].append(mention)
            if item["confidence"] > existing["confidence"]:
                existing["confidence"] = item["confidence"]
                existing["payload"] = item["payload"]

    _log.info(
        "Evidence ledger for %s: %d raw entity candidates → %d unique; %d evidence items",
        document_id, len(ledger) - len(non_entity), len(entity_deduped), len(non_entity),
    )
    return entity_deduped + non_entity


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
    session.commit()  # commit immediately so the polling endpoint can see it

    def _phase_callback(phase: str) -> None:
        run.current_phase = phase
        session.commit()

    try:
        entity_ledger = [item for item in ledger if item["kind"] == "entity"]
        evidence_ledger = [item for item in ledger if item["kind"] != "entity"]
        if hasattr(provider, "synthesize_two_pass"):
            result = provider.synthesize_two_pass(entity_ledger, evidence_ledger, phase_callback=_phase_callback)
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
