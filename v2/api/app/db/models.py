import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_uuid() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    title: Mapped[str] = mapped_column(String, nullable=False)
    author: Mapped[str | None] = mapped_column(String, nullable=True)
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String, default="raw", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    sections: Mapped[list["Section"]] = relationship(
        "Section", back_populates="document", cascade="all, delete-orphan"
    )
    places: Mapped[list["Place"]] = relationship(
        "Place", back_populates="document", cascade="all, delete-orphan"
    )
    claims: Mapped[list["Claim"]] = relationship(
        "Claim", back_populates="document", cascade="all, delete-orphan"
    )


class Section(Base):
    __tablename__ = "sections"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    document_id: Mapped[str] = mapped_column(
        String, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str | None] = mapped_column(String, nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    catalog_status: Mapped[str] = mapped_column(String, default="pending", nullable=False)
    catalog_hash: Mapped[str | None] = mapped_column(String, nullable=True)

    document: Mapped["Document"] = relationship("Document", back_populates="sections")
    places: Mapped[list["Place"]] = relationship(
        "Place", foreign_keys="Place.first_section_id", back_populates="first_section"
    )


class Place(Base):
    __tablename__ = "places"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    document_id: Mapped[str] = mapped_column(
        String, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    first_section_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("sections.id", ondelete="SET NULL"), nullable=True
    )

    name: Mapped[str] = mapped_column(String, nullable=False)
    aliases: Mapped[list[Any]] = mapped_column(JSON, default=list)
    kind: Mapped[str | None] = mapped_column(String, nullable=True)
    kind_descriptor: Mapped[str | None] = mapped_column(String, nullable=True)

    spatial_level: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tier: Mapped[str | None] = mapped_column(String, nullable=True)

    parent_context: Mapped[str | None] = mapped_column(String, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    palette: Mapped[list[Any] | None] = mapped_column(JSON, nullable=True)

    is_edge: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    status: Mapped[str] = mapped_column(String, default="candidate", nullable=False)
    source: Mapped[str] = mapped_column(String, default="catalog", nullable=False)
    payload: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    document: Mapped["Document"] = relationship("Document", back_populates="places")
    first_section: Mapped["Section | None"] = relationship(
        "Section", foreign_keys=[first_section_id], back_populates="places"
    )
    atlas_position: Mapped["AtlasPosition | None"] = relationship(
        "AtlasPosition", back_populates="place", cascade="all, delete-orphan"
    )


class Claim(Base):
    __tablename__ = "claims"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    document_id: Mapped[str] = mapped_column(
        String, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    section_id: Mapped[str] = mapped_column(
        String, ForeignKey("sections.id", ondelete="CASCADE"), nullable=False
    )
    claim_type: Mapped[str] = mapped_column(String, nullable=False)
    subject_id: Mapped[str] = mapped_column(
        String, ForeignKey("places.id", ondelete="CASCADE"), nullable=False
    )
    predicate: Mapped[str | None] = mapped_column(String, nullable=True)
    object_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("places.id", ondelete="SET NULL"), nullable=True
    )
    payload: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    excerpt: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)

    document: Mapped["Document"] = relationship("Document", back_populates="claims")


class AtlasPosition(Base):
    __tablename__ = "atlas_positions"

    place_id: Mapped[str] = mapped_column(
        String, ForeignKey("places.id", ondelete="CASCADE"), primary_key=True
    )
    x: Mapped[float] = mapped_column(Float, nullable=False)
    z: Mapped[float] = mapped_column(Float, nullable=False)
    layout_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    place: Mapped["Place"] = relationship("Place", back_populates="atlas_position")
