import json
import logging
import os
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.synthesis.prompts import (
    SYNTHESIS_PROMPT_VERSION,
    SYNTHESIS_SYSTEM_PROMPT,
    THREE_PASS_SYNTHESIS_VERSION,
    ENTITY_CONSOLIDATION_SYSTEM_PROMPT,
    SPATIAL_CLAIMS_SYNTHESIS_PROMPT,
    VISUAL_CLAIMS_SYNTHESIS_PROMPT,
    ROUTES_SYNTHESIS_PROMPT,
    ACCESS_SYNTHESIS_PROMPT,
    MOVEMENT_SYNTHESIS_PROMPT,
)

_log = logging.getLogger(__name__)

_VALID_KINDS = {"entity", "claim", "route", "visual_claim", "access", "movement", "same_as", "unresolved", "reveal_event"}


@dataclass
class RawSynthesisItem:
    kind: str
    payload: dict
    confidence: float
    rationale: str


@dataclass
class SynthesisResult:
    items: list[RawSynthesisItem]
    raw_response: dict
    provider: str
    model: str
    synthesis_prompt_version: str = field(default=SYNTHESIS_PROMPT_VERSION)


class SynthesisProvider(Protocol):
    def synthesize(self, evidence_ledger: list[dict]) -> SynthesisResult: ...


class SynthesisNotConfiguredError(RuntimeError):
    pass


