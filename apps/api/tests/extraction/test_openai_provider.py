"""
Task 8: OpenAI provider tests — all use a mocked client, never a live key.
"""
import json
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import SourceDocument, SourceSection
from app.extraction.models import Candidate, ExtractionRun
from app.extraction.openai_provider import PROMPT_VERSION, OpenAIExtractionProvider
from app.extraction.service import ExtractionError, run_extraction


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_openai_response(candidates: list[dict]) -> MagicMock:
    """Build a mock that looks like an openai ChatCompletion response."""
    content = json.dumps({"candidates": candidates})
    msg = MagicMock()
    msg.content = content
    choice = MagicMock()
    choice.message = msg
    response = MagicMock()
    response.choices = [choice]
    response.model = "gpt-4o-mini"
    response.usage.prompt_tokens = 80
    response.usage.completion_tokens = 20
    response.usage.total_tokens = 100
    return response


VALID_ENTITY = {
    "kind": "entity",
    "payload": {"name": "Neverland", "type": "island"},
    "status": "explicit",
    "confidence": 0.9,
    "excerpt": "the island called Neverland",
    "rationale": "Named location mentioned directly.",
}

VALID_CLAIM = {
    "kind": "claim",
    "payload": {"subject": "Neverland", "predicate": "surrounded_by", "object": "sea"},
    "status": "inferred",
    "confidence": 0.75,
    "excerpt": "surrounded by the sea",
    "rationale": "Spatial relationship inferred.",
}


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    Base.metadata.drop_all(engine)


@pytest.fixture
def section(db):
    doc = SourceDocument(
        id=str(uuid.uuid4()),
        title="Peter Pan",
        original_filename="peter-pan.txt",
        mime_type="text/plain",
        content_hash="abc123",
        imported_at=datetime.now(timezone.utc),
        parser_version="1.0",
        category="demo",
    )
    db.add(doc)
    sec = SourceSection(
        id=str(uuid.uuid4()),
        document_id=doc.id,
        ordinal=0,
        title="Chapter I. PETER BREAKS THROUGH",
        text="All children, except one, grow up.",
    )
    db.add(sec)
    db.commit()
    return sec


# ── Provider unit tests ───────────────────────────────────────────────────────

def test_provider_sends_section_text_in_request(section):
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _make_openai_response([VALID_ENTITY])

    provider = OpenAIExtractionProvider(client=mock_client, model="gpt-4o-mini")
    provider.extract(section, known_entities=[])

    call_args = mock_client.chat.completions.create.call_args
    messages = call_args.kwargs["messages"]
    user_content = next(m["content"] for m in messages if m["role"] == "user")
    assert section.text in user_content
    assert section.title in user_content


def test_provider_sends_known_entity_ids(section):
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _make_openai_response([VALID_ENTITY])

    provider = OpenAIExtractionProvider(client=mock_client, model="gpt-4o-mini")
    known = [{"id": "ent-001", "name": "Wendy", "type": "person"}]
    provider.extract(section, known_entities=known)

    call_args = mock_client.chat.completions.create.call_args
    messages = call_args.kwargs["messages"]
    full_content = " ".join(m["content"] for m in messages)
    assert "ent-001" in full_content or "Wendy" in full_content


def test_provider_returns_parsed_candidates(section):
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _make_openai_response(
        [VALID_ENTITY, VALID_CLAIM]
    )

    provider = OpenAIExtractionProvider(client=mock_client, model="gpt-4o-mini")
    result = provider.extract(section, known_entities=[])

    assert len(result.candidates) == 2
    assert result.candidates[0].kind == "entity"
    assert result.candidates[0].status == "explicit"
    assert result.candidates[1].kind == "claim"
    assert result.provider == "openai"
    assert result.model == "gpt-4o-mini"
    assert result.prompt_version == PROMPT_VERSION


def test_provider_result_includes_raw_response(section):
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _make_openai_response([VALID_ENTITY])

    provider = OpenAIExtractionProvider(client=mock_client, model="gpt-4o-mini")
    result = provider.extract(section, known_entities=[])

    assert "candidates" in result.raw_response


def test_malformed_json_response_raises(section):
    bad_msg = MagicMock()
    bad_msg.content = "not valid json {"
    bad_choice = MagicMock()
    bad_choice.message = bad_msg
    bad_response = MagicMock()
    bad_response.choices = [bad_choice]

    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = bad_response

    provider = OpenAIExtractionProvider(client=mock_client, model="gpt-4o-mini")
    with pytest.raises(ValueError, match="parse"):
        provider.extract(section, known_entities=[])


