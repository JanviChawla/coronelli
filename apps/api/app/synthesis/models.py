import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.db.base import Base
from app.synthesis.display import synthesis_item_display_summary


class SynthesisRun(Base):
    __tablename__ = "synthesis_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    document_id: Mapped[str] = mapped_column(
        String, ForeignKey("source_documents.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(String, nullable=False)  # running | completed | failed
    provider: Mapped[str] = mapped_column(String, nullable=False)
    model: Mapped[str] = mapped_column(String, nullable=False)
    synthesis_prompt_version: Mapped[str] = mapped_column(String, nullable=False)
    raw_response: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    evidence_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SynthesisItem(Base):
    __tablename__ = "synthesis_items"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    synthesis_run_id: Mapped[str] = mapped_column(
        String, ForeignKey("synthesis_runs.id", ondelete="CASCADE"), nullable=False
    )
    document_id: Mapped[str] = mapped_column(
        String, ForeignKey("source_documents.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    review_state: Mapped[str] = mapped_column(String, nullable=False, default="provisional")
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    @property
    def display_summary(self) -> str:
        return synthesis_item_display_summary(self.kind, self.payload)
