import uuid
from datetime import datetime, timezone
from typing import Literal

from sqlalchemy import DateTime, String, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.db.base import Base


class Series(Base):
    __tablename__ = "series"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String, nullable=False)
    category: Mapped[str] = mapped_column(String, nullable=False)  # "demo" | "private"
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )


class SeriesError(Exception):
    pass


def _has_review_activity(session: Session, document_id: str) -> bool:
    """True if the document has any reviewed candidates or canonical records."""
    from app.extraction.models import Candidate
    from app.db.models import SourceSection
    from app.domain.world import MapClaim, MapEntity, MapTravelRule

    reviewed = (
        session.query(Candidate)
        .join(SourceSection, Candidate.section_id == SourceSection.id)
        .filter(
            SourceSection.document_id == document_id,
            Candidate.review_state != "proposed",
        )
        .first()
    )
    if reviewed:
        return True

    for model in (MapEntity, MapClaim, MapTravelRule):
        if session.query(model).filter(model.provenance_document_id == document_id).first():
            return True

    return False


def create_series(
    session: Session,
    name: str,
    category: Literal["demo", "private"],
) -> Series:
    s = Series(id=str(uuid.uuid4()), name=name, category=category)
    session.add(s)
    session.commit()
    session.refresh(s)
    return s


def get_series(session: Session, series_id: str) -> Series | None:
    return session.get(Series, series_id)


def list_series(session: Session) -> list[Series]:
    return list(session.execute(select(Series).order_by(Series.name)).scalars().all())


def assign_to_series(
    session: Session,
    document_id: str,
    series_id: str,
    series_order: int,
) -> None:
    from app.db.models import SourceDocument

    doc = session.get(SourceDocument, document_id)
    if doc is None:
        raise SeriesError(f"Document '{document_id}' not found.")

    series = session.get(Series, series_id)
    if series is None:
        raise SeriesError(f"Series '{series_id}' not found.")

    if _has_review_activity(session, document_id):
        raise SeriesError(
            f"Document '{document_id}' has review activity or accepted atlas data. "
            "Reassignment is blocked to protect provenance integrity."
        )

    doc.series_id = series_id
    doc.series_order = series_order
    session.commit()


def remove_from_series(session: Session, document_id: str) -> None:
    from app.db.models import SourceDocument

    doc = session.get(SourceDocument, document_id)
    if doc is None:
        raise SeriesError(f"Document '{document_id}' not found.")

    if _has_review_activity(session, document_id):
        raise SeriesError(
            f"Document '{document_id}' has review activity or accepted atlas data. "
            "Removal from series is blocked to protect provenance integrity."
        )

    doc.series_id = None
    doc.series_order = None
    session.commit()


def delete_series(session: Session, series_id: str) -> None:
    from app.db.models import SourceDocument

    series = session.get(Series, series_id)
    if series is None:
        raise SeriesError(f"Series '{series_id}' not found.")

    books = session.query(SourceDocument).filter(SourceDocument.series_id == series_id).count()
    if books > 0:
        raise SeriesError(
            f"Series '{series_id}' still has {books} book(s) assigned. "
            "Remove all books before deleting the series."
        )

    session.delete(series)
    session.commit()
