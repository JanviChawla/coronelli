from typing import Literal

from pydantic import BaseModel


class WorkspaceCreate(BaseModel):
    name: str
    category: Literal["demo", "private"]


class WorkspaceResponse(BaseModel):
    id: str
    name: str
    category: Literal["demo", "private"]
    path: str


class ValidateExportPathRequest(BaseModel):
    destination: str


class ValidateExportPathResponse(BaseModel):
    valid: bool
    destination: str
