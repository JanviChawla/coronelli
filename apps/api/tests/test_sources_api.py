import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.engine import get_db
from app.domain.sources import ProposedSection, create_document, replace_sections
from app.main import app


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


def _doc(engine, *, title="Test Book"):
    with Session(engine) as session:
        return create_document(
            session,
            title=title,
            original_filename="test.txt",
            mime_type="text/plain",
            content_hash="abc123",
            parser_version="1.0",
            category="demo",
        )


def test_delete_document_returns_204(client):
    c, engine = client
    doc = _doc(engine)
    response = c.delete(f"/api/documents/{doc.id}")
    assert response.status_code == 204


def test_delete_document_removes_it_from_list(client):
    c, engine = client
    doc = _doc(engine)
    c.delete(f"/api/documents/{doc.id}")
    response = c.get("/api/documents")
    assert response.json() == []


def test_delete_nonexistent_document_returns_404(client):
    c, _ = client
    response = c.delete("/api/documents/no-such-id")
    assert response.status_code == 404
