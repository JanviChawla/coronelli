from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.db.models import SourceDocument
from app.domain.series import Series, SeriesError, assign_to_series as _assign, create_series, delete_series, get_series, list_series, remove_from_series as _remove

router = APIRouter(tags=["series"])


# ── Response models ───────────────────────────────────────────────────────────

class BookSummary(BaseModel):
    id: str
    title: str
    series_order: int | None

    model_config = {"from_attributes": True}


class SeriesOut(BaseModel):
    id: str
    name: str
    category: str
    created_at: datetime
    books: list[BookSummary]

    model_config = {"from_attributes": True}


class SeriesCreateRequest(BaseModel):
    name: str
    category: Literal["demo", "private"]


class SeriesAssignRequest(BaseModel):
    series_id: str
    series_order: int


# ── Series CRUD ───────────────────────────────────────────────────────────────

def _series_out(session: Session, series: Series) -> SeriesOut:
    books = (
        session.execute(
            select(SourceDocument)
            .where(SourceDocument.series_id == series.id)
            .order_by(SourceDocument.series_order)
        )
        .scalars()
        .all()
    )
    return SeriesOut(
        id=series.id,
        name=series.name,
        category=series.category,
        created_at=series.created_at,
        books=[BookSummary(id=b.id, title=b.title, series_order=b.series_order) for b in books],
    )


@router.post("/api/series", response_model=SeriesOut, status_code=201)
def create_series_endpoint(body: SeriesCreateRequest, db: Session = Depends(get_db)):
    series = create_series(db, name=body.name, category=body.category)
    return _series_out(db, series)


@router.get("/api/series", response_model=list[SeriesOut])
def list_series_endpoint(db: Session = Depends(get_db)):
    return [_series_out(db, s) for s in list_series(db)]


@router.get("/api/series/{series_id}", response_model=SeriesOut)
def get_series_endpoint(series_id: str, db: Session = Depends(get_db)):
    series = get_series(db, series_id)
    if series is None:
        raise HTTPException(status_code=404, detail=f"Series '{series_id}' not found.")
    return _series_out(db, series)


@router.delete("/api/series/{series_id}", status_code=204)
def delete_series_endpoint(series_id: str, db: Session = Depends(get_db)):
    try:
        delete_series(db, series_id)
    except SeriesError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        raise HTTPException(status_code=422, detail=msg) from exc


# ── Document ↔ series assignment (lives here, path matches /api/documents/…) ─

@router.put("/api/documents/{document_id}/series", response_model=None, status_code=204)
def assign_document_to_series(
    document_id: str, body: SeriesAssignRequest, db: Session = Depends(get_db)
):
    try:
        _assign(db, document_id=document_id, series_id=body.series_id, series_order=body.series_order)
    except SeriesError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        raise HTTPException(status_code=422, detail=msg) from exc


@router.delete("/api/documents/{document_id}/series", status_code=204)
def remove_document_from_series(document_id: str, db: Session = Depends(get_db)):
    try:
        _remove(db, document_id=document_id)
    except SeriesError as exc:
        msg = str(exc)
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        raise HTTPException(status_code=422, detail=msg) from exc
