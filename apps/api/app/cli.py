import os
import threading
import webbrowser

import uvicorn

from app.config import data_dir

PORT = int(os.getenv("CORONELLI_PORT", "8000"))


def _open_browser() -> None:
    import time
    time.sleep(1.5)
    webbrowser.open(f"http://localhost:{PORT}")


def main() -> None:
    # Load .env from the data dir if present
    env_file = data_dir() / ".env"
    if env_file.exists():
        from dotenv import load_dotenv
        load_dotenv(env_file, override=False)

    if not os.getenv("OPENAI_API_KEY"):
        print("Warning: OPENAI_API_KEY is not set — extraction will not work.")
        print(f"  Add it to your environment or to {env_file}")
        print()

    print(f"Coronelli  →  http://localhost:{PORT}")
    threading.Thread(target=_open_browser, daemon=True).start()
    uvicorn.run("app.main:app", host="127.0.0.1", port=PORT, log_level="warning")