def test_missing_candidates_key_raises(section):
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _make_openai_response.__wrapped__(
        [VALID_ENTITY]
    ) if hasattr(_make_openai_response, "__wrapped__") else None

    # Build response with wrong schema — no "candidates" key
    msg = MagicMock()
    msg.content = json.dumps({"results": []})
    choice = MagicMock()
    choice.message = msg
    bad_response = MagicMock()
    bad_response.choices = [choice]

    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = bad_response

    provider = OpenAIExtractionProvider(client=mock_client, model="gpt-4o-mini")
    with pytest.raises(ValueError, match="parse"):
        provider.extract(section, known_entities=[])


def test_imagined_status_stripped_from_output(section):
    """Provider must never emit 'imagined' status — strip or raise."""
    imagined_candidate = {**VALID_ENTITY, "status": "imagined"}
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _make_openai_response([imagined_candidate])

    provider = OpenAIExtractionProvider(client=mock_client, model="gpt-4o-mini")
    result = provider.extract(section, known_entities=[])
    assert all(c.status != "imagined" for c in result.candidates)


# ── Service integration via mocked provider ───────────────────────────────────

def test_service_stores_openai_run(db, section):
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _make_openai_response([VALID_ENTITY])

    provider = OpenAIExtractionProvider(client=mock_client, model="gpt-4o-mini")
    run, candidates, _ = run_extraction(db, section.id, provider)

    assert run.provider == "openai"
    assert run.model == "gpt-4o-mini"
    assert run.status == "completed"
    assert len(candidates) == 1


def test_service_stores_failed_run_on_bad_json(db, section):
    msg = MagicMock()
    msg.content = "garbage"
    choice = MagicMock()
    choice.message = msg
    bad_resp = MagicMock()
    bad_resp.choices = [choice]

    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = bad_resp

    provider = OpenAIExtractionProvider(client=mock_client, model="gpt-4o-mini")
    with pytest.raises(ExtractionError):
        run_extraction(db, section.id, provider)

    run = db.query(ExtractionRun).first()  # noqa: PIE796
    assert run.status == "failed"
    assert db.query(Candidate).count() == 0


# ── API endpoint tests ─────────────────────────────────────────────────────────

def test_extract_endpoint_returns_run_and_candidates(db, section):
    from fastapi.testclient import TestClient
    from sqlalchemy.pool import StaticPool
    from app.db.engine import get_db
    from app.main import app

    app.dependency_overrides[get_db] = lambda: db

    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _make_openai_response(
        [VALID_ENTITY, VALID_CLAIM]
    )

    with patch("app.api.extraction.get_provider") as mock_get_provider:
        mock_get_provider.return_value = OpenAIExtractionProvider(
            client=mock_client, model="gpt-4o-mini"
        )
        with TestClient(app) as client:
            resp = client.post(f"/api/sections/{section.id}/extract")

    app.dependency_overrides.clear()

    assert resp.status_code == 201
    body = resp.json()
    assert body["run"]["status"] == "completed"
    assert len(body["candidates"]) == 2


def test_extract_endpoint_404_on_missing_section(db):
    from fastapi.testclient import TestClient
    from app.db.engine import get_db
    from app.main import app

    app.dependency_overrides[get_db] = lambda: db

    with patch("app.api.extraction.get_provider") as mock_get_provider:
        mock_get_provider.return_value = MagicMock()
        with TestClient(app) as client:
            resp = client.post("/api/sections/no-such-id/extract")

    app.dependency_overrides.clear()
    assert resp.status_code == 404


def test_extract_endpoint_503_when_not_configured(db, section):
    from fastapi.testclient import TestClient
    from app.db.engine import get_db
    from app.extraction.openai_provider import ExtractionNotConfiguredError
    from app.main import app

    app.dependency_overrides[get_db] = lambda: db

    with patch("app.api.extraction.get_provider") as mock_get_provider:
        mock_get_provider.side_effect = ExtractionNotConfiguredError("no key")
        with TestClient(app) as client:
            resp = client.post(f"/api/sections/{section.id}/extract")

    app.dependency_overrides.clear()
    assert resp.status_code == 503


def test_get_run_endpoint(db, section):
    from fastapi.testclient import TestClient
    from app.db.engine import get_db
    from app.main import app

    app.dependency_overrides[get_db] = lambda: db

    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _make_openai_response([VALID_ENTITY])

    with patch("app.api.extraction.get_provider") as mock_get_provider:
        mock_get_provider.return_value = OpenAIExtractionProvider(
            client=mock_client, model="gpt-4o-mini"
        )
        with TestClient(app) as client:
            post_resp = client.post(f"/api/sections/{section.id}/extract")
            run_id = post_resp.json()["run"]["id"]
            get_resp = client.get(f"/api/extraction-runs/{run_id}")

    app.dependency_overrides.clear()

    assert get_resp.status_code == 200
    assert get_resp.json()["id"] == run_id
    assert get_resp.json()["status"] == "completed"
