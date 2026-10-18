import re

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.db.models import SourceDocument, SourceSection
from app.domain.world import MapEntity
from app.extraction.models import Candidate

router = APIRouter(tags=["atlas"])


# ── Place suggestions (autocomplete from section text) ────────────────────────

_CAP_SEQUENCE = re.compile(r'\b([A-Z][a-z]{1,}(?:[ \t]+[A-Z][a-z]{1,}){0,3})\b')
_COMMON_STARTERS = {
    "The", "A", "An", "In", "On", "At", "By", "He", "She", "They", "It", "We",
    "I", "You", "His", "Her", "Its", "Their", "Our", "My", "This", "That",
    "Then", "When", "But", "And", "Or", "So", "As", "If", "Up", "Down",
    "Now", "All", "No", "Not", "There", "Here", "With", "From", "For",
    "After", "Before", "Into", "Over", "Out", "Was", "Were", "Had",
    "Has", "Have", "Could", "Would", "Should", "May", "Might", "Will",
    "Behind", "Besides", "Better", "Bless", "Can", "Did", "Do", "Does",
    "Else", "Even", "Just", "Looked", "Never", "Nobody", "One", "Open",
    "Perhaps", "Personally", "Really", "Round", "Sometimes", "Still",
    "Such", "Through", "Well", "What", "Why", "Hurrah", "Indeed", "How",
    "Half", "Fourth", "Don", "Dear", "Cousin",
}
_ARTICLES = frozenset({"the", "a", "an"})
_WHITESPACE = re.compile(r'\s+')


def _text_search_suggestions(sections: list, query: str) -> list[str]:
    from collections import Counter
    q = query.strip().lower()
    if not q:
        return []
    variants: set[str] = {q}
    if " " in q:
        variants.add(q.replace(" ", "-"))
    elif "-" in q:
        variants.add(q.replace("-", " "))

    counts: Counter[str] = Counter()
    for section in sections:
        text = section.text or ""
        text_lower = text.lower()
        for variant in variants:
            pos = 0
            while pos < len(text_lower):
                idx = text_lower.find(variant, pos)
                if idx == -1:
                    break
                end = idx + len(variant)
                while end < len(text) and (text[end].isalpha() or text[end] == "-"):
                    end += 1
                look_back = text[:idx].rstrip()
                article_m = re.search(r'\b([a-zA-Z]+)\s*$', look_back)
                if article_m and article_m.group(1).lower() in _ARTICLES:
                    start = article_m.start()
                else:
                    start = idx
                phrase = _WHITESPACE.sub(" ", text[start:end]).strip().lower()
                if len(phrase) >= 2:
                    counts[phrase] += 1
                pos = idx + 1

    return [phrase for phrase, _ in counts.most_common(8)]


@router.get("/api/documents/{document_id}/place-suggestions", response_model=list[str])
def get_place_suggestions(
    document_id: str, q: str | None = None, db: Session = Depends(get_db)
) -> list[str]:
    sections = (
        db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .order_by(SourceSection.ordinal)
        .all()
    )
    if q and q.strip():
        return _text_search_suggestions(sections, q.strip())
    suggestions: set[str] = set()
    for section in sections:
        text = section.text or ""
        for m in _CAP_SEQUENCE.finditer(text):
            phrase = m.group(1).strip()
            first_word = phrase.split()[0]
            if first_word in _COMMON_STARTERS:
                continue
            if len(phrase) >= 3:
                suggestions.add(phrase)
    return sorted(suggestions)


# ── Catalog web validation ─────────────────────────────────────────────────────

_WEB_CHECK_PRICING: dict[str, tuple[float, float]] = {
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (5.0, 15.0),
    "gpt-4o-2024-08-06": (2.5, 10.0),
    "gpt-4o-2024-11-20": (2.5, 10.0),
}


class CatalogValidationResponse(BaseModel):
    suggestions: list[dict]
    cost_usd: float = 0.0


@router.post("/api/documents/{document_id}/catalog/validate", response_model=CatalogValidationResponse)
def validate_catalog(document_id: str, db: Session = Depends(get_db)) -> CatalogValidationResponse:
    import json
    import os

    from fastapi import HTTPException

    doc = db.get(SourceDocument, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    api_key = os.environ.get("OPENAI_API_KEY")
    model = os.environ.get("OPENAI_EXTRACTION_MODEL", "gpt-4o-mini")
    if not api_key:
        raise HTTPException(status_code=503, detail="LLM not configured")

    entities = (
        db.query(MapEntity)
        .filter(MapEntity.provenance_document_id == document_id, MapEntity.state == "active")
        .all()
    )
    section_ids = [
        s.id for s in db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .all()
    ]
    candidates = (
        db.query(Candidate)
        .filter(
            Candidate.section_id.in_(section_ids),
            Candidate.kind == "entity",
            Candidate.review_state != "rejected",
        )
        .all()
    ) if section_ids else []

    known: set[str] = set()
    for e in entities:
        known.add(e.name.lower())
        for alias in (e.aliases or []):
            known.add(alias.lower())
    for c in candidates:
        n = (c.payload or {}).get("name", "")
        if n:
            known.add(n.lower())

    title = doc.title or ""
    author = doc.author or ""
    known_list = sorted(known)[:200]

    prompt = (
        f'You are a literary expert. The book "{title}"'
        f"{(' by ' + author) if author else ''} has been partially cataloged for named locations.\n\n"
        "Already cataloged (case-insensitive):\n"
        + "\n".join(f"- {n}" for n in known_list)
        + "\n\nBased on your knowledge of this specific book, list up to 10 named locations "
        "that APPEAR IN THE BOOK but are NOT in the catalog above. Be conservative — only include "
        "places you are highly confident appear in the text. For books you don't know well, return "
        'an empty suggestions list.\n\n'
        'Return JSON: {"suggestions": [{"name": "Exact Place Name As In Book", "reason": "brief reason", '
        '"first_seen": "Chapter or part where this place first appears, e.g. \\"Chapter 5\\" or \\"Part II\\""}]}'
    )

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=1000,
            response_format={"type": "json_object"},
        )
        raw = resp.choices[0].message.content or "{}"
        parsed = json.loads(raw)
        suggestions = parsed.get("suggestions", [])
        filtered = [
            s for s in suggestions
            if isinstance(s, dict) and s.get("name") and s["name"].lower() not in known
        ]
        usage = resp.usage
        in_price, out_price = _WEB_CHECK_PRICING.get(model, (5.0, 15.0))
        cost_usd = 0.0
        if usage:
            cost_usd = (usage.prompt_tokens * in_price + usage.completion_tokens * out_price) / 1_000_000
        return CatalogValidationResponse(suggestions=filtered[:10], cost_usd=round(cost_usd, 5))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Validation failed: {str(e)}")
