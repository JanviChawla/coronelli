import os
import sys
from pathlib import Path


def data_dir() -> Path:
    """Platform-appropriate directory for Coronelli's persistent data."""
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    p = base / "Coronelli"
    p.mkdir(parents=True, exist_ok=True)
    return p


def default_db_url() -> str:
    return f"sqlite:///{data_dir() / 'coronelli.db'}"
