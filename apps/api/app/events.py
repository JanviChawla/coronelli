"""Thread-safe SSE event bus — per-document streams."""
import json
import queue
import threading
from collections import defaultdict

_lock = threading.Lock()
_queues: dict[str, list["queue.Queue[str | None]"]] = defaultdict(list)


def subscribe(doc_id: str) -> "queue.Queue[str | None]":
    q: "queue.Queue[str | None]" = queue.Queue(maxsize=50)
    with _lock:
        _queues[doc_id].append(q)
    return q


def unsubscribe(doc_id: str, q: "queue.Queue[str | None]") -> None:
    with _lock:
        qs = _queues.get(doc_id, [])
        if q in qs:
            qs.remove(q)


def emit(doc_id: str, event_type: str, **data) -> None:
    if not doc_id:
        return
    payload = "data: " + json.dumps({"type": event_type, **data}) + "\n\n"
    with _lock:
        qs = list(_queues.get(doc_id, []))
    for q in qs:
        try:
            q.put_nowait(payload)
        except queue.Full:
            pass
