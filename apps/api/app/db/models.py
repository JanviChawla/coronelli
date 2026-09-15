import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base

# Import domain models so Base.metadata includes them everywhere models.py is imported.
import app.extraction.models  # noqa: F401, E402
import app.domain.world  # noqa: F401, E402
import app.domain.review  # noqa: F401, E402
import app.domain.series  # noqa: F401, E402
import app.synthesis.models  # noqa: F401, E402


class SourceDocument(Base):
    __tablename__ = "source_documents"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    title: Mapped[str] = mapped_column(String, nullable=False)
    original_filename: Mapped[str] = mapped_column(String, nullable=False)
    mime_type: Mapped[str] = mapped_column(String, nullable=False)
    content_hash: Mapped[str] = mapped_column(String, nullable=False)
    imported_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    parser_version: Mapped[str] = mapped_column(String, nullable=False)
    category: Mapped[str] = mapped_column(String, nullable=False)
    series_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("series.id", ondelete="SET NULL"), nullable=True
    )
    series_order: Mapped[int | None] = mapped_column(Integer, nullable=True)

    sections: Mapped[list["SourceSection"]] = relationship(
        "SourceSection",
        back_populates="document",
        cascade="all, delete-orphan",
        order_by="SourceSection.ordinal",
    )


class SourceSection(Base):
    __tablename__ = "source_sections"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    document_id: Mapped[str] = mapped_column(
        String, ForeignKey("source_documents.id", ondelete="CASCADE"), nullable=False
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str | None] = mapped_column(String, nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    page_start: Mapped[int | None] = mapped_column(Integer, nullable=True)
    page_end: Mapped[int | None] = mapped_column(Integer, nullable=True)
    user_corrected: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    document: Mapped["SourceDocument"] = relationship("SourceDocument", back_populates="sections")
