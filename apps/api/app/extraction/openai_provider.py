import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

_log = logging.getLogger(__name__)

from app.db.models import SourceSection
import re

from app.extraction.prompts import (
    PROMPT_VERSION, SYSTEM_PROMPT, USER_TEMPLATE,
    COMBINED_PROMPT_VERSION,
    CATALOG_SYSTEM_PROMPT, CATALOG_USER_TEMPLATE,
    CATALOG_GAP_SYSTEM_PROMPT, CATALOG_GAP_USER_TEMPLATE,
    EVIDENCE_SYSTEM_PROMPT, EVIDENCE_USER_TEMPLATE,
    GLOBAL_CATALOG_VERSION, GLOBAL_EVIDENCE_VERSION,
    EVIDENCE_SUBPASS_USER_TEMPLATE,
    CATALOG_ONLY_USER_TEMPLATE,
    SPATIAL_CLAIMS_SYSTEM_PROMPT,
    VISUAL_CLAIMS_SYSTEM_PROMPT,
    TRAVELRULE_SYSTEM_PROMPT,
    MOVEMENT_SYSTEM_PROMPT,
    ACCESS_SYSTEM_PROMPT,
    CONTAINMENT_SWEEP_SYSTEM_PROMPT,
    ENTITY_DEDUP_SYSTEM_PROMPT,
    GLOBAL_EVIDENCE_SPATIAL_VERSION,
    GLOBAL_EVIDENCE_VISUAL_VERSION,
    GLOBAL_EVIDENCE_TRAVELRULE_VERSION,
    GLOBAL_EVIDENCE_MOVEMENT_VERSION,
    GLOBAL_EVIDENCE_ACCESS_VERSION,
    GLOBAL_EVIDENCE_CONTAINMENT_VERSION,
    GLOBAL_EVIDENCE_DEDUP_VERSION,
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

    def extract(
        self,
        section: SourceSection,
        known_entities: list[dict],
    ) -> ExtractionResult:
        user_content = USER_TEMPLATE.format(
            section_id=section.id,
            section_order=section.ordinal,
            title=section.title or "(untitled)",
            text=section.text,
            known_spatial_entities_json=json.dumps(known_entities, ensure_ascii=False),
            known_candidate_ids_json=json.dumps([]),
        )
        response = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            max_tokens=8192,
        )

        raw_text = response.choices[0].message.content
        try:
            parsed = json.loads(raw_text)
            if "candidates" not in parsed or not isinstance(parsed["candidates"], list):
                raise ValueError("missing 'candidates' array")
        except (json.JSONDecodeError, ValueError) as exc:
            raise ValueError(f"Failed to parse provider response: {exc}") from exc

        raw_list = parsed["candidates"]
        if not raw_list:
            _log.warning("Provider returned 0 candidates. Raw response: %s", raw_text[:2000])

        candidates: list[RawCandidate] = []
        skipped_status: list[str] = []
        skipped_kind: list[str] = []
        for raw in raw_list:
            if not isinstance(raw, dict):
                continue
            status = raw.get("status", "")
            if status not in _VALID_STATUSES:
                skipped_status.append(status)
                continue
            kind = raw.get("kind", "")
            if kind not in _VALID_KINDS:
                skipped_kind.append(kind)
                continue
            temporal = raw.get("temporal_interpretation", "static")
            if temporal not in _VALID_TEMPORAL:
                temporal = "static"

            relation_kind = raw.get("relation_kind") or None
            if relation_kind not in _VALID_RELATION_KINDS:
                relation_kind = None

            candidates.append(RawCandidate(
                kind=kind,
                payload=raw.get("payload", {}),
                status=status,
                confidence=float(raw.get("confidence", 0.5)),
                excerpt=str(raw.get("excerpt", "")),
                rationale=str(raw.get("rationale", "")),
                temporal_interpretation=temporal,
                first_revealed_at_section_id=raw.get("first_revealed_at_section_id") or None,
                relation_kind=relation_kind,
                relation_target_id=raw.get("relation_target_id") or None,
            ))

        if skipped_status:
            _log.warning("Filtered %d candidates with unknown status values: %s", len(skipped_status), skipped_status)
        if skipped_kind:
            _log.warning("Filtered %d candidates with unknown kind values: %s", len(skipped_kind), skipped_kind)
        if not candidates and raw_list:
            _log.warning("All %d model candidates were filtered out. First raw item: %s", len(raw_list), raw_list[0])

        try:
            input_tokens = int(response.usage.prompt_tokens)
            output_tokens = int(response.usage.completion_tokens)
        except (AttributeError, TypeError, ValueError):
            input_tokens = None
            output_tokens = None

        return ExtractionResult(
            candidates=candidates,
            raw_response=parsed,
            provider="openai",
            model=self._model,
            prompt_version=PROMPT_VERSION,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )


    def extract_two_pass(
        self,
        section: SourceSection,
        cumulative_catalog: list[dict],
    ) -> ExtractionResult:
        """Two-pass extraction: catalog first, then evidence anchored to catalog."""

        # ── Pass 1: Place Catalog ─────────────────────────────────────────────
        known_names = [{"name": e["name"], "type": e.get("type", "")} for e in cumulative_catalog]
        catalog_user = CATALOG_USER_TEMPLATE.format(
            section_order=section.ordinal,
            title=section.title or "(untitled)",
            text=section.text or "",
            known_names_json=json.dumps(known_names, ensure_ascii=False),
        )
        catalog_resp = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": CATALOG_SYSTEM_PROMPT},
                {"role": "user", "content": catalog_user},
            ],
            response_format={"type": "json_object"},
            max_tokens=4096,
        )
        catalog_text = catalog_resp.choices[0].message.content
        catalog_parsed: dict = {}
        new_places: list[dict] = []
        try:
            catalog_parsed = json.loads(catalog_text)
            raw_places = catalog_parsed.get("places", [])
            new_places = raw_places if isinstance(raw_places, list) else []
        except json.JSONDecodeError:
            _log.warning("Catalog pass failed to parse JSON: %s", catalog_text[:500])

        try:
            catalog_input_tokens = int(catalog_resp.usage.prompt_tokens)
            catalog_output_tokens = int(catalog_resp.usage.completion_tokens)
        except (AttributeError, TypeError, ValueError):
            catalog_input_tokens = 0
            catalog_output_tokens = 0

        # Build entity RawCandidates from new catalog places
        entity_candidates: list[RawCandidate] = []
        for p in new_places:
            name = (p.get("name") or "").strip()
            ptype = (p.get("type") or "").strip().lower()
            if not name or ptype not in _ALLOWED_ENTITY_TYPES:
                continue
            # Reject bare possessives: "Hans Van Ripper's" is a person, not a place.
            # "Van Tassel's mansion" is fine — it doesn't end with "'s".
            if _BARE_POSSESSIVE_RE.search(name):
                _log.info("Catalog filter: dropped bare possessive %r", name)
                continue
            payload: dict[str, Any] = {"name": name, "type": ptype}
            lvl = p.get("spatial_level")
            if lvl is not None:
                try:
                    payload["spatial_level"] = int(lvl)
                except (TypeError, ValueError):
                    pass
            aliases = [a for a in (p.get("aliases") or []) if not _BARE_POSSESSIVE_RE.search(a or "")]
            if aliases:
                payload["aliases"] = aliases
            entity_candidates.append(RawCandidate(
                kind="entity",
                payload=payload,
                status="explicit" if p.get("is_new", True) else "inferred",
                confidence=float(p.get("confidence", 0.80)),
                excerpt=str(p.get("excerpt", "")),
                rationale="Place catalog pass 1",
                temporal_interpretation="static",
            ))

        # ── Pass 2: Evidence — 5 focused sub-passes ──────────────────────────
        cumulative_names = {e["name"] for e in cumulative_catalog}
        full_catalog_list = list(cumulative_catalog) + [
            {"name": p["name"], "type": p.get("type", ""), "aliases": p.get("aliases", [])}
            for p in new_places
            if p.get("name") and p["name"] not in cumulative_names
        ]
        subpass_candidates, subpass_in, subpass_out = self._run_evidence_subpasses(
            section=section,
            full_catalog_list=full_catalog_list,
        )

        return ExtractionResult(
            candidates=entity_candidates + subpass_candidates,
            raw_response={"catalog": catalog_parsed},
            provider="openai",
            model=self._model,
            prompt_version=COMBINED_PROMPT_VERSION,
            input_tokens=catalog_input_tokens + subpass_in,
            output_tokens=catalog_output_tokens + subpass_out,
        )


    def _run_evidence_subpasses(
        self,
        section: SourceSection,
        full_catalog_list: list[dict],
        phase_callback=None,
    ) -> tuple[list[RawCandidate], int, int]:
        """Run all 5 focused evidence sub-passes and return merged candidates + token counts."""

        catalog_json = json.dumps(
            [{"name": e["name"], "type": e.get("type", "")} for e in full_catalog_list],
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
        _SUBPASSES: list[tuple[str, str, str, str, set[str]]] = [
            # Text + catalog passes
            (GLOBAL_EVIDENCE_SPATIAL_VERSION,    "spatial",     SPATIAL_CLAIMS_SYSTEM_PROMPT,    user_content,         {"claim", "scene_anchor"}),
            (GLOBAL_EVIDENCE_VISUAL_VERSION,     "visual",      VISUAL_CLAIMS_SYSTEM_PROMPT,     user_content,         {"visual_claim"}),
            (GLOBAL_EVIDENCE_TRAVELRULE_VERSION, "routes",      TRAVELRULE_SYSTEM_PROMPT,        user_content,         {"travel_rule"}),
            (GLOBAL_EVIDENCE_MOVEMENT_VERSION,   "movement",    MOVEMENT_SYSTEM_PROMPT,          user_content,         {"movement"}),
            (GLOBAL_EVIDENCE_ACCESS_VERSION,     "access",      ACCESS_SYSTEM_PROMPT,            user_content,         {"access"}),
            # Catalog-only passes (no section text needed)
            (GLOBAL_EVIDENCE_CONTAINMENT_VERSION, "containment", CONTAINMENT_SWEEP_SYSTEM_PROMPT, catalog_only_content, {"claim"}),
            (GLOBAL_EVIDENCE_DEDUP_VERSION,       "dedup",       ENTITY_DEDUP_SYSTEM_PROMPT,      catalog_only_content, {"claim"}),
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
                    raw_list = []
            except Exception as exc:
                _log.warning("Evidence sub-pass %s failed: %s", version, exc)
                return [], 0, 0

            candidates: list[RawCandidate] = []
            for raw in raw_list:
                if not isinstance(raw, dict):
                    continue
                status = raw.get("status", "")
                if status not in _VALID_STATUSES:
                    continue
                kind = raw.get("kind", "")
                if kind not in allowed_kinds:
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
            payload: dict[str, Any] = {"name": name, "type": ptype}
            lvl = p.get("spatial_level")
            if lvl is not None:
                try:
                    payload["spatial_level"] = int(lvl)
                except (TypeError, ValueError):
                    pass
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
            payload: dict[str, Any] = {"name": name, "type": ptype}
            lvl = p.get("spatial_level")
            if lvl is not None:
                try:
                    payload["spatial_level"] = int(lvl)
                except (TypeError, ValueError):
                    pass
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
        phase_callback=None,
    ) -> ExtractionResult:
        """Global evidence pass: 7 focused sub-passes using the full global catalog."""
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
