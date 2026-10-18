"""Tests for atlas_hierarchy: _llm_infer_containment resolution logic and assign_containment endpoint."""
import json
import os
import uuid
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.engine import get_db
from app.domain.sources import ProposedSection, create_document, replace_sections
from app.domain.world import MapClaim, MapEntity
from app.main import app
from app.api.atlas_hierarchy import _llm_infer_containment


# ── Shared fixtures ────────────────────────────────────────────────────────────

@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield engine, session
    Base.metadata.drop_all(engine)


@pytest.fixture
def client():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)

    def override_get_db():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c, engine
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)


def _make_entity(session: Session, doc_id: str, name: str, place_kind: str = "building", aliases=None) -> MapEntity:
    e = MapEntity(
        id=str(uuid.uuid4()),
        name=name,
        entity_kind="place",
        place_kind=place_kind,
        state="active",
        provenance_document_id=doc_id,
        aliases=aliases or [],
        payload={},
    )
    session.add(e)
    session.flush()
    return e


def _fake_openai_response(pairs: list[dict]) -> MagicMock:
    """Return a mock openai response with the given pairs JSON."""
    msg = MagicMock()
    msg.content = json.dumps({"pairs": pairs})
    choice = MagicMock()
    choice.message = msg
    resp = MagicMock()
    resp.choices = [choice]
    return resp


# ── Unit tests: _llm_infer_containment ────────────────────────────────────────

class TestLlmInferContainment:
    """Test _resolve() matching and pair creation via _llm_infer_containment."""

    def _call(self, session, doc_id, entities, pairs):
        """Helper: call _llm_infer_containment with a mocked OpenAI returning `pairs`."""
        name_to_id = {}
        for e in entities:
            name_to_id[e.name.lower()] = e.id
            for alias in (e.aliases or []):
                if alias.lower() not in name_to_id:
                    name_to_id[alias.lower()] = e.id

        existing: set[tuple[str, str]] = set()
        mock_resp = _fake_openai_response(pairs)

        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}):
            with patch("openai.OpenAI") as mock_cls:
                mock_cls.return_value.chat.completions.create.return_value = mock_resp
                return _llm_infer_containment(session, doc_id, entities, name_to_id, existing)

    def test_exact_name_match_creates_claim(self, engine_and_session):
        _, session = engine_and_session
        doc_id = str(uuid.uuid4())
        hogwarts = _make_entity(session, doc_id, "Hogwarts", "building")
        great_hall = _make_entity(session, doc_id, "Great Hall", "room")

        created = self._call(session, doc_id, [hogwarts, great_hall], [
            {"container": "Hogwarts", "contained": "Great Hall"},
        ])

        assert created == 1
        claim = session.query(MapClaim).filter_by(predicate="CONTAINS").first()
        assert claim is not None
        assert claim.subject_ref == hogwarts.id
        assert claim.object_refs == [great_hall.id]

    def test_the_prefix_strip_matches(self, engine_and_session):
        _, session = engine_and_session
        doc_id = str(uuid.uuid4())
        hogwarts = _make_entity(session, doc_id, "Hogwarts", "building")
        great_hall = _make_entity(session, doc_id, "Great Hall", "room")

        # LLM returns "the Great Hall" but entity is "Great Hall"
        created = self._call(session, doc_id, [hogwarts, great_hall], [
            {"container": "Hogwarts", "contained": "the Great Hall"},
        ])

        assert created == 1
        claim = session.query(MapClaim).filter_by(predicate="CONTAINS").first()
        assert claim.object_refs == [great_hall.id]

    def test_substring_match_on_canonical_name(self, engine_and_session):
        _, session = engine_and_session
        doc_id = str(uuid.uuid4())
        # LLM returns "Hogwarts", entity has full name
        hogwarts = _make_entity(session, doc_id, "Hogwarts School of Witchcraft and Wizardry", "building")
        great_hall = _make_entity(session, doc_id, "Great Hall", "room")

        created = self._call(session, doc_id, [hogwarts, great_hall], [
            {"container": "Hogwarts", "contained": "Great Hall"},
        ])

        assert created == 1
        claim = session.query(MapClaim).filter_by(predicate="CONTAINS").first()
        assert claim.subject_ref == hogwarts.id

    def test_unrecognised_name_skipped(self, engine_and_session):
        _, session = engine_and_session
        doc_id = str(uuid.uuid4())
        hogwarts = _make_entity(session, doc_id, "Hogwarts", "building")
        great_hall = _make_entity(session, doc_id, "Great Hall", "room")

        # LLM returns a name that doesn't exist in the entity list
        created = self._call(session, doc_id, [hogwarts, great_hall], [
            {"container": "Hogwarts", "contained": "Room of Requirement"},
        ])

        assert created == 0
        assert session.query(MapClaim).count() == 0

    def test_duplicate_pair_skipped(self, engine_and_session):
        _, session = engine_and_session
        doc_id = str(uuid.uuid4())
        hogwarts = _make_entity(session, doc_id, "Hogwarts", "building")
        great_hall = _make_entity(session, doc_id, "Great Hall", "room")

        name_to_id = {
            "hogwarts": hogwarts.id,
            "great hall": great_hall.id,
        }
        # Pre-populate existing with the pair
        existing: set[tuple[str, str]] = {(hogwarts.id, great_hall.id)}
        mock_resp = _fake_openai_response([{"container": "Hogwarts", "contained": "Great Hall"}])

        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}):
            with patch("openai.OpenAI") as mock_cls:
                mock_cls.return_value.chat.completions.create.return_value = mock_resp
                created = _llm_infer_containment(
                    session, doc_id, [hogwarts, great_hall], name_to_id, existing
                )

        assert created == 0
        assert session.query(MapClaim).count() == 0

    def test_self_containment_skipped(self, engine_and_session):
        _, session = engine_and_session
        doc_id = str(uuid.uuid4())
        hogwarts = _make_entity(session, doc_id, "Hogwarts", "building")

        created = self._call(session, doc_id, [hogwarts], [
            {"container": "Hogwarts", "contained": "Hogwarts"},
        ])

        assert created == 0

    def test_no_api_key_returns_zero(self, engine_and_session):
        _, session = engine_and_session
        doc_id = str(uuid.uuid4())
        hogwarts = _make_entity(session, doc_id, "Hogwarts", "building")

        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("OPENAI_API_KEY", None)
            created = _llm_infer_containment(
                session, doc_id, [hogwarts], {"hogwarts": hogwarts.id}, set()
            )

        assert created == 0


