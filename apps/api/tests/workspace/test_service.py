import pytest

from app.workspace.service import (
    DEMOS_ROOT,
    EXPORTS_PRIVATE_ROOT,
    PRIVATE_ROOT,
    REPO_ROOT,
    PrivateExportPathError,
    assert_export_path,
    create_workspace,
)


def test_demo_workspace_resolves_under_demos():
    ws = create_workspace("my-world", "demo")
    assert ws.path.is_relative_to(DEMOS_ROOT.resolve())


def test_private_workspace_resolves_under_private():
    ws = create_workspace("my-secret", "private")
    assert ws.path.is_relative_to(PRIVATE_ROOT.resolve())


def test_demo_workspace_category():
    ws = create_workspace("test", "demo")
    assert ws.category == "demo"


def test_private_workspace_category():
    ws = create_workspace("test", "private")
    assert ws.category == "private"


def test_workspaces_have_unique_ids():
    ws1 = create_workspace("test", "demo")
    ws2 = create_workspace("test", "demo")
    assert ws1.id != ws2.id


def test_traversal_in_name_cannot_escape_base():
    ws = create_workspace("../../../etc/passwd", "demo")
    assert ws.path.is_relative_to(DEMOS_ROOT.resolve())


def test_private_export_to_tracked_repo_path_raises():
    ws = create_workspace("my-secret", "private")
    bad_dest = REPO_ROOT / "exports" / "my-world.atlas"
    with pytest.raises(PrivateExportPathError):
        assert_export_path(ws, bad_dest)


def test_private_export_to_exports_private_succeeds():
    ws = create_workspace("my-secret", "private")
    ok_dest = EXPORTS_PRIVATE_ROOT / "my-world.atlas"
    assert_export_path(ws, ok_dest)


def test_private_export_to_data_private_succeeds():
    ws = create_workspace("my-secret", "private")
    ok_dest = PRIVATE_ROOT / "my-world.atlas"
    assert_export_path(ws, ok_dest)


def test_demo_export_anywhere_in_repo_succeeds():
    ws = create_workspace("my-demo", "demo")
    dest = REPO_ROOT / "exports" / "my-world.atlas"
    assert_export_path(ws, dest)
