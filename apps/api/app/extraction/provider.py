from dataclasses import dataclass, field
from typing import Any, Protocol

from app.db.models import SourceSection


@dataclass
class RawCandidate:
    kind: str           # entity | claim | travel_rule | visual_claim | scene_anchor
    payload: dict[str, Any]
    status: str         # explicit | inferred
    confidence: float
    excerpt: str
    rationale: str
    temporal_interpretation: str = "static"          # static|discovery|knowledge_revision|world_state_change
    first_revealed_at_section_id: str | None = None
    relation_kind: str | None = None                 # supersedes|contradicts|qualifies
    relation_target_id: str | None = None            # FK → candidates.id


@dataclass
class ExtractionResult:
    candidates: list[RawCandidate]
    raw_response: dict[str, Any]
    provider: str
    model: str
    prompt_version: str
    input_tokens: int | None = None
    output_tokens: int | None = None


class ExtractionProvider(Protocol):
    def extract(
        self,
        section: SourceSection,
        known_entities: list[dict],
    ) -> ExtractionResult: ...
