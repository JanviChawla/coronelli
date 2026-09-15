import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.db.base import Base


class MapEntity(Base):
    __tablename__ = "map_entities"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String, nullable=False)
    entity_kind: Mapped[str] = mapped_column(String, nullable=False, default="place")
    place_kind: Mapped[str | None] = mapped_column(String, nullable=True)
    parent_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("map_entities.id", ondelete="SET NULL"), nullable=True
    )
    map_behavior: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="explicit")
    state: Mapped[str] = mapped_column(String, nullable=False, default="active")
    provenance_document_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("source_documents.id", ondelete="SET NULL"), nullable=True
    )
    provenance_section_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("source_sections.id", ondelete="SET NULL"), nullable=True
    )
    candidate_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("candidates.id", ondelete="SET NULL"), nullable=True
    )
    aliases: Mapped[list | None] = mapped_column(JSON, nullable=True, default=list)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )


class MapClaim(Base):
    __tablename__ = "map_claims"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    claim_type: Mapped[str] = mapped_column(String, nullable=False)  # "spatial" | "visual"
    subject_ref: Mapped[str | None] = mapped_column(
        String, ForeignKey("map_entities.id", ondelete="SET NULL"), nullable=True
    )
    predicate: Mapped[str | None] = mapped_column(String, nullable=True)
    object_refs: Mapped[list | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="explicit")
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    provenance_document_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("source_documents.id", ondelete="SET NULL"), nullable=True
    )
    provenance_section_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("source_sections.id", ondelete="SET NULL"), nullable=True
    )
    excerpt: Mapped[str | None] = mapped_column(Text, nullable=True)
    state: Mapped[str] = mapped_column(String, nullable=False, default="active")
    candidate_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("candidates.id", ondelete="SET NULL"), nullable=True
    )
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )


class MapTravelRule(Base):
    __tablename__ = "map_travel_rules"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    traveler: Mapped[str | None] = mapped_column(String, nullable=True)
    can_traverse: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    route: Mapped[str | None] = mapped_column(String, nullable=True)
    condition: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="explicit")
    state: Mapped[str] = mapped_column(String, nullable=False, default="active")
    provenance_document_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("source_documents.id", ondelete="SET NULL"), nullable=True
    )
    provenance_section_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("source_sections.id", ondelete="SET NULL"), nullable=True
    )
    candidate_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("candidates.id", ondelete="SET NULL"), nullable=True
    )
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