class OpenAISynthesisProvider:
    def __init__(self, *, client: Any, model: str) -> None:
        self._client = client
        self._model = model

    def synthesize(self, evidence_ledger: list[dict]) -> SynthesisResult:
        ledger_json = json.dumps(evidence_ledger, indent=2, ensure_ascii=False)
        user_content = f"Evidence ledger ({len(evidence_ledger)} candidates):\n{ledger_json}\n\nSynthesize the provisional atlas."

        response = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": SYNTHESIS_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            max_tokens=8192,
        )

        raw_text = response.choices[0].message.content
        try:
            parsed = json.loads(raw_text)
            if "synthesis_items" not in parsed or not isinstance(parsed["synthesis_items"], list):
                raise ValueError("missing 'synthesis_items' array")
        except (json.JSONDecodeError, ValueError) as exc:
            raise ValueError(f"Failed to parse synthesis response: {exc}") from exc

        raw_list = parsed["synthesis_items"]
        if not raw_list:
            _log.warning("Synthesis provider returned 0 items. Raw: %s", raw_text[:2000])

        items: list[RawSynthesisItem] = []
        skipped_kind: list[str] = []
        for i, raw in enumerate(raw_list):
            if not isinstance(raw, dict):
                continue
            kind = raw.get("kind", "")
            if kind not in _VALID_KINDS:
                skipped_kind.append(kind)
                continue
            try:
                items.append(RawSynthesisItem(
                    kind=kind,
                    payload=raw.get("payload", {}),
                    confidence=float(raw.get("confidence", 0.7)),
                    rationale=str(raw.get("rationale", "")),
                ))
            except (KeyError, ValueError, TypeError) as exc:
                _log.warning("Synthesis item %d skipped due to parse error: %s", i, exc)

        if skipped_kind:
            _log.warning("Filtered %d synthesis items with unknown kinds: %s", len(skipped_kind), skipped_kind)

        return SynthesisResult(
            items=items,
            raw_response=parsed,
            provider="openai",
            model=self._model,
            synthesis_prompt_version=SYNTHESIS_PROMPT_VERSION,
        )


    def synthesize_two_pass(
        self,
        entity_ledger: list[dict],
        evidence_ledger: list[dict],
        phase_callback: Callable[[str], None] | None = None,
    ) -> SynthesisResult:
        """Pass 1: entity consolidation (with SAME_AS hints). Pass 2: 5 focused evidence sub-passes."""

        # ── Extract SAME_AS hints from evidence to feed Pass 1 ───────────────
        same_as_hints = [
            {
                "a": (item.get("payload") or {}).get("subject", ""),
                "b": (item.get("payload") or {}).get("object", ""),
            }
            for item in evidence_ledger
            if item.get("kind") == "claim"
            and (item.get("payload") or {}).get("predicate") == "SAME_AS"
        ]

        # ── Pass 1: entity consolidation ─────────────────────────────────────
        if phase_callback:
            phase_callback("entities")

        # Build must-include list from human-approved catalog entities.
        # These were explicitly reviewed and accepted by the user; the model
        # must not silently drop them during consolidation.
        must_include = [
            {
                "name": item["payload"].get("name", ""),
                "type": item["payload"].get("type", ""),
                "aliases": item["payload"].get("aliases", []),
            }
            for item in entity_ledger
            if item.get("review_state") == "approved" and item["payload"].get("name")
        ]

        entity_json = json.dumps(entity_ledger, indent=2, ensure_ascii=False)
        entity_user = ""
        if must_include:
            entity_user += (
                f"MUST-INCLUDE ENTITIES (human-approved catalog, {len(must_include)} entries):\n"
                f"Every entity in this list MUST appear in your output as an entity item. "
                f"You may merge two entries only if they are definitively the same place — "
                f"pick the more specific name as canonical and list the other as an alias. "
                f"Do not drop or omit any entry for any other reason.\n"
                f"{json.dumps(must_include, indent=2, ensure_ascii=False)}\n\n"
            )
        entity_user += f"Full entity candidates with section context ({len(entity_ledger)} unique places):\n{entity_json}\n\n"
        if same_as_hints:
            entity_user += (
                f"SAME_AS hints from evidence ({len(same_as_hints)} pairs) — "
                f"treat each pair as the same place and pick the most specific name as canonical:\n"
                f"{json.dumps(same_as_hints, indent=2, ensure_ascii=False)}\n\n"
            )
        entity_user += "Consolidate into canonical entities and reveal_events."

        entity_resp = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": ENTITY_CONSOLIDATION_SYSTEM_PROMPT},
                {"role": "user", "content": entity_user},
            ],
            response_format={"type": "json_object"},
            max_tokens=16384,
        )
        entity_parsed: dict = {}
        try:
            entity_parsed = json.loads(entity_resp.choices[0].message.content)
        except json.JSONDecodeError as exc:
            _log.warning("Entity consolidation pass failed to parse JSON: %s", exc)
        entity_raw = entity_parsed.get("synthesis_items", [])

        # Build canonical entity map: [{name, aliases}] for Golden Rule enforcement.
        # Also build a flat list of all names+aliases for non-spatial passes.
        canonical_entity_map: list[dict] = []
        canonical_names: list[str] = []
        for item in entity_raw:
            if item.get("kind") == "entity":
                payload = item.get("payload") or {}
                name = payload.get("name", "")
                aliases = [a for a in payload.get("aliases", []) if a]
                if name:
                    canonical_entity_map.append({"name": name, "aliases": aliases})
                    canonical_names.append(name)
                    canonical_names.extend(aliases)

        # ── Pass 2: 5 focused evidence sub-passes (run in parallel) ─────────
        _SUBPASSES: list[tuple[str, str, set[str], set[str]]] = [
            ("spatial",  SPATIAL_CLAIMS_SYNTHESIS_PROMPT,  {"claim", "scene_anchor"}, {"claim"}),
            ("visual",   VISUAL_CLAIMS_SYNTHESIS_PROMPT,   {"visual_claim"},           {"visual_claim"}),
            ("routes",   ROUTES_SYNTHESIS_PROMPT,           {"travel_rule"},            {"route"}),
            ("access",   ACCESS_SYNTHESIS_PROMPT,           {"access"},                 {"access"}),
            ("movement", MOVEMENT_SYNTHESIS_PROMPT,         {"movement"},               {"movement"}),
        ]

        # Spatial pass gets structured alias map; others get a flat name list
        entity_map_json = json.dumps(canonical_entity_map, ensure_ascii=False)
        entity_names_json = json.dumps(canonical_names, ensure_ascii=False)

        # Signal once on the caller thread (session-safe)
        if phase_callback:
            phase_callback("parallel")

        def _run_subpass(subpass: tuple) -> tuple[str, list[dict], dict]:
            subpass_name, system_prompt, input_kinds, allowed_output_kinds = subpass
            filtered = [item for item in evidence_ledger if item.get("kind") in input_kinds]
            if not filtered:
                _log.debug("Synthesis sub-pass %s: no candidates, skipping", subpass_name)
                return subpass_name, [], {}
            # Spatial pass uses structured alias map; others use flat name list
            if subpass_name == "spatial":
                entity_header = (
                    f"Canonical entity list ({len(canonical_entity_map)} entities with aliases):\n"
                    f"{entity_map_json}"
                )
            else:
                entity_header = (
                    f"Canonical entity list ({len(canonical_names)} names):\n"
                    f"{entity_names_json}"
                )
            sub_user = (
                f"{entity_header}\n\n"
                f"Evidence candidates ({len(filtered)} items):\n"
                f"{json.dumps(filtered, indent=2, ensure_ascii=False)}\n\n"
                f"Produce synthesis items of kind {sorted(allowed_output_kinds)} only."
            )
            try:
                sub_resp = self._client.chat.completions.create(
                    model=self._model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": sub_user},
                    ],
                    response_format={"type": "json_object"},
                    max_tokens=8192,
                )
                sub_parsed = json.loads(sub_resp.choices[0].message.content)
                sub_items = sub_parsed.get("synthesis_items", [])
                accepted = [r for r in sub_items if isinstance(r, dict) and r.get("kind") in allowed_output_kinds]
                dropped = len(sub_items) - len(accepted)
                if dropped:
                    _log.warning("Synthesis sub-pass %s: dropped %d items with wrong kind", subpass_name, dropped)
                _log.info("Synthesis sub-pass %s: %d input → %d output items", subpass_name, len(filtered), len(accepted))
                return subpass_name, accepted, sub_parsed
            except Exception as exc:
                _log.warning("Synthesis sub-pass %s failed: %s", subpass_name, exc)
                return subpass_name, [], {}

        all_claims_raw: list[dict] = []
        subpass_responses: dict[str, dict] = {}

        with ThreadPoolExecutor(max_workers=len(_SUBPASSES)) as pool:
            futures = {pool.submit(_run_subpass, sp): sp for sp in _SUBPASSES}
            for future in as_completed(futures):
                name, accepted, parsed = future.result()
                all_claims_raw.extend(accepted)
                if parsed:
                    subpass_responses[name] = parsed

        # ── Combine and parse all raw items ───────────────────────────────────
        all_raw = entity_raw + all_claims_raw
        items: list[RawSynthesisItem] = []
        for i, raw in enumerate(all_raw):
            if not isinstance(raw, dict):
                continue
            kind = raw.get("kind", "")
            payload = raw.get("payload", {})
            if kind not in _VALID_KINDS:
                continue
            try:
                items.append(RawSynthesisItem(
                    kind=kind,
                    payload=payload,
                    confidence=float(raw.get("confidence", 0.7)),
                    rationale=str(raw.get("rationale", "")),
                ))
            except (KeyError, ValueError, TypeError) as exc:
                _log.warning("Three-pass synthesis item %d skipped: %s", i, exc)

        return SynthesisResult(
            items=items,
            raw_response={"entity_pass": entity_parsed, **{f"pass2_{k}": v for k, v in subpass_responses.items()}},
            provider="openai",
            model=self._model,
            synthesis_prompt_version=THREE_PASS_SYNTHESIS_VERSION,
        )


def get_synthesis_provider() -> OpenAISynthesisProvider:
    api_key = os.environ.get("OPENAI_API_KEY")
    model = os.environ.get("OPENAI_SYNTHESIS_MODEL") or os.environ.get("OPENAI_EXTRACTION_MODEL")
    if not api_key or not model:
        raise SynthesisNotConfiguredError(
            "Synthesis is not configured. "
            "Set OPENAI_API_KEY and OPENAI_EXTRACTION_MODEL (or OPENAI_SYNTHESIS_MODEL) environment variables."
        )
    from openai import OpenAI
    return OpenAISynthesisProvider(client=OpenAI(api_key=api_key), model=model)
