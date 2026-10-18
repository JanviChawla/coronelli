from fastapi import APIRouter

from app.api.atlas_edit import router as edit_router
from app.api.atlas_export import router as export_router
from app.api.atlas_hierarchy import router as hierarchy_router
from app.api.atlas_read import router as read_router
from app.api.atlas_suggestions import router as suggestions_router

router = APIRouter(tags=["atlas"])

router.include_router(read_router)
router.include_router(export_router)
router.include_router(edit_router)
router.include_router(hierarchy_router)
router.include_router(suggestions_router)
