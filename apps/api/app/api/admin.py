from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.db.models import SourceDocument
from app.domain.world import EntityMention, MapClaim, MapEntity, MapTravelRule

router = APIRouter(tags=["admin"])


@router.delete("/api/admin/reset", status_code=200)
def reset_library(db: Session = Depends(get_db)) -> dict:
    """Delete everything: all documents and all derived map data."""
    db.query(MapClaim).delete(synchronize_session=False)
    db.query(MapTravelRule).delete(synchronize_session=False)
    db.query(EntityMention).delete(synchronize_session=False)
    db.query(MapEntity).delete(synchronize_session=False)
    db.query(SourceDocument).delete(synchronize_session=False)
    db.commit()
    return {"reset": True}
