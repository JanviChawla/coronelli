import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.db.base import Base
from app.extraction.display import candidate_display_summary


class ExtractionRun(Base):
    __tablename__ = "extraction_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    section_id: Mapped[str] = mapped_column(
        String, ForeignKey("source_sections.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(String, nullable=False)  # "completed" | "failed"
    provider: Mapped[str] = mapped_column(String, nullable=False)
    model: Mapped[str] = mapped_column(String, nullable=False)
    prompt_version: Mapped[str] = mapped_column(String, nullable=False)
    raw_response: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    estimated_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    section_content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)


class Candidate(Base):
    __tablename__ = "candidates"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    extraction_run_id: Mapped[str] = mapped_column(
        String, ForeignKey("extraction_runs.id", ondelete="CASCADE"), nullable=False
    )
    section_id: Mapped[str] = mapped_column(
        String, ForeignKey("source_sections.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String, nullable=False)  # entity|claim|travel_rule|visual_claim
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False)  # explicit|inferred
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    excerpt: Mapped[str] = mapped_column(Text, nullable=False)
    rationale: Mapped[str] = mapped_column(Text, nullable=False)
    review_state: Mapped[str] = mapped_column(String, nullable=False, default="proposed")
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    temporal_interpretation: Mapped[str] = mapped_column(String, nullable=False, default="static")
    first_revealed_at_section_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("source_sections.id", ondelete="SET NULL"), nullable=True
    )
    relation_kind: Mapped[str | None] = mapped_column(String, nullable=True)
    relation_target_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("candidates.id", ondelete="SET NULL"), nullable=True
    )
    is_mention: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    @property
    def display_summary(self) -> str:
        return candidate_display_summary(self.kind, self.payload)
