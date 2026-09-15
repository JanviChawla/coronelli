import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.synthesis.prompts import (
    SYNTHESIS_PROMPT_VERSION,
    SYNTHESIS_SYSTEM_PROMPT,
    TWO_PASS_SYNTHESIS_VERSION,
    ENTITY_CONSOLIDATION_SYSTEM_PROMPT,
    CLAIMS_SYNTHESIS_SYSTEM_PROMPT,
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
    ) -> SynthesisResult:
        """Pass 1: entity consolidation. Pass 2: claims/visual/routes against confirmed entities."""

        # ── Pass 1: entities ──────────────────────────────────────────────────
        entity_json = json.dumps(entity_ledger, indent=2, ensure_ascii=False)
        entity_user = (
            f"Entity candidates ({len(entity_ledger)} unique places):\n"
            f"{entity_json}\n\n"
            "Consolidate into canonical entities and reveal_events."
        )
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

        # Extract canonical names + aliases for the golden rule in pass 2
        canonical_names: list[str] = []
        for item in entity_raw:
            if item.get("kind") == "entity":
                name = (item.get("payload") or {}).get("name", "")
                if name:
                    canonical_names.append(name)
                    for alias in (item.get("payload") or {}).get("aliases", []):
                        if alias:
                            canonical_names.append(alias)

        # ── Pass 2: evidence against confirmed entity list ────────────────────
        claims_parsed: dict = {}
        claims_raw: list = []
        if evidence_ledger:
            evidence_json = json.dumps(evidence_ledger, indent=2, ensure_ascii=False)
            claims_user = (
                f"Canonical entity list ({len(canonical_names)} names):\n"
                f"{json.dumps(canonical_names, ensure_ascii=False)}\n\n"
                f"Evidence candidates ({len(evidence_ledger)} items):\n"
                f"{evidence_json}\n\n"
                "Synthesize the evidence. Remember: discard any claim where subject or object is not in the entity list."
            )
            claims_resp = self._client.chat.completions.create(
                model=self._model,
                messages=[
                    {"role": "system", "content": CLAIMS_SYNTHESIS_SYSTEM_PROMPT},
                    {"role": "user", "content": claims_user},
                ],
                response_format={"type": "json_object"},
                max_tokens=16384,
            )
            try:
                claims_parsed = json.loads(claims_resp.choices[0].message.content)
                claims_raw = claims_parsed.get("synthesis_items", [])
            except json.JSONDecodeError as exc:
                _log.warning("Claims synthesis pass failed to parse JSON: %s", exc)

        # ── Combine and parse ─────────────────────────────────────────────────
        all_raw = entity_raw + claims_raw
        items: list[RawSynthesisItem] = []
        for i, raw in enumerate(all_raw):
            if not isinstance(raw, dict):
                continue
            kind = raw.get("kind", "")
            if kind not in _VALID_KINDS:
                continue
            try:
                items.append(RawSynthesisItem(
                    kind=kind,
                    payload=raw.get("payload", {}),
                    confidence=float(raw.get("confidence", 0.7)),
                    rationale=str(raw.get("rationale", "")),
                ))
            except (KeyError, ValueError, TypeError) as exc:
                _log.warning("Two-pass synthesis item %d skipped: %s", i, exc)

        return SynthesisResult(
            items=items,
            raw_response={"entity_pass": entity_parsed, "claims_pass": claims_parsed},
            provider="openai",
            model=self._model,
            synthesis_prompt_version=TWO_PASS_SYNTHESIS_VERSION,
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
