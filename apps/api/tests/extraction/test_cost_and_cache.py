"""
Tests for per-run cost recording, idempotency/caching, and preflight.

Invariants:
- Token counts from the provider are stored on ExtractionRun.
- estimated_cost_usd is computed for known models; None for unknown ones.
- section_content_hash is stored on every completed run.
- A second identical call returns the cached run without calling the provider.
- Changing section text invalidates the cache.
- force=True bypasses the cache and always calls the provider.
- Failed runs are never returned as cache hits.
- The preflight endpoint returns sections_to_send, estimated tokens/cost, and
  whether a valid cached run already exists.
"""
import hashlib
import json
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, call, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import SourceDocument, SourceSection
from app.extraction.models import Candidate, ExtractionRun
from app.extraction.provider import ExtractionResult, RawCandidate
from app.extraction.prompts import PROMPT_VERSION
from app.extraction.service import ExtractionError, run_extraction


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


def _provider_with_tokens(input_tokens: int = 80, output_tokens: int = 30):
    """Fake provider that reports token counts and uses the current prompt version."""
    class _Provider:
        def __init__(self):
            self.calls = 0

        def extract(self, section, known_entities):
            self.calls += 1
            return ExtractionResult(
                candidates=[
                    RawCandidate(
                        kind="entity",
                        payload={"name": "Casterbridge", "type": "settlement"},
                        status="explicit",
                        confidence=0.9,
                        excerpt="Casterbridge",
                        rationale="Named settlement.",
                    )
                ],
                raw_response={"model": "gpt-4o-mini"},
                provider="openai",
                model="gpt-4o-mini",
                prompt_version=PROMPT_VERSION,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )

    return _Provider()


# ── Token / cost recording ────────────────────────────────────────────────────

def test_token_counts_stored_on_run(db, section):
    provider = _provider_with_tokens(input_tokens=120, output_tokens=45)
    run, _, _ = run_extraction(db, section.id, provider)
    assert run.input_tokens == 120
    assert run.output_tokens == 45


def test_cost_estimated_for_gpt4o_mini(db, section):
    provider = _provider_with_tokens(input_tokens=1_000_000, output_tokens=1_000_000)
    run, _, _ = run_extraction(db, section.id, provider)
    # $0.15/M input + $0.60/M output = $0.75 for 1M each
    assert run.estimated_cost_usd == pytest.approx(0.75, rel=1e-3)


def test_cost_none_for_unknown_model(db, section):
    class UnknownModelProvider:
        def extract(self, section, known_entities):
            return ExtractionResult(
                candidates=[],
                raw_response={},
                provider="other",
                model="unknown-model-xyz",
                prompt_version=PROMPT_VERSION,
                input_tokens=100,
                output_tokens=50,
            )

    run, _, _ = run_extraction(db, section.id, UnknownModelProvider())
    assert run.estimated_cost_usd is None


def test_cost_none_when_tokens_absent(db, section):
    class NoTokenProvider:
        def extract(self, section, known_entities):
            return ExtractionResult(
                candidates=[],
                raw_response={},
                provider="openai",
                model="gpt-4o-mini",
                prompt_version=PROMPT_VERSION,
                # input_tokens and output_tokens default to None
            )

    run, _, _ = run_extraction(db, section.id, NoTokenProvider())
    assert run.estimated_cost_usd is None


def test_section_content_hash_stored_on_run(db, section):
    provider = _provider_with_tokens()
    run, _, _ = run_extraction(db, section.id, provider)
    expected = hashlib.sha256(section.text.encode()).hexdigest()
    assert run.section_content_hash == expected


# ── Idempotency / caching ─────────────────────────────────────────────────────

def test_cache_hit_returns_same_run(db, section):
    provider = _provider_with_tokens()

    run1, cands1, from_cache1 = run_extraction(db, section.id, provider)
    run2, cands2, from_cache2 = run_extraction(db, section.id, provider)

    assert from_cache1 is False
    assert from_cache2 is True
    assert run1.id == run2.id
    assert [c.id for c in cands1] == [c.id for c in cands2]
    assert provider.calls == 1          # provider called exactly once
    assert db.query(ExtractionRun).count() == 1


def test_cache_miss_on_content_change(db, section):
    provider = _provider_with_tokens()

    run1, _, _ = run_extraction(db, section.id, provider)

    section.text = "She learned that the forest had burned."
    db.commit()

    run2, _, from_cache2 = run_extraction(db, section.id, provider)

    assert from_cache2 is False
    assert run1.id != run2.id
    assert provider.calls == 2


def test_force_bypasses_cache(db, section):
    provider = _provider_with_tokens()

    run1, _, _ = run_extraction(db, section.id, provider)
    run2, _, from_cache2 = run_extraction(db, section.id, provider, force=True)

    assert from_cache2 is False
    assert run1.id != run2.id
    assert provider.calls == 2
    assert db.query(ExtractionRun).count() == 2


def test_failed_run_not_returned_as_cache_hit(db, section):
    class FailingProvider:
        def extract(self, section, known_entities):
            raise RuntimeError("Provider unavailable.")

    with pytest.raises(ExtractionError):
        run_extraction(db, section.id, FailingProvider())

    # After a failed run, the next call should still attempt a fresh extraction.
    provider = _provider_with_tokens()
    run, _, from_cache = run_extraction(db, section.id, provider)
    assert from_cache is False
    assert run.status == "completed"


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
    assert body["sections_to_send"] == 1
    assert body["prompt_version"] == PROMPT_VERSION
    assert isinstance(body["estimated_input_tokens"], int)
    assert body["estimated_input_tokens"] > 0
    assert body["cache_valid"] is False
    assert body["cached_run_id"] is None


def test_preflight_shows_cache_valid_when_run_exists(api_client, db, section):
    provider = _provider_with_tokens()
    run, _, _ = run_extraction(db, section.id, provider)

    resp = api_client.get(f"/api/sections/{section.id}/extract/preflight")
    body = resp.json()
    assert body["cache_valid"] is True
    assert body["cached_run_id"] == run.id


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
    msg.content = json.dumps({"candidates": [{
        "kind": "entity",
        "payload": {"name": "Casterbridge", "type": "settlement"},
        "status": "explicit",
        "confidence": 0.9,
        "excerpt": "Casterbridge",
        "rationale": "Named.",
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
        resp = api_client.post(f"/api/sections/{section.id}/extract")

    assert resp.status_code == 201
    body = resp.json()
    assert body["from_cache"] is False
    assert body["run"]["input_tokens"] == 80
    assert body["run"]["output_tokens"] == 20
    assert body["run"]["estimated_cost_usd"] == pytest.approx(
        80 * 0.150 / 1_000_000 + 20 * 0.600 / 1_000_000, rel=1e-3
    )
