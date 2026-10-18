import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable

_log = logging.getLogger(__name__)

from app.db.models import SourceSection
import re

from app.extraction.prompts import (
    CATALOG_SYSTEM_PROMPT, CATALOG_USER_TEMPLATE,
    CATALOG_GAP_SYSTEM_PROMPT, CATALOG_GAP_USER_TEMPLATE,
    GLOBAL_CATALOG_VERSION, GLOBAL_CATALOG_GAP_VERSION, GLOBAL_EVIDENCE_VERSION,
    EVIDENCE_SUBPASS_USER_TEMPLATE,
    CATALOG_ONLY_USER_TEMPLATE,
    SPATIAL_CLAIMS_SYSTEM_PROMPT,
    VISUAL_CLAIMS_SYSTEM_PROMPT,
    TRAVELRULE_SYSTEM_PROMPT,
    CONTAINMENT_SWEEP_SYSTEM_PROMPT,
    CONTAINMENT_EVIDENCE_SYSTEM_PROMPT,
    CONTAINMENT_EVIDENCE_VERSION,
    ENTITY_DEDUP_SYSTEM_PROMPT,
    GLOBAL_EVIDENCE_SPATIAL_VERSION,
    GLOBAL_EVIDENCE_VISUAL_VERSION,
    GLOBAL_EVIDENCE_TRAVELRULE_VERSION,
    GLOBAL_EVIDENCE_CONTAINMENT_VERSION,
    GLOBAL_EVIDENCE_DEDUP_VERSION,
    GLOBAL_ENRICHMENT_VERSION,
)

# Bare possessive: ends with "'s" with no following place noun.
# "Hans Van Ripper's" → reject. "Van Tassel's mansion" → keep (doesn't end with "'s").
_BARE_POSSESSIVE_RE = re.compile(r"'s\s*$", re.IGNORECASE)
from app.extraction.provider import ExtractionResult, RawCandidate
from app.extraction.validation import _ALLOWED_ENTITY_TYPES

_VALID_STATUSES = {"explicit", "inferred"}
_VALID_KINDS = {"entity", "claim", "travel_rule", "visual_claim", "access", "movement", "scene_anchor"}
_VALID_TEMPORAL = {"static", "discovery", "knowledge_revision", "world_state_change"}
_VALID_RELATION_KINDS = {"supersedes", "contradicts", "qualifies"}


class ExtractionNotConfiguredError(RuntimeError):
    pass


