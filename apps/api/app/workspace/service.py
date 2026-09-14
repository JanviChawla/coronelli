import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent
DEMOS_ROOT = REPO_ROOT / "data" / "demos"
PRIVATE_ROOT = REPO_ROOT / "data" / "private"
EXPORTS_PRIVATE_ROOT = REPO_ROOT / "exports" / "private"

_IGNORED_PRIVATE_DIRS = (EXPORTS_PRIVATE_ROOT, PRIVATE_ROOT)


class PrivateExportPathError(ValueError):
    pass


@dataclass(frozen=True)
class Workspace:
    id: str
    name: str
    category: Literal["demo", "private"]
    path: Path


def _is_descendant(path: Path, ancestor: Path) -> bool:
    """Return True if path is strictly inside ancestor after symlink resolution."""
    try:
        path.resolve().relative_to(ancestor.resolve())
        return True
    except ValueError:
        return False


def _sanitize_name(name: str) -> str:
    """Strip path-traversal characters; keep lowercase alphanumeric and hyphens."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "workspace"


def create_workspace(name: str, category: Literal["demo", "private"]) -> Workspace:
    base = DEMOS_ROOT if category == "demo" else PRIVATE_ROOT
    slug = _sanitize_name(name)
    workspace_id = str(uuid.uuid4())
    # Construct path, then resolve to follow any symlinks before checking containment.
    candidate = (base / f"{slug}-{workspace_id[:8]}").resolve()

    if not _is_descendant(candidate, base):
        raise ValueError(f"Workspace path '{candidate}' escapes base '{base}'.")

    return Workspace(id=workspace_id, name=name, category=category, path=candidate)


def assert_export_path(workspace: Workspace, destination: Path) -> None:
    """Raise PrivateExportPathError if a private workspace targets a tracked repo path."""
    if workspace.category != "private":
        return

    resolved = destination.resolve()

    if not _is_descendant(resolved, REPO_ROOT):
        return  # Outside the repo entirely — always allowed.

    if any(_is_descendant(resolved, ignored) for ignored in _IGNORED_PRIVATE_DIRS):
        return  # Inside a gitignored private directory — allowed.

    raise PrivateExportPathError(
        f"Private workspace '{workspace.id}' cannot export to tracked path '{destination}'. "
        f"Use exports/private/ or a path outside the repository."
    )
