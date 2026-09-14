"""
Contract tests for temporal_interpretation, first_revealed_at_section_id,
relation_kind, and relation_target_id on Candidate.

Invariants:
- New fields are nullable; existing candidates default safely.
- temporal_interpretation defaults to "static" when absent.
- relation_kind and relation_target_id must be set together or not at all.
- Provider-emitted values round-trip through the service into the DB.
- Invalid temporal_interpretation is coerced to "static" by the provider layer.
- "imagined" is still rejected as a status regardless of other fields.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock
import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import SourceDocument, SourceSection
from app.extraction.models import Candidate, ExtractionRun
from app.extraction.provider import ExtractionResult, RawCandidate
from app.extraction.service import ExtractionError, run_extraction
from app.extraction.openai_provider import OpenAIExtractionProvider, PROMPT_VERSION


# ── Shared fixtures ───────────────────────────────────────────────────────────

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
def doc_and_sections(db):
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
    sec1 = SourceSection(
        id=str(uuid.uuid4()),
        document_id=doc.id,
        ordinal=0,
        title="Chapter I",
        text="The great forest lay to the north.",
    )
    sec2 = SourceSection(
        id=str(uuid.uuid4()),
        document_id=doc.id,
        ordinal=1,
        title="Chapter II",
        text="She learned that the forest had burned.",
    )
    db.add(sec1)
    db.add(sec2)
    db.commit()
    return sec1, sec2


def _make_response(candidates: list[dict]) -> MagicMock:
    msg = MagicMock()
    msg.content = json.dumps({"candidates": candidates})
    choice = MagicMock()
    choice.message = msg
    resp = MagicMock()
    resp.choices = [choice]
    return resp


# ── Default / backward-compat ─────────────────────────────────────────────────

def test_existing_candidates_default_to_static(db, doc_and_sections):
    sec1, _ = doc_and_sections

    class MinimalProvider:
        def extract(self, section, known_entities):
            return ExtractionResult(
                candidates=[
                    RawCandidate(
                        kind="entity",
                        payload={"name": "The Forest", "type": "region"},
                        status="explicit",
                        confidence=0.9,
                        excerpt="The great forest",
                        rationale="Named region.",
                    )
                ],
                raw_response={},
                provider="minimal",
                model="m1",
                prompt_version="0.1",
            )

    _, candidates, _ = run_extraction(db, sec1.id, MinimalProvider())
    c = candidates[0]
    assert c.temporal_interpretation == "static"
    assert c.first_revealed_at_section_id is None
    assert c.relation_kind is None
    assert c.relation_target_id is None


# ── temporal_interpretation ───────────────────────────────────────────────────

def test_discovery_interpretation_stored(db, doc_and_sections):
    sec1, sec2 = doc_and_sections

    class DiscoveryProvider:
        def extract(self, section, known_entities):
            return ExtractionResult(
                candidates=[
                    RawCandidate(
                        kind="entity",
                        payload={"name": "The Forest", "type": "region"},
                        status="explicit",
                        confidence=0.9,
                        excerpt="The great forest",
                        rationale="Named region.",
                        temporal_interpretation="discovery",
                        first_revealed_at_section_id=sec2.id,
                    )
                ],
                raw_response={},
                provider="fake",
                model="m1",
                prompt_version="0.2",
            )

    _, candidates, _ = run_extraction(db, sec1.id, DiscoveryProvider())
    c = candidates[0]
    assert c.temporal_interpretation == "discovery"
    assert c.first_revealed_at_section_id == sec2.id


def test_world_state_change_stored(db, doc_and_sections):
    sec1, sec2 = doc_and_sections

    class WorldChangeProvider:
        def extract(self, section, known_entities):
            return ExtractionResult(
                candidates=[
                    RawCandidate(
                        kind="claim",
                        payload={"subject": "The Forest", "predicate": "BLOCKS", "object": "North Road"},
                        status="explicit",
                        confidence=0.85,
                        excerpt="the forest had burned",
                        rationale="Route blocked by destruction.",
                        temporal_interpretation="world_state_change",
                    )
                ],
                raw_response={},
                provider="fake",
                model="m1",
                prompt_version="0.2",
            )

    _, candidates, _ = run_extraction(db, sec2.id, WorldChangeProvider())
    assert candidates[0].temporal_interpretation == "world_state_change"


def test_knowledge_revision_stored(db, doc_and_sections):
    sec1, _ = doc_and_sections

    class RevisionProvider:
        def extract(self, section, known_entities):
            return ExtractionResult(
                candidates=[
                    RawCandidate(
                        kind="claim",
                        payload={"subject": "The Forest", "predicate": "NORTH_OF", "object": "Village"},
                        status="inferred",
                        confidence=0.7,
                        excerpt="lay to the north",
                        rationale="Direction inferred.",
                        temporal_interpretation="knowledge_revision",
                    )
                ],
                raw_response={},
                provider="fake",
                model="m1",
                prompt_version="0.2",
            )

    _, candidates, _ = run_extraction(db, sec1.id, RevisionProvider())
    assert candidates[0].temporal_interpretation == "knowledge_revision"


# ── Relational fields ─────────────────────────────────────────────────────────

def test_supersedes_relation_stored(db, doc_and_sections):
    sec1, sec2 = doc_and_sections

    class FirstProvider:
        def extract(self, section, known_entities):
            return ExtractionResult(
                candidates=[
                    RawCandidate(
                        kind="claim",
                        payload={"subject": "North Road", "predicate": "ACCESSIBLE_FROM", "object": "Village"},
                        status="explicit",
                        confidence=0.9,
                        excerpt="The great forest lay to the north",
                        rationale="Route implied.",
                    )
                ],
                raw_response={},
                provider="fake",
                model="m1",
                prompt_version="0.2",
            )

    _, c1_list, _ = run_extraction(db, sec1.id, FirstProvider())
    first_id = c1_list[0].id

    class SupersedesProvider:
        def extract(self, section, known_entities):
            return ExtractionResult(
                candidates=[
                    RawCandidate(
                        kind="claim",
                        payload={"subject": "North Road", "predicate": "BLOCKS", "object": "Village"},
                        status="explicit",
                        confidence=0.95,
                        excerpt="the forest had burned",
                        rationale="Earlier route now blocked.",
                        temporal_interpretation="world_state_change",
                        relation_kind="supersedes",
                        relation_target_id=first_id,
                    )
                ],
                raw_response={},
                provider="fake",
                model="m1",
                prompt_version="0.2",
            )

    _, c2_list, _ = run_extraction(db, sec2.id, SupersedesProvider())
    c2 = c2_list[0]
    assert c2.relation_kind == "supersedes"
    assert c2.relation_target_id == first_id


def test_contradicts_relation_stored(db, doc_and_sections):
    sec1, sec2 = doc_and_sections

    class ContradictProvider:
        def extract(self, section, known_entities):
            return ExtractionResult(
                candidates=[
                    RawCandidate(
                        kind="claim",
                        payload={"subject": "The Forest", "predicate": "SOUTH_OF", "object": "Village"},
                        status="inferred",
                        confidence=0.6,
                        excerpt="forest had burned",
                        rationale="Contradicts earlier direction claim.",
                        relation_kind="contradicts",
                        relation_target_id="some-prior-id",
                    )
                ],
                raw_response={},
                provider="fake",
                model="m1",
                prompt_version="0.2",
            )

    _, candidates, _ = run_extraction(db, sec2.id, ContradictProvider())
    assert candidates[0].relation_kind == "contradicts"
    assert candidates[0].relation_target_id == "some-prior-id"


def test_relation_kind_without_target_raises(db, doc_and_sections):
    sec1, _ = doc_and_sections

    class BadRelationProvider:
        def extract(self, section, known_entities):
            return ExtractionResult(
                candidates=[
                    RawCandidate(
                        kind="claim",
                        payload={"subject": "X", "predicate": "NEAR", "object": "Y"},
                        status="explicit",
                        confidence=0.8,
                        excerpt="near Y",
                        rationale="Proximity.",
                        relation_kind="supersedes",
                        relation_target_id=None,  # missing — invalid
                    )
                ],
                raw_response={},
                provider="fake",
                model="m1",
                prompt_version="0.2",
            )

    with pytest.raises(ExtractionError, match="relation_target_id"):
        run_extraction(db, sec1.id, BadRelationProvider())


def test_relation_target_without_kind_raises(db, doc_and_sections):
    sec1, _ = doc_and_sections

    class BadRelationProvider:
        def extract(self, section, known_entities):
            return ExtractionResult(
                candidates=[
                    RawCandidate(
                        kind="claim",
                        payload={"subject": "X", "predicate": "NEAR", "object": "Y"},
                        status="explicit",
                        confidence=0.8,
                        excerpt="near Y",
                        rationale="Proximity.",
                        relation_kind=None,
                        relation_target_id="some-id",  # set without kind — invalid
                    )
                ],
                raw_response={},
                provider="fake",
                model="m1",
                prompt_version="0.2",
            )

    with pytest.raises(ExtractionError, match="relation_kind"):
        run_extraction(db, sec1.id, BadRelationProvider())


# ── OpenAI provider parsing ───────────────────────────────────────────────────

def _section():
    s = MagicMock()
    s.id = "sec-001"
    s.title = "Chapter I"
    s.text = "The great forest lay to the north."
    return s


def test_openai_provider_parses_temporal_fields():
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _make_response([{
        "kind": "entity",
        "payload": {"name": "The Forest", "type": "region"},
        "status": "explicit",
        "confidence": 0.9,
        "excerpt": "The great forest",
        "rationale": "Named region.",
        "temporal_interpretation": "discovery",
        "first_revealed_at_section_id": "sec-002",
        "relation_kind": None,
        "relation_target_id": None,
    }])

    provider = OpenAIExtractionProvider(client=mock_client, model="gpt-4o-mini")
    result = provider.extract(_section(), [])

    assert result.candidates[0].temporal_interpretation == "discovery"
    assert result.candidates[0].first_revealed_at_section_id == "sec-002"


def test_openai_provider_parses_relation_fields():
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _make_response([{
        "kind": "claim",
        "payload": {"subject": "X", "predicate": "BLOCKS", "object": "Y"},
        "status": "explicit",
        "confidence": 0.85,
        "excerpt": "blocked",
        "rationale": "Route blocked.",
        "temporal_interpretation": "world_state_change",
        "relation_kind": "supersedes",
        "relation_target_id": "cand-abc",
    }])

    provider = OpenAIExtractionProvider(client=mock_client, model="gpt-4o-mini")
    result = provider.extract(_section(), [])

    c = result.candidates[0]
    assert c.relation_kind == "supersedes"
    assert c.relation_target_id == "cand-abc"
    assert c.temporal_interpretation == "world_state_change"


def test_openai_provider_invalid_temporal_coerced_to_static():
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _make_response([{
        "kind": "entity",
        "payload": {"name": "The Forest", "type": "region"},
        "status": "explicit",
        "confidence": 0.9,
        "excerpt": "The great forest",
        "rationale": "Named region.",
        "temporal_interpretation": "made_up_value",
    }])

    provider = OpenAIExtractionProvider(client=mock_client, model="gpt-4o-mini")
    result = provider.extract(_section(), [])

    assert result.candidates[0].temporal_interpretation == "static"


def test_openai_provider_missing_temporal_defaults_to_static():
    mock_client = MagicMock()
    mock_client.chat.completions.create.return_value = _make_response([{
        "kind": "entity",
        "payload": {"name": "The Forest", "type": "region"},
        "status": "explicit",
        "confidence": 0.9,
        "excerpt": "The great forest",
        "rationale": "Named region.",
        # temporal_interpretation absent
    }])

    provider = OpenAIExtractionProvider(client=mock_client, model="gpt-4o-mini")
    result = provider.extract(_section(), [])

    assert result.candidates[0].temporal_interpretation == "static"


def test_prompt_version_bumped_to_0_2():
    assert PROMPT_VERSION == "0.2"