class OpenAIExtractionProvider:
    def __init__(self, *, client: Any, model: str) -> None:
        self._client = client
        self._model = model

    def _run_evidence_subpasses(
        self,
        section: SourceSection,
        full_catalog_list: list[dict],
        phase_callback: Callable[[str], None] | None = None,
    ) -> tuple[list[RawCandidate], int, int]:
        """Run all 5 focused evidence sub-passes and return merged candidates + token counts."""

        catalog_json = json.dumps(
            [
                {
                    "name": e["name"],
                    "type": e.get("type", ""),
                    "kind_descriptor": e.get("kind_descriptor", ""),
                    "tier": e.get("tier", ""),
                    "spatial_level": e.get("spatial_level"),
                    "aliases": e.get("aliases") or [],
                }
                for e in full_catalog_list
            ],
            ensure_ascii=False,
        )
        user_content = EVIDENCE_SUBPASS_USER_TEMPLATE.format(
            section_order=section.ordinal,
            title=section.title or "(untitled)",
            text=section.text or "",
            place_catalog_json=catalog_json,
        )

        catalog_only_content = CATALOG_ONLY_USER_TEMPLATE.format(
            place_catalog_json=catalog_json,
        )

        # (version, label, system_prompt, user_content, allowed_kinds)
        # D (movement) and E (access) omitted — future characters layer, not atlas explorer.
        # F (containment) and G (dedup) omitted — run once globally post-catalog, not per section.
        _SUBPASSES: list[tuple[str, str, str, str, set[str]]] = [
            (GLOBAL_EVIDENCE_SPATIAL_VERSION,    "spatial",    SPATIAL_CLAIMS_SYSTEM_PROMPT, user_content, {"claim", "scene_anchor"}),
            (GLOBAL_EVIDENCE_VISUAL_VERSION,     "visual",     VISUAL_CLAIMS_SYSTEM_PROMPT,  user_content, {"visual_claim"}),
            (GLOBAL_EVIDENCE_TRAVELRULE_VERSION, "travelrule", TRAVELRULE_SYSTEM_PROMPT,     user_content, {"travel_rule"}),
        ]

        # Signal that all passes are starting in parallel (session-safe: single call on caller thread)
        if phase_callback:
            phase_callback("parallel")

        def _run_one(subpass: tuple) -> tuple[list[RawCandidate], int, int]:
            version, label, system_prompt, subpass_user, allowed_kinds = subpass
            try:
                resp = self._client.chat.completions.create(
                    model=self._model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": subpass_user},
                    ],
                    response_format={"type": "json_object"},
                    max_tokens=4096,
                )
                raw_text = resp.choices[0].message.content
                try:
                    in_tok = int(resp.usage.prompt_tokens)
                    out_tok = int(resp.usage.completion_tokens)
                except (AttributeError, TypeError, ValueError):
                    in_tok = out_tok = 0

                parsed = json.loads(raw_text)
                raw_list = parsed.get("candidates", [])
                if not isinstance(raw_list, list):
                    _log.warning("Evidence sub-pass %s: 'candidates' is not a list, got %r", label, type(raw_list).__name__)
                    raw_list = []
            except Exception as exc:
                _log.warning("Evidence sub-pass %s failed: %s", label, exc)
                return [], 0, 0

            if not raw_list:
                _log.info(
                    "Evidence sub-pass %s: model returned 0 raw candidates. Raw response: %.800s",
                    label, raw_text,
                )

            candidates: list[RawCandidate] = []
            skipped_status: list[str] = []
            skipped_kind: list[str] = []
            for raw in raw_list:
                if not isinstance(raw, dict):
                    continue
                status = raw.get("status", "")
                if status not in _VALID_STATUSES:
                    skipped_status.append(status or "(missing)")
                    continue
                kind = raw.get("kind", "")
                if kind not in allowed_kinds:
                    skipped_kind.append(kind or "(missing)")
                    continue
                temporal = raw.get("temporal_interpretation", "static")
                if temporal not in _VALID_TEMPORAL:
                    temporal = "static"
                candidates.append(RawCandidate(
                    kind=kind,
                    payload=raw.get("payload", {}),
                    status=status,
                    confidence=float(raw.get("confidence", 0.5)),
                    excerpt=str(raw.get("excerpt", "")),
                    rationale=str(raw.get("rationale", "")),
                    temporal_interpretation=temporal,
                ))

            _log.info(
                "Evidence sub-pass %s: %d raw → %d kept (skipped_status=%r, skipped_kind=%r)",
                label, len(raw_list), len(candidates), skipped_status, skipped_kind,
            )
            return candidates, in_tok, out_tok

        all_candidates: list[RawCandidate] = []
        total_in = 0
        total_out = 0

        with ThreadPoolExecutor(max_workers=len(_SUBPASSES)) as pool:
            futures = {pool.submit(_run_one, sp): sp for sp in _SUBPASSES}
            for future in as_completed(futures):
                cands, in_tok, out_tok = future.result()
                all_candidates.extend(cands)
                total_in += in_tok
                total_out += out_tok

        _log.info(
            "Evidence sub-passes complete: %d total candidates, %d input tokens, %d output tokens",
            len(all_candidates), total_in, total_out,
        )
        return all_candidates, total_in, total_out

    def extract_catalog_only(
        self,
        section: SourceSection,
        known_names: list[dict],
    ) -> ExtractionResult:
        """Global pre-pass: catalog-only, returns entity candidates."""
        catalog_user = CATALOG_USER_TEMPLATE.format(
            section_order=section.ordinal,
            title=section.title or "(untitled)",
            text=section.text or "",
            known_names_json=json.dumps(known_names, ensure_ascii=False),
        )
        resp = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": CATALOG_SYSTEM_PROMPT},
                {"role": "user", "content": catalog_user},
            ],
            response_format={"type": "json_object"},
            max_tokens=4096,
        )
        raw_text = resp.choices[0].message.content
        parsed: dict = {}
        new_places: list[dict] = []
        try:
            parsed = json.loads(raw_text)
            raw_places = parsed.get("places", [])
            new_places = raw_places if isinstance(raw_places, list) else []
        except json.JSONDecodeError:
            _log.warning("Catalog pass failed to parse JSON: %s", raw_text[:500])

        try:
            input_tokens = int(resp.usage.prompt_tokens)
            output_tokens = int(resp.usage.completion_tokens)
        except (AttributeError, TypeError, ValueError):
            input_tokens = 0
            output_tokens = 0

        entity_candidates: list[RawCandidate] = []
        for p in new_places:
            name = (p.get("name") or "").strip()
            ptype = (p.get("type") or "").strip().lower()
            if not name or ptype not in _ALLOWED_ENTITY_TYPES:
                continue
            if _BARE_POSSESSIVE_RE.search(name):
                _log.info("Catalog filter: dropped bare possessive %r", name)
                continue
            significance = (p.get("significance") or "").strip().lower()
            if significance == "passing":
                _log.info("Catalog filter: dropped passing-significance place %r", name)
                continue
            payload: dict[str, Any] = {"name": name, "type": ptype}
            if significance:
                payload["significance"] = significance
            lvl = p.get("spatial_level")
            if lvl is not None:
                try:
                    payload["spatial_level"] = int(lvl)
                except (TypeError, ValueError):
                    pass
            if p.get("kind_descriptor"):
                payload["kind_descriptor"] = str(p["kind_descriptor"]).strip().lower()
            if p.get("tier"):
                payload["tier"] = str(p["tier"]).strip().lower()
            if p.get("parent_context"):
                payload["parent_context"] = str(p["parent_context"]).strip()
            if p.get("note"):
                payload["note"] = str(p["note"]).strip()
            aliases = [a for a in (p.get("aliases") or []) if not _BARE_POSSESSIVE_RE.search(a or "")]
            if aliases:
                payload["aliases"] = aliases
            entity_candidates.append(RawCandidate(
                kind="entity",
                payload=payload,
                status="explicit" if p.get("is_new", True) else "inferred",
                confidence=float(p.get("confidence", 0.80)),
                excerpt=str(p.get("excerpt", "")),
                rationale="Global pre-pass catalog",
                temporal_interpretation="static",
            ))

        return ExtractionResult(
            candidates=entity_candidates,
            raw_response={"catalog": parsed},
            provider="openai",
            model=self._model,
            prompt_version=GLOBAL_CATALOG_VERSION,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

    def extract_catalog_gap(
        self,
        section: SourceSection,
        already_found: list[dict],
    ) -> ExtractionResult:
        """Gap pass: re-read section with already-found entities as context, find missed places."""
        gap_user = CATALOG_GAP_USER_TEMPLATE.format(
            section_order=section.ordinal,
            title=section.title or "(untitled)",
            text=section.text or "",
            already_found_json=json.dumps(already_found, ensure_ascii=False),
        )
        resp = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": CATALOG_GAP_SYSTEM_PROMPT},
                {"role": "user", "content": gap_user},
            ],
            response_format={"type": "json_object"},
            max_tokens=4096,
        )
        raw_text = resp.choices[0].message.content
        parsed: dict = {}
        new_places: list[dict] = []
        try:
            parsed = json.loads(raw_text)
            raw_places = parsed.get("places", [])
            new_places = raw_places if isinstance(raw_places, list) else []
        except json.JSONDecodeError:
            _log.warning("Catalog gap pass failed to parse JSON: %s", raw_text[:500])

        try:
            input_tokens = int(resp.usage.prompt_tokens)
            output_tokens = int(resp.usage.completion_tokens)
        except (AttributeError, TypeError, ValueError):
            input_tokens = 0
            output_tokens = 0

        # Normalize already_found names for dedup
        already_found_names = {(e.get("name") or "").strip().lower() for e in already_found}

        entity_candidates: list[RawCandidate] = []
        for p in new_places:
            name = (p.get("name") or "").strip()
            ptype = (p.get("type") or "").strip().lower()
            if not name or ptype not in _ALLOWED_ENTITY_TYPES:
                continue
            if name.lower() in already_found_names:
                continue  # LLM repeated a known entity despite instructions
            if _BARE_POSSESSIVE_RE.search(name):
                continue
            significance = (p.get("significance") or "").strip().lower()
            if significance == "passing":
                _log.info("Gap pass filter: dropped passing-significance place %r", name)
                continue
            payload: dict[str, Any] = {"name": name, "type": ptype}
            if significance:
                payload["significance"] = significance
            lvl = p.get("spatial_level")
            if lvl is not None:
                try:
                    payload["spatial_level"] = int(lvl)
                except (TypeError, ValueError):
                    pass
            if p.get("kind_descriptor"):
                payload["kind_descriptor"] = str(p["kind_descriptor"]).strip().lower()
            if p.get("tier"):
                payload["tier"] = str(p["tier"]).strip().lower()
            if p.get("parent_context"):
                payload["parent_context"] = str(p["parent_context"]).strip()
            if p.get("note"):
                payload["note"] = str(p["note"]).strip()
            aliases = [a for a in (p.get("aliases") or []) if not _BARE_POSSESSIVE_RE.search(a or "")]
            if aliases:
                payload["aliases"] = aliases
            entity_candidates.append(RawCandidate(
                kind="entity",
                payload=payload,
                status="explicit",
                confidence=float(p.get("confidence", 0.80)),
                excerpt=str(p.get("excerpt", "")),
                rationale="Gap pass catalog",
                temporal_interpretation="static",
            ))

        return ExtractionResult(
            candidates=entity_candidates,
            raw_response={"catalog_gap": parsed},
            provider="openai",
            model=self._model,
            prompt_version=GLOBAL_CATALOG_GAP_VERSION,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

    def extract_evidence_only(
        self,
        section: SourceSection,
        global_catalog: list[dict],
        phase_callback: Callable[[str], None] | None = None,
    ) -> ExtractionResult:
        """Global evidence pass: 7 focused sub-passes using the full global catalog."""
        catalog_names = [e.get("name", "?") for e in global_catalog[:8]]
        _log.info(
            "Evidence extraction: section %s (%r), catalog=%d places, sample=%r",
            section.id, section.title or "(untitled)", len(global_catalog), catalog_names,
        )
        if not global_catalog:
            _log.warning("Evidence extraction: global catalog is EMPTY — all sub-passes will find 0 candidates")
        candidates, total_in, total_out = self._run_evidence_subpasses(
            section=section,
            full_catalog_list=global_catalog,
            phase_callback=phase_callback,
        )
        return ExtractionResult(
            candidates=candidates,
            raw_response={},
            provider="openai",
            model=self._model,
            prompt_version=GLOBAL_EVIDENCE_VERSION,
            input_tokens=total_in,
            output_tokens=total_out,
        )

    def run_global_enrichment(
        self,
        global_catalog: list[dict],
        phase_callback: Callable[[str], None] | None = None,
        passes: list[str] | None = None,
    ) -> ExtractionResult:
        """Global enrichment: containment sweep + dedup, once per document using full catalog."""
        if not global_catalog:
            _log.warning("Global enrichment: catalog is EMPTY — skipping")
            return ExtractionResult(
                candidates=[], raw_response={}, provider="openai",
                model=self._model, prompt_version=GLOBAL_ENRICHMENT_VERSION,
                input_tokens=0, output_tokens=0,
            )

        catalog_json = json.dumps(global_catalog, ensure_ascii=False)
        catalog_only_content = CATALOG_ONLY_USER_TEMPLATE.format(place_catalog_json=catalog_json)

        _ALL_ENRICHMENT_PASSES: list[tuple[str, str, str]] = [
            (GLOBAL_EVIDENCE_CONTAINMENT_VERSION, "containment", CONTAINMENT_SWEEP_SYSTEM_PROMPT),
            (GLOBAL_EVIDENCE_DEDUP_VERSION,        "dedup",       ENTITY_DEDUP_SYSTEM_PROMPT),
        ]
        _ENRICHMENT_PASSES = [p for p in _ALL_ENRICHMENT_PASSES if passes is None or p[1] in passes]

        if phase_callback:
            phase_callback("enrichment")

        def _run_one(subpass: tuple) -> tuple[list[RawCandidate], int, int]:
            version, label, system_prompt = subpass
            try:
                resp = self._client.chat.completions.create(
                    model=self._model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": catalog_only_content},
                    ],
                    response_format={"type": "json_object"},
                    max_tokens=4096,
                )
                raw_text = resp.choices[0].message.content
                try:
                    in_tok = int(resp.usage.prompt_tokens)
                    out_tok = int(resp.usage.completion_tokens)
                except (AttributeError, TypeError, ValueError):
                    in_tok = out_tok = 0
                parsed = json.loads(raw_text)
                raw_list = parsed.get("candidates", [])
                if not isinstance(raw_list, list):
                    raw_list = []
            except Exception as exc:
                _log.warning("Global enrichment sub-pass %s failed: %s", label, exc)
                return [], 0, 0

            candidates: list[RawCandidate] = []
            for raw in raw_list:
                if not isinstance(raw, dict):
                    continue
                status = raw.get("status", "")
                if status not in _VALID_STATUSES:
                    continue
                kind = raw.get("kind", "")
                if kind not in {"claim"}:
                    continue
                candidates.append(RawCandidate(
                    kind=kind,
                    payload=raw.get("payload", {}),
                    status=status,
                    confidence=float(raw.get("confidence", 0.5)),
                    excerpt=str(raw.get("excerpt", "")),
                    rationale=str(raw.get("rationale", "")),
                    temporal_interpretation="static",
                ))
            _log.info("Global enrichment %s: %d raw → %d kept", label, len(raw_list), len(candidates))
            return candidates, in_tok, out_tok

        all_candidates: list[RawCandidate] = []
        total_in = total_out = 0
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = {pool.submit(_run_one, sp): sp for sp in _ENRICHMENT_PASSES}
            for future in as_completed(futures):
                cands, in_tok, out_tok = future.result()
                all_candidates.extend(cands)
                total_in += in_tok
                total_out += out_tok

        _log.info("Global enrichment complete: %d candidates, %d in / %d out tokens",
                  len(all_candidates), total_in, total_out)
        return ExtractionResult(
            candidates=all_candidates,
            raw_response={},
            provider="openai",
            model=self._model,
            prompt_version=GLOBAL_ENRICHMENT_VERSION,
            input_tokens=total_in,
            output_tokens=total_out,
        )


def get_provider() -> OpenAIExtractionProvider:
    """Instantiate the provider from environment variables.

    Raises ExtractionNotConfiguredError if either env var is absent.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    model = os.environ.get("OPENAI_EXTRACTION_MODEL")
    if not api_key or not model:
        raise ExtractionNotConfiguredError(
            "Extraction is not configured. "
            "Set OPENAI_API_KEY and OPENAI_EXTRACTION_MODEL environment variables."
        )
    from openai import OpenAI  # deferred so missing key never breaks import
    return OpenAIExtractionProvider(client=OpenAI(api_key=api_key), model=model)
