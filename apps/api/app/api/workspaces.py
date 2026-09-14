from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.workspace.schemas import (
    ValidateExportPathRequest,
    ValidateExportPathResponse,
    WorkspaceCreate,
    WorkspaceResponse,
)
from app.workspace.service import PrivateExportPathError, Workspace, assert_export_path, create_workspace

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])

# Temporary in-memory store — replaced by SQLite in Task 4.
_store: dict[str, Workspace] = {}


@router.post("", response_model=WorkspaceResponse, status_code=201)
def create_workspace_endpoint(body: WorkspaceCreate) -> WorkspaceResponse:
    ws = create_workspace(body.name, body.category)
    _store[ws.id] = ws
    return WorkspaceResponse(id=ws.id, name=ws.name, category=ws.category, path=str(ws.path))


@router.post("/{workspace_id}/validate-export-path", response_model=ValidateExportPathResponse)
def validate_export_path_endpoint(
    workspace_id: str, body: ValidateExportPathRequest
) -> ValidateExportPathResponse:
    ws = _store.get(workspace_id)
    if ws is None:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found.")
    try:
        assert_export_path(ws, Path(body.destination))
    except PrivateExportPathError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ValidateExportPathResponse(valid=True, destination=body.destination)
