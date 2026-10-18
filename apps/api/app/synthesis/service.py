import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.db.models import SourceSection
from app.domain.world import MapClaim, MapEntity, MapTravelRule
from app.extraction.models import Candidate
from app.extraction.models import ExtractionRun
from app.extraction.prompts import GLOBAL_CATALOG_VERSION, GLOBAL_CATALOG_GAP_VERSION, GLOBAL_EVIDENCE_VERSION, GLOBAL_EVIDENCE_DEDUP_VERSION, GLOBAL_EVIDENCE_CONTAINMENT_VERSION
from app.synthesis.models import SynthesisItem, SynthesisRun
from app.synthesis.prompts import THREE_PASS_SYNTHESIS_VERSION
from app.synthesis.provider import OpenAISynthesisProvider
from app.synthesis.review import canonicalize_synthesis_run, apply_scene_anchor_counts, apply_catalog_fields, _approve_claim, _approve_visual_palette

_log = logging.getLogger(__name__)

_ALLOWED_KINDS = {"entity", "claim", "route", "visual_claim", "visual_palette", "same_as", "unresolved", "reveal_event"}
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

        # Also collect all gap pass runs for this section
        gap_runs = (
            session.query(ExtractionRun)
            .filter(
                ExtractionRun.section_id == section.id,
                ExtractionRun.status == "completed",
                ExtractionRun.prompt_version == GLOBAL_CATALOG_GAP_VERSION,
            )
            .all()
        )

        run_ids: list[str] = []
        if catalog_run or evidence_run:
            # New global two-pass — union entity + evidence candidates
            if catalog_run:
                run_ids.append(catalog_run.id)
            if evidence_run:
                run_ids.append(evidence_run.id)
            for gap_run in gap_runs:
                run_ids.append(gap_run.id)
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

    # Add containment pass candidates (located_in claims) so they survive synthesis
    containment_run = (
        session.query(ExtractionRun)
        .filter(
            ExtractionRun.document_id == document_id,
            ExtractionRun.section_id.is_(None),
            ExtractionRun.status == "completed",
            ExtractionRun.prompt_version == GLOBAL_EVIDENCE_CONTAINMENT_VERSION,
        )
        .order_by(ExtractionRun.completed_at.desc())
        .first()
    )
    if containment_run:
        containment_candidates = (
            session.query(Candidate)
            .filter(
                Candidate.extraction_run_id == containment_run.id,
                Candidate.section_id.is_(None),
                Candidate.review_state != "rejected",
            )
            .all()
        )
        for c in containment_candidates:
            ledger.append({
                "section_title": "containment",
                "section_ordinal": -3,
                "kind": c.kind,
                "payload": c.payload,
                "confidence": c.confidence,
                "excerpt": c.excerpt,
                "status": c.status,
                "review_state": c.review_state,
            })
        _log.info("Evidence ledger: added %d containment candidates", len(containment_candidates))

    # Add confirmed dedup (SAME_AS) candidates so synthesis can apply them as merge hints
    dedup_run = (
        session.query(ExtractionRun)
        .filter(
            ExtractionRun.document_id == document_id,
            ExtractionRun.section_id.is_(None),
            ExtractionRun.status == "completed",
            ExtractionRun.prompt_version == GLOBAL_EVIDENCE_DEDUP_VERSION,
        )
        .order_by(ExtractionRun.completed_at.desc())
        .first()
    )
    if dedup_run:
        dedup_candidates = (
            session.query(Candidate)
            .filter(
                Candidate.extraction_run_id == dedup_run.id,
                Candidate.section_id.is_(None),
                Candidate.review_state != "rejected",
            )
            .all()
        )
        for c in dedup_candidates:
            ledger.append({
                "section_title": "dedup",
                "section_ordinal": -2,
                "kind": c.kind,
                "payload": c.payload,
                "confidence": c.confidence,
                "excerpt": c.excerpt,
                "status": c.status,
                "review_state": c.review_state,
            })
        _log.info("Evidence ledger: added %d dedup candidates", len(dedup_candidates))

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
        if item.get("review_state") == "rejected":
            continue  # rejected entities are excluded from synthesis
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

    # Also include manually-added entity candidates (survive re-catalog, always flow to synthesis)
    manual_candidates = (
        session.query(Candidate)
        .filter(
            Candidate.section_id.in_([s.id for s in sections]),
            Candidate.source == "manual",
            Candidate.kind == "entity",
            Candidate.review_state != "rejected",
        )
        .all()
    )
    for c in manual_candidates:
        name = (c.payload.get("name") or "").strip().lower()
        if not name:
            continue
        mention = {"section_title": "manual entry", "section_ordinal": -1, "excerpt": ""}
        if name not in seen_names:
            seen_names[name] = len(entity_deduped)
            merged = {
                "section_title": "manual entry",
                "section_ordinal": -1,
                "kind": c.kind,
                "payload": c.payload,
                "confidence": c.confidence,
                "excerpt": c.excerpt,
                "status": c.status,
                "review_state": c.review_state,
                "section_mentions": [mention],
            }
            entity_deduped.append(merged)
        else:
            entity_deduped[seen_names[name]]["section_mentions"].append(mention)

    _log.info(
        "Evidence ledger for %s: %d raw entity candidates → %d unique (%d manual); %d evidence items",
        document_id, len(ledger) - len(non_entity), len(entity_deduped), len(manual_candidates), len(non_entity),
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
        q = session.query(model).filter(
            model.provenance_document_id == document_id,
            model.state == "active",
        )
        if hasattr(model, "status"):
            q = q.filter(model.status != "manual")
        q.update({"state": "superseded"}, synchronize_session=False)


def run_synthesis(
    session: Session,
    document_id: str,
    provider: OpenAISynthesisProvider,
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
                SynthesisRun.synthesis_prompt_version == THREE_PASS_SYNTHESIS_VERSION,
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

    # Snapshot active entity names before superseding — used as must-include seeds when
    # re-synthesizing after a re-catalog (which resets all review_states to "proposed").
    prev_canonical_names: list[str] = [
        e.name
        for e in session.query(MapEntity)
        .filter(
            MapEntity.provenance_document_id == document_id,
            MapEntity.state == "active",
            MapEntity.entity_kind == "place",
        )
        .all()
        if e.name
    ]

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
        from app import events as ev
        ev.emit(document_id, "phase_change", stage="synthesis", phase=phase)

    try:
        entity_ledger = [item for item in ledger if item["kind"] == "entity"]
        evidence_ledger = [item for item in ledger if item["kind"] != "entity"]
        result = provider.synthesize_two_pass(
            entity_ledger,
            evidence_ledger,
            phase_callback=_phase_callback,
            prev_canonical_names=prev_canonical_names,
        )

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
        apply_scene_anchor_counts(session, document_id)
        apply_catalog_fields(session, document_id)
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


def run_visual_synthesis(
    session: Session,
    document_id: str,
    provider: OpenAISynthesisProvider,
) -> tuple[SynthesisRun, list[SynthesisItem]]:
    """Visual-only run: promote spatial candidates directly + LLM visual claims.

    Does NOT supersede or re-create entity records.
    Only supersedes and replaces MapClaim records.
    """
    # Clean up stale running runs
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=_STALE_RUN_MINUTES)
    (
        session.query(SynthesisRun)
        .filter(
            SynthesisRun.document_id == document_id,
            SynthesisRun.status == "running",
            SynthesisRun.started_at < cutoff,
        )
        .update(
            {"status": "failed", "error": "Stale run cleaned up on next visual synthesis attempt"},
            synchronize_session=False,
        )
    )
    session.flush()

    # Supersede only MapClaim records — entities stay intact
    (
        session.query(MapClaim)
        .filter(
            MapClaim.provenance_document_id == document_id,
            MapClaim.state == "active",
            MapClaim.status != "manual",
        )
        .update({"state": "superseded"}, synchronize_session=False)
    )

    run = SynthesisRun(
        document_id=document_id,
        status="running",
        provider="openai",
        model="gpt-4o-mini",
        synthesis_prompt_version="",
        evidence_hash="",
        started_at=datetime.now(timezone.utc),
    )
    session.add(run)
    session.commit()

    def _phase_callback(phase: str) -> None:
        run.current_phase = phase
        session.commit()
        from app import events as ev
        ev.emit(document_id, "phase_change", stage="visual_synthesis", phase=phase)

    try:
        _phase_callback("visual")

        ledger = _build_evidence_ledger(session, document_id)
        evidence_candidates = [item for item in ledger if item["kind"] != "entity"]

        # Canonical entity map from active records (not re-synthesized)
        active_entities = (
            session.query(MapEntity)
            .filter(
                MapEntity.provenance_document_id == document_id,
                MapEntity.state == "active",
            )
            .all()
        )
        canonical_entity_map = [
            {"name": e.name, "aliases": e.aliases or []}
            for e in active_entities
            if e.name
        ]

        items: list[SynthesisItem] = []
        ordinal = 0

        # Visual claims + palette sub-passes (run in parallel inside synthesize_visual)
        result = provider.synthesize_visual(evidence_candidates, canonical_entity_map, _phase_callback)
        for raw_item in result.items:
            item = SynthesisItem(
                synthesis_run_id=run.id,
                document_id=document_id,
                kind=raw_item.kind,
                payload=raw_item.payload,
                confidence=raw_item.confidence,
                rationale=raw_item.rationale,
                ordinal=ordinal,
            )
            session.add(item)
            items.append(item)
            ordinal += 1
            if raw_item.kind == "visual_claim":
                try:
                    _approve_claim(session, document_id, raw_item.payload, "visual", raw_item.confidence)
                except Exception:
                    _log.warning("Failed to approve visual claim %s", raw_item.payload, exc_info=True)
            elif raw_item.kind == "visual_palette":
                try:
                    _approve_visual_palette(session, document_id, raw_item.payload)
                except Exception:
                    _log.warning("Failed to approve visual palette %s", raw_item.payload, exc_info=True)

        # Promote spatial candidates directly (no LLM)
        spatial_candidates = [
            c for c in evidence_candidates
            if c.get("kind") == "claim" and c.get("review_state") != "rejected"
        ]
        n_spatial = 0
        for candidate in spatial_candidates:
            payload = candidate.get("payload", {})
            predicate = payload.get("predicate", "")
            if not predicate or predicate == "SAME_AS":
                continue
            try:
                _approve_claim(session, document_id, payload, "spatial", candidate.get("confidence"))
                item = SynthesisItem(
                    synthesis_run_id=run.id,
                    document_id=document_id,
                    kind="claim",
                    payload=payload,
                    confidence=candidate.get("confidence", 0.7),
                    rationale="promoted from evidence",
                    ordinal=ordinal,
                )
                session.add(item)
                items.append(item)
                ordinal += 1
                n_spatial += 1
            except Exception:
                _log.warning("Failed to promote spatial claim %s", payload, exc_info=True)

        session.flush()
        run.status = "completed"
        if result is not None:
            run.synthesis_prompt_version = result.synthesis_prompt_version
        run.completed_at = datetime.now(timezone.utc)
        session.commit()

        _log.info(
            "Visual synthesis completed for document %s: %d visual claims, %d spatial claims promoted",
            document_id,
            sum(1 for i in items if i.kind == "visual_claim"),
            n_spatial,
        )
        return run, items

    except Exception as exc:
        run.status = "failed"
        run.error = str(exc)
        run.completed_at = datetime.now(timezone.utc)
        session.commit()
        raise