# ── Integration tests: assign_containment endpoint ───────────────────────────

class TestAssignContainmentEndpoint:

    def _setup_doc(self, engine):
        with Session(engine) as session:
            doc = create_document(
                session,
                title="Harry Potter",
                original_filename="hp.txt",
                mime_type="text/plain",
                content_hash="hp123",
                parser_version="1.0",
                category="demo",
            )
            replace_sections(session, doc.id, [
                ProposedSection(ordinal=0, title="Chapter 1", text="Text here.")
            ])
            return doc.id

    def test_no_sections_returns_no_sections(self, client):
        c, engine = client
        doc_id = str(uuid.uuid4())  # non-existent document
        resp = c.post(f"/api/documents/{doc_id}/assign-containment")
        assert resp.status_code == 200
        data = resp.json()
        assert data["claims_created"] == 0

    def test_creates_contains_claim_from_llm(self, client):
        c, engine = client
        doc_id = self._setup_doc(engine)

        with Session(engine) as session:
            hogwarts = _make_entity(session, doc_id, "Hogwarts", "building")
            great_hall = _make_entity(session, doc_id, "Great Hall", "room")
            session.commit()
            hogwarts_id = hogwarts.id
            great_hall_id = great_hall.id

        mock_resp = _fake_openai_response([
            {"container": "Hogwarts", "contained": "Great Hall"},
        ])

        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}):
            with patch("openai.OpenAI") as mock_cls:
                mock_cls.return_value.chat.completions.create.return_value = mock_resp
                resp = c.post(f"/api/documents/{doc_id}/assign-containment")

        assert resp.status_code == 200
        assert resp.json()["claims_created"] == 1

        with Session(engine) as session:
            claim = session.query(MapClaim).filter_by(predicate="CONTAINS", state="active").first()
            assert claim is not None
            assert claim.subject_ref == hogwarts_id
            assert claim.object_refs == [great_hall_id]

    def test_does_not_duplicate_existing_claim(self, client):
        c, engine = client
        doc_id = self._setup_doc(engine)

        with Session(engine) as session:
            hogwarts = _make_entity(session, doc_id, "Hogwarts", "building")
            great_hall = _make_entity(session, doc_id, "Great Hall", "room")
            # Pre-create the claim
            session.add(MapClaim(
                id=str(uuid.uuid4()),
                claim_type="spatial",
                predicate="CONTAINS",
                subject_ref=hogwarts.id,
                object_refs=[great_hall.id],
                provenance_document_id=doc_id,
                state="active",
                status="explicit",
                payload={},
            ))
            session.commit()

        mock_resp = _fake_openai_response([
            {"container": "Hogwarts", "contained": "Great Hall"},
        ])

        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}):
            with patch("openai.OpenAI") as mock_cls:
                mock_cls.return_value.chat.completions.create.return_value = mock_resp
                resp = c.post(f"/api/documents/{doc_id}/assign-containment")

        assert resp.status_code == 200
        assert resp.json()["claims_created"] == 0

        with Session(engine) as session:
            assert session.query(MapClaim).filter_by(predicate="CONTAINS").count() == 1
