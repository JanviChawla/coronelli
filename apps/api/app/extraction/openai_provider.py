import json
import os
from typing import Any

from app.db.models import SourceSection
from app.extraction.prompts import PROMPT_VERSION, SYSTEM_PROMPT, USER_TEMPLATE
from app.extraction.provider import ExtractionResult, RawCandidate

_VALID_STATUSES = {"explicit", "inferred"}
_VALID_KINDS = {"entity", "claim", "travel_rule", "visual_claim", "scene_anchor"}
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
            title=section.title or "(untitled)",
            text=section.text,
            known_entities_json=json.dumps(known_entities, ensure_ascii=False),
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

        candidates: list[RawCandidate] = []
        for raw in parsed["candidates"]:
            if not isinstance(raw, dict):
                continue
            status = raw.get("status", "")
            if status not in _VALID_STATUSES:
                # Strip imagined or unknown statuses rather than failing the whole run.
                continue
            kind = raw.get("kind", "")
            if kind not in _VALID_KINDS:
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
