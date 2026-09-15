import json
import logging
import os
from typing import Any

_log = logging.getLogger(__name__)

from app.db.models import SourceSection
from app.extraction.prompts import (
    PROMPT_VERSION, SYSTEM_PROMPT, USER_TEMPLATE,
    COMBINED_PROMPT_VERSION,
    CATALOG_SYSTEM_PROMPT, CATALOG_USER_TEMPLATE,
    EVIDENCE_SYSTEM_PROMPT, EVIDENCE_USER_TEMPLATE,
)
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
            payload: dict[str, Any] = {"name": name, "type": ptype}
            aliases = p.get("aliases") or []
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

        # ── Pass 2: Evidence Extraction ───────────────────────────────────────
        cumulative_names = {e["name"] for e in cumulative_catalog}
        full_catalog_list = list(cumulative_catalog) + [
            {"name": p["name"], "type": p.get("type", ""), "aliases": p.get("aliases", [])}
            for p in new_places
            if p.get("name") and p["name"] not in cumulative_names
        ]

        evidence_user = EVIDENCE_USER_TEMPLATE.format(
            section_order=section.ordinal,
            title=section.title or "(untitled)",
            text=section.text or "",
            place_catalog_json=json.dumps(
                [{"name": e["name"], "type": e.get("type", "")} for e in full_catalog_list],
                ensure_ascii=False,
            ),
        )
        evidence_resp = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": EVIDENCE_SYSTEM_PROMPT},
                {"role": "user", "content": evidence_user},
            ],
            response_format={"type": "json_object"},
            max_tokens=8192,
        )
        evidence_text = evidence_resp.choices[0].message.content
        evidence_parsed: dict = {}
        raw_evidence: list = []
        try:
            evidence_parsed = json.loads(evidence_text)
            raw_ev = evidence_parsed.get("candidates", [])
            raw_evidence = raw_ev if isinstance(raw_ev, list) else []
        except json.JSONDecodeError:
            _log.warning("Evidence pass failed to parse JSON: %s", evidence_text[:500])

        try:
            evidence_input_tokens = int(evidence_resp.usage.prompt_tokens)
            evidence_output_tokens = int(evidence_resp.usage.completion_tokens)
        except (AttributeError, TypeError, ValueError):
            evidence_input_tokens = 0
            evidence_output_tokens = 0

        _EVIDENCE_KINDS = {"claim", "travel_rule", "visual_claim", "access", "movement", "scene_anchor"}
        evidence_candidates: list[RawCandidate] = []
        for raw in raw_evidence:
            if not isinstance(raw, dict):
                continue
            status = raw.get("status", "")
            if status not in _VALID_STATUSES:
                continue
            kind = raw.get("kind", "")
            if kind not in _EVIDENCE_KINDS:
                continue
            temporal = raw.get("temporal_interpretation", "static")
            if temporal not in _VALID_TEMPORAL:
                temporal = "static"
            evidence_candidates.append(RawCandidate(
                kind=kind,
                payload=raw.get("payload", {}),
                status=status,
                confidence=float(raw.get("confidence", 0.5)),
                excerpt=str(raw.get("excerpt", "")),
                rationale=str(raw.get("rationale", "")),
                temporal_interpretation=temporal,
            ))

        return ExtractionResult(
            candidates=entity_candidates + evidence_candidates,
            raw_response={"catalog": catalog_parsed, "evidence": evidence_parsed},
            provider="openai",
            model=self._model,
            prompt_version=COMBINED_PROMPT_VERSION,
            input_tokens=catalog_input_tokens + evidence_input_tokens,
            output_tokens=catalog_output_tokens + evidence_output_tokens,
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
