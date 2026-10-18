"""
Tests for preflight endpoint.
"""
import json
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import SourceDocument, SourceSection
from app.extraction.models import ExtractionRun
from app.extraction.provider import ExtractionResult, RawCandidate
from app.extraction.prompts import PROMPT_VERSION


# ── Fixtures ──────────────────────────────────────────────────────────────────

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
        title="Test Book",
        original_filename="test.txt",
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
        title="Chapter I",
        text="The village of Casterbridge lay amid the cornfields.",
    )
    db.add(sec)
    db.commit()
    return sec


# ── Preflight endpoint ────────────────────────────────────────────────────────

@pytest.fixture
def api_client(db):
    from app.db.engine import get_db
    from app.main import app
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def test_preflight_returns_expected_shape(api_client, section):
    resp = api_client.get(f"/api/sections/{section.id}/extract/preflight")
    assert resp.status_code == 200
    body = resp.json()
    assert body["section_id"] == section.id
    assert body["sections_to_send"] == 2
    assert body["prompt_version"] == PROMPT_VERSION
    assert isinstance(body["estimated_input_tokens"], int)
    assert body["estimated_input_tokens"] > 0
    assert body["cache_valid"] is False
    assert body["cached_run_id"] is None


def test_preflight_404_on_missing_section(api_client):
    resp = api_client.get("/api/sections/no-such-id/extract/preflight")
    assert resp.status_code == 404


def test_preflight_includes_estimated_cost_when_model_known(api_client, section):
    import os
    with patch.dict(os.environ, {"OPENAI_EXTRACTION_MODEL": "gpt-4o-mini"}):
        resp = api_client.get(f"/api/sections/{section.id}/extract/preflight")
    body = resp.json()
    assert body["estimated_cost_usd"] is not None
    assert body["estimated_cost_usd"] > 0


def test_extract_endpoint_returns_from_cache_false_on_first_call(api_client, section):
    from unittest.mock import patch
    from app.extraction.openai_provider import OpenAIExtractionProvider

    mock_client = MagicMock()
    msg = MagicMock()
    msg.content = json.dumps({"places": [{
        "name": "Casterbridge",
        "type": "settlement",
        "is_new": True,
        "confidence": 0.9,
        "excerpt": "Casterbridge",
    }]})
    choice = MagicMock()
    choice.message = msg
    resp_mock = MagicMock()
    resp_mock.choices = [choice]
    resp_mock.usage.prompt_tokens = 80
    resp_mock.usage.completion_tokens = 20
    mock_client.chat.completions.create.return_value = resp_mock

    with patch("app.api.extraction.get_provider") as mock_gp:
        mock_gp.return_value = OpenAIExtractionProvider(client=mock_client, model="gpt-4o-mini")
        resp = api_client.post(f"/api/sections/{section.id}/extract/catalog")

    assert resp.status_code == 201
    body = resp.json()
    assert body["from_cache"] is False
    assert body["run"]["input_tokens"] == 80
    assert body["run"]["output_tokens"] == 20
    assert body["run"]["estimated_cost_usd"] == pytest.approx(
        80 * 0.150 / 1_000_000 + 20 * 0.600 / 1_000_000, rel=1e-3
    )
