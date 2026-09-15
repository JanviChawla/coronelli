import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.synthesis.prompts import SYNTHESIS_PROMPT_VERSION, SYNTHESIS_SYSTEM_PROMPT

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
