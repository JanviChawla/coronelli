import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.db.models import SourceDocument, SourceSection
from app.domain.world import EntityMention, MapClaim, MapEntity, MapTravelRule
from app.extraction.models import Candidate, ExtractionRun
from app.extraction.prompts import GLOBAL_EVIDENCE_CONTAINMENT_VERSION, GLOBAL_EVIDENCE_DEDUP_VERSION
from app.evaluation.oracle import evaluate_atlas

router = APIRouter(tags=["atlas"])


# ── Shared provenance helper ───────────────────────────────────────────────────

def _provenance(document_id: str | None, section_id: str | None) -> dict:
    return {"document_id": document_id, "section_id": section_id}


def _discovery(entity: MapEntity) -> dict | None:
    if not entity.provenance_section_id:
        return None
    return {
        "becomes_visible_at": _provenance(
            entity.provenance_document_id, entity.provenance_section_id
        ),
        "visibility_policy": "not-rendered-before-discovery",
    }


# ── Internal atlas API ─────────────────────────────────────────────────────────

class ClaimOut(BaseModel):
    id: str
    claim_type: str
    predicate: str | None
    subject_ref: str | None
    object_refs: list | None
    payload: dict
    confidence: float | None
    excerpt: str | None = None
    status: str = "explicit"
    provenance: dict

    model_config = {"from_attributes": True}


class AtlasEntityOut(BaseModel):
    id: str
    name: str
    place_kind: str | None
    aliases: list | None
    state: str
    status: str
    provenance_document_id: str | None
    provenance_section_id: str | None
    provenance: dict
    discovery: dict | None
    payload: dict
    claims: list[ClaimOut]


class TravelRuleOut(BaseModel):
    id: str
    traveler: str | None
    route: str | None
    can_traverse: bool | None
    condition: str | None
    payload: dict

    model_config = {"from_attributes": True}


class AtlasResponse(BaseModel):
    document_id: str
    entities: list[AtlasEntityOut]
    travel_rules: list[TravelRuleOut]
    entity_count: int
    claim_count: int
    travel_rule_count: int


@router.get("/api/documents/{document_id}/atlas", response_model=AtlasResponse)
def get_atlas(document_id: str, db: Session = Depends(get_db)) -> AtlasResponse:
    entities = (
        db.query(MapEntity)
        .filter(
            MapEntity.provenance_document_id == document_id,
            MapEntity.state == "active",
        )
        .order_by(MapEntity.name)
        .all()
    )

    all_claims = (
        db.query(MapClaim)
        .filter(
            MapClaim.provenance_document_id == document_id,
            MapClaim.state == "active",
        )
        .all()
    )

    travel_rules = (
        db.query(MapTravelRule)
        .filter(
            MapTravelRule.provenance_document_id == document_id,
            MapTravelRule.state == "active",
        )
        .all()
    )

    active_entity_ids = {e.id for e in entities}

    claims_by_entity: dict[str, list[MapClaim]] = {}
    # Sort: manual claims first so they win over synthesis claims in containment resolution
    for claim in sorted(all_claims, key=lambda c: 0 if c.status == "manual" else 1):
        if not claim.subject_ref:
            continue
        # Visual claims have no predicate — let them through; all others require one
        if not claim.predicate and claim.claim_type != "visual":
            continue
        # Drop self-referencing claims
        if claim.object_refs and claim.subject_ref in claim.object_refs:
            continue
        # Drop claims referencing deleted/non-existent entities as objects
        if claim.object_refs and not all(oid in active_entity_ids for oid in claim.object_refs):
            continue
        claims_by_entity.setdefault(claim.subject_ref, []).append(claim)

    entity_outs = [
        AtlasEntityOut(
            id=e.id,
            name=e.name,
            place_kind=e.place_kind,
            aliases=e.aliases,
            state=e.state,
            status=e.status,
            provenance_document_id=e.provenance_document_id,
            provenance_section_id=e.provenance_section_id,
            provenance=_provenance(e.provenance_document_id, e.provenance_section_id),
            discovery=_discovery(e),
            payload=e.payload,
            claims=[
                ClaimOut(
                    id=c.id,
                    claim_type=c.claim_type,
                    predicate=c.predicate,
                    subject_ref=c.subject_ref,
                    object_refs=c.object_refs,
                    payload=c.payload,
                    confidence=c.confidence,
                    excerpt=c.excerpt,
                    status=c.status,
                    provenance=_provenance(c.provenance_document_id, c.provenance_section_id),
                )
                for c in claims_by_entity.get(e.id, [])
            ],
        )
        for e in entities
    ]

    return AtlasResponse(
        document_id=document_id,
        entities=entity_outs,
        travel_rules=[TravelRuleOut.model_validate(r) for r in travel_rules],
        entity_count=len(entities),
        claim_count=len(all_claims),
        travel_rule_count=len(travel_rules),
    )


# ── Entity mentions ───────────────────────────────────────────────────────────

class EntityMentionOut(BaseModel):
    id: str
    entity_id: str
    document_id: str
    section_id: str
    section_ordinal: int
    mention_kind: str

    model_config = {"from_attributes": True}


@router.get("/api/documents/{document_id}/entity-mentions", response_model=list[EntityMentionOut])
def get_entity_mentions(document_id: str, db: Session = Depends(get_db)) -> list[EntityMentionOut]:
    mentions = (
        db.query(EntityMention)
        .filter(EntityMention.document_id == document_id)
        .order_by(EntityMention.section_ordinal)
        .all()
    )
    return [EntityMentionOut.model_validate(m) for m in mentions]


# ── Atlas JSON export (canonical, Phase 4) ────────────────────────────────────

@router.get("/api/documents/{document_id}/atlas.json")
def export_atlas_json(document_id: str, db: Session = Depends(get_db)) -> JSONResponse:
    doc = db.get(SourceDocument, document_id)

    entities = (
        db.query(MapEntity)
        .filter(MapEntity.provenance_document_id == document_id, MapEntity.state == "active")
        .order_by(MapEntity.name)
        .all()
    )
    all_claims = (
        db.query(MapClaim)
        .filter(MapClaim.provenance_document_id == document_id, MapClaim.state == "active")
        .all()
    )
    travel_rules = (
        db.query(MapTravelRule)
        .filter(MapTravelRule.provenance_document_id == document_id, MapTravelRule.state == "active")
        .all()
    )

    active_entity_ids = {e.id for e in entities}
    entity_by_id = {e.id: e for e in entities}

    # located_in: non-manual first, then manual overwrites so manual wins
    located_in: dict[str, str] = {}
    for claim in sorted(all_claims, key=lambda c: 1 if c.status == "manual" else 0):
        if (
            claim.predicate == "LOCATED_IN"
            and claim.subject_ref in active_entity_ids
            and claim.object_refs
        ):
            container_id = claim.object_refs[0]
            if container_id in entity_by_id:
                located_in[claim.subject_ref] = entity_by_id[container_id].name

    # excerpt map: lowercased canonical name → first excerpt from entity candidates
    section_ids = {
        s.id for s in db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .all()
    }
    entity_candidates = (
        db.query(Candidate)
        .filter(
            Candidate.kind == "entity",
            Candidate.status != "rejected",
            Candidate.excerpt != "",
            Candidate.section_id.in_(section_ids),
        )
        .order_by(Candidate.ordinal)
        .all()
    )
    excerpt_by_name: dict[str, str] = {}
    for cand in entity_candidates:
        cname = (cand.payload or {}).get("name", "").lower()
        if cname and cname not in excerpt_by_name and cand.excerpt:
            excerpt_by_name[cname] = cand.excerpt.strip()

    def _first_excerpt(entity: MapEntity) -> str | None:
        exc = excerpt_by_name.get(entity.name.lower())
        if exc:
            return exc
        for alias in (entity.aliases or []):
            exc = excerpt_by_name.get(alias.lower())
            if exc:
                return exc
        return None

    def _id_to_name(eid: str | None) -> str | None:
        return entity_by_id[eid].name if eid and eid in entity_by_id else None

    world_entities = [
        {
            "id": e.id,
            "name": e.name,
            "kind": e.place_kind,
            "tier": (e.payload or {}).get("tier"),
            "colors": (e.payload or {}).get("colors"),
            "aliases": list(e.aliases or []),
            "located_in": located_in.get(e.id),
            "excerpt": _first_excerpt(e),
        }
        for e in entities
    ]

    spatial_claims = []
    visual_claims = []
    for c in all_claims:
        if not c.subject_ref or not c.predicate:
            continue
        object_id = c.object_refs[0] if c.object_refs else None
        if c.claim_type == "spatial":
            spatial_claims.append({
                "id": c.id,
                "subject": _id_to_name(c.subject_ref) or c.payload.get("subject"),
                "predicate": c.predicate,
                "object": _id_to_name(object_id) or c.payload.get("object"),
                "status": c.status,
                "excerpt": c.excerpt,
            })
        elif c.claim_type == "visual":
            visual_claims.append({
                "id": c.id,
                "subject": _id_to_name(c.subject_ref) or c.payload.get("subject"),
                "visual_property": c.payload.get("visual_property") or c.payload.get("category", ""),
                "value": c.payload.get("value") or c.payload.get("observation", ""),
                "status": c.status,
            })

    routes = [
        {
            "id": r.id,
            "traveler": r.traveler,
            "from": r.payload.get("from"),
            "to": r.payload.get("to"),
            "via": r.payload.get("via"),
            "can_traverse": r.can_traverse,
            "condition": r.condition,
        }
        for r in travel_rules
    ]

    package = {
        "format": "coronelli-atlas-v1",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "document": {
            "id": document_id,
            "title": doc.title if doc else document_id,
        },
        "entities": world_entities,
        "spatial_claims": spatial_claims,
        "visual_claims": visual_claims,
        "routes": routes,
    }

    raw_slug = re.sub(r'[^a-z0-9]+', '-', (doc.title if doc else document_id).lower()).strip('-')
    filename = f"atlas-{raw_slug[:40]}.json"
    return JSONResponse(
        content=package,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Atlas Package v0.1 export ──────────────────────────────────────────────────

@router.get("/api/documents/{document_id}/atlas-package")
def export_atlas_package(document_id: str, db: Session = Depends(get_db)) -> JSONResponse:
    doc = db.get(SourceDocument, document_id)

    sections = (
        db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .order_by(SourceSection.ordinal)
        .all()
    )

    entities = (
        db.query(MapEntity)
        .filter(MapEntity.provenance_document_id == document_id, MapEntity.state == "active")
        .order_by(MapEntity.name)
        .all()
    )
    all_claims = (
        db.query(MapClaim)
        .filter(MapClaim.provenance_document_id == document_id, MapClaim.state == "active")
        .all()
    )
    travel_rules = (
        db.query(MapTravelRule)
        .filter(MapTravelRule.provenance_document_id == document_id, MapTravelRule.state == "active")
        .all()
    )

    # Build lookup tables
    entity_by_id: dict[str, MapEntity] = {e.id: e for e in entities}
    entity_id_by_name: dict[str, str] = {e.name.lower(): e.id for e in entities}
    for e in entities:
        for alias in (e.aliases or []):
            if alias.lower() not in entity_id_by_name:
                entity_id_by_name[alias.lower()] = e.id

    def _name_to_id(name: str | None) -> str | None:
        return entity_id_by_name.get(name.lower()) if name else None

    def _id_to_name(entity_id: str | None) -> str | None:
        return entity_by_id[entity_id].name if entity_id and entity_id in entity_by_id else None

    # ── Manifest ────────────────────────────────────────────────────────────────
    manifest = {
        "package_id": str(uuid.uuid4()),
        "format_version": "atlas-package-v0.1",
        "profile": "single-file-json",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "generator": "coronelli",
        "entity_count": len(entities),
        "claim_count": len(all_claims),
        "route_count": len(travel_rules),
        "source_count": 1,
    }

    # ── Sources ─────────────────────────────────────────────────────────────────
    sources = [
        {
            "document_id": document_id,
            "title": doc.title if doc else document_id,
            "sections": [
                {
                    "section_id": s.id,
                    "ordinal": s.ordinal,
                    "title": s.title,
                }
                for s in sections
            ],
        }
    ]

    # ── World — entities ────────────────────────────────────────────────────────
    world_entities = []
    for e in entities:
        world_entities.append({
            "id": e.id,
            "name": e.name,
            "type": e.place_kind,
            "aliases": list(e.aliases or []),
            "status": e.status,
            "provenance": _provenance(e.provenance_document_id, e.provenance_section_id),
            "discovery": _discovery(e),
            "notes": e.payload.get("notes"),
        })

    # ── World — claims ──────────────────────────────────────────────────────────
    spatial_claims = []
    visual_claims = []
    for c in all_claims:
        object_id = c.object_refs[0] if c.object_refs else None
        prov = _provenance(c.provenance_document_id, c.provenance_section_id)

        if c.claim_type == "spatial":
            spatial_claims.append({
                "id": c.id,
                "subject_id": c.subject_ref,
                "subject_name": _id_to_name(c.subject_ref) or c.payload.get("subject"),
                "predicate": c.predicate or c.payload.get("predicate"),
                "object_id": object_id,
                "object_name": _id_to_name(object_id) or c.payload.get("object"),
                "status": c.status,
                "confidence": c.confidence,
                "provenance": prov,
                "excerpt": c.excerpt,
            })
        elif c.claim_type == "visual":
            visual_claims.append({
                "id": c.id,
                "subject_id": c.subject_ref,
                "subject_name": _id_to_name(c.subject_ref) or c.payload.get("subject"),
                "visual_property": c.payload.get("visual_property") or c.payload.get("category", ""),
                "value": c.payload.get("value") or c.payload.get("observation", ""),
                "status": c.status,
                "provenance": prov,
            })

    # ── World — routes ──────────────────────────────────────────────────────────
    world_routes = []
    for r in travel_rules:
        from_name = r.payload.get("from")
        to_name = r.payload.get("to")
        via_name = r.payload.get("via")
        world_routes.append({
            "id": r.id,
            "traveler": r.traveler,
            "from_id": _name_to_id(from_name),
            "from_name": from_name,
            "to_id": _name_to_id(to_name),
            "to_name": to_name,
            "via_id": _name_to_id(via_name),
            "via_name": via_name,
            "can_traverse": r.can_traverse,
            "condition": r.condition,
            "provenance": _provenance(r.provenance_document_id, r.provenance_section_id),
        })

    package = {
        "format": "atlas-package-v0.1-single",
        "manifest": manifest,
        "sources": sources,
        "world": {
            "entities": world_entities,
            "spatial_claims": spatial_claims,
            "visual_claims": visual_claims,
            "routes": world_routes,
        },
    }

    slug = (doc.title if doc else document_id)[:32].replace(" ", "-").lower()
    filename = f"atlas-{slug}-v0.1.json"
    return JSONResponse(
        content=package,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Place suggestions (autocomplete from section text) ───────────────────────

_CAP_SEQUENCE = re.compile(r'\b([A-Z][a-z]{1,}(?:[ \t]+[A-Z][a-z]{1,}){0,3})\b')
_COMMON_STARTERS = {
    "The", "A", "An", "In", "On", "At", "By", "He", "She", "They", "It", "We",
    "I", "You", "His", "Her", "Its", "Their", "Our", "My", "This", "That",
    "Then", "When", "But", "And", "Or", "So", "As", "If", "Up", "Down",
    "Now", "All", "No", "Not", "There", "Here", "With", "From", "For",
    "After", "Before", "Into", "Over", "Out", "Was", "Were", "Had",
    "Has", "Have", "Could", "Would", "Should", "May", "Might", "Will",
    # common verbs/adverbs that start sentences
    "Behind", "Besides", "Better", "Bless", "Can", "Did", "Do", "Does",
    "Else", "Even", "Just", "Looked", "Never", "Nobody", "One", "Open",
    "Perhaps", "Personally", "Really", "Round", "Sometimes", "Still",
    "Such", "Through", "Well", "What", "Why", "Hurrah", "Indeed", "How",
    "Half", "Fourth", "Don", "Dear", "Cousin",
}
_ARTICLES = frozenset({"the", "a", "an"})
_WHITESPACE = re.compile(r'\s+')


def _text_search_suggestions(sections: list, query: str) -> list[str]:
    """Find canonical phrases from section text containing the query as a substring.

    Tries both space and hyphen variants (dining room ↔ dining-room).
    Attaches a preceding article when present (the parlor, a hall).
    Returns up to 8 results ranked by occurrence count.
    """
    from collections import Counter
    q = query.strip().lower()
    if not q:
        return []
    # Search both space and hyphen variants so "dining room" finds "dining-room" too
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
                # Extend the match to the end of the word (include trailing alpha/hyphen)
                end = idx + len(variant)
                while end < len(text) and (text[end].isalpha() or text[end] == "-"):
                    end += 1
                # Look back up to ~20 chars for an article
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
def get_place_suggestions(document_id: str, q: str | None = None, db: Session = Depends(get_db)) -> list[str]:
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


# ── Manual entity creation ────────────────────────────────────────────────────

class ManualEntityRequest(BaseModel):
    name: str
    type: str | None = None
    spatial_level: int | None = None


class ManualEntityResponse(BaseModel):
    id: str
    name: str


@router.post("/api/documents/{document_id}/manual-entity", response_model=ManualEntityResponse)
def add_manual_entity(document_id: str, body: ManualEntityRequest, db: Session = Depends(get_db)):
    from fastapi import HTTPException
    from app.extraction.models import Candidate, ExtractionRun

    if not body.name or not body.name.strip():
        raise HTTPException(status_code=422, detail="name is required")

    first_section = (
        db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .order_by(SourceSection.ordinal)
        .first()
    )
    if not first_section:
        raise HTTPException(status_code=404, detail="Document has no sections")

    # Find or create the manual stub ExtractionRun for this document (keyed by section)
    stub_run = (
        db.query(ExtractionRun)
        .filter(
            ExtractionRun.section_id == first_section.id,
            ExtractionRun.status == "manual",
        )
        .first()
    )
    if not stub_run:
        now = datetime.now(timezone.utc)
        stub_run = ExtractionRun(
            section_id=first_section.id,
            status="manual",
            provider="manual",
            model="manual",
            prompt_version="manual-entry",
            started_at=now,
            completed_at=now,
        )
        db.add(stub_run)
        db.flush()

    payload: dict = {"name": body.name.strip(), "type": body.type or "place", "aliases": []}
    if body.spatial_level is not None:
        payload["spatial_level"] = body.spatial_level

    candidate = Candidate(
        extraction_run_id=stub_run.id,
        section_id=first_section.id,
        kind="entity",
        payload=payload,
        status="explicit",
        confidence=1.0,
        excerpt="",
        rationale="Manually added by user",
        review_state="approved",
        ordinal=9999,
        source="manual",
    )
    db.add(candidate)
    db.commit()

    return ManualEntityResponse(id=candidate.id, name=body.name.strip())


# ── Claim CRUD ────────────────────────────────────────────────────────────────

class ClaimPatchRequest(BaseModel):
    predicate: str | None = None
    object_refs: list[str] | None = None


class ClaimCreateRequest(BaseModel):
    claim_type: str = "spatial"
    predicate: str
    subject_ref: str
    object_refs: list[str]


@router.patch("/api/documents/{document_id}/atlas/claims/{claim_id}")
def patch_atlas_claim(
    document_id: str, claim_id: str, body: ClaimPatchRequest, db: Session = Depends(get_db)
):
    from fastapi import HTTPException

    claim = db.get(MapClaim, claim_id)
    if not claim or claim.provenance_document_id != document_id or claim.state != "active":
        raise HTTPException(status_code=404, detail="Claim not found")
    if body.predicate is not None:
        claim.predicate = body.predicate
    if body.object_refs is not None:
        claim.object_refs = body.object_refs
    claim.status = "manual"  # promote to manual so synthesis won't supersede it
    db.commit()
    return {"ok": True}


@router.get("/api/documents/{document_id}/atlas/entities/{entity_id}/excerpts")
def get_entity_excerpts(document_id: str, entity_id: str, db: Session = Depends(get_db)):
    from fastapi import HTTPException

    entity = db.get(MapEntity, entity_id)
    if not entity or entity.provenance_document_id != document_id:
        raise HTTPException(status_code=404, detail="Entity not found")

    # Collect all name variants to search
    names = {entity.name.lower()}
    for alias in (entity.aliases or []):
        names.add(alias.lower())

    # Collect section ids for this document so we can scope the candidate query
    section_ids = {s.id for s in db.query(SourceSection.id).filter(SourceSection.document_id == document_id).all()}

    all_candidates = (
        db.query(Candidate, SourceSection)
        .join(SourceSection, Candidate.section_id == SourceSection.id, isouter=True)
        .filter(
            Candidate.kind == "entity",
            Candidate.status != "rejected",
            Candidate.excerpt != "",
            Candidate.section_id.in_(section_ids),
        )
        .all()
    )

    seen_excerpts: set[str] = set()
    results = []
    for candidate, section in all_candidates:
        cname = (candidate.payload or {}).get("name", "")
        if cname.lower() not in names:
            continue
        exc = (candidate.excerpt or "").strip()
        if not exc or exc in seen_excerpts:
            continue
        seen_excerpts.add(exc)
        results.append({
            "excerpt": exc,
            "section_title": section.title if section else None,
            "section_ordinal": section.ordinal if section else None,
        })

    results.sort(key=lambda r: r["section_ordinal"] or 0)
    return results


class EntityPatchRequest(BaseModel):
    place_kind: str | None = None
    tier: str | None = None  # set to "" to clear


@router.patch("/api/documents/{document_id}/atlas/entities/{entity_id}")
def patch_atlas_entity(
    document_id: str, entity_id: str, body: EntityPatchRequest, db: Session = Depends(get_db)
):
    from fastapi import HTTPException
    from sqlalchemy.orm.attributes import flag_modified

    entity = db.get(MapEntity, entity_id)
    if not entity or entity.provenance_document_id != document_id:
        raise HTTPException(status_code=404, detail="Entity not found")
    if body.place_kind is not None:
        entity.place_kind = body.place_kind
    if body.tier is not None:
        payload = dict(entity.payload or {})
        if body.tier:
            payload["tier"] = body.tier
        else:
            payload.pop("tier", None)
        entity.payload = payload
        flag_modified(entity, "payload")
    entity.status = "manual"
    db.commit()
    return {"ok": True}


@router.delete("/api/documents/{document_id}/atlas/entities/{entity_id}")
def delete_atlas_entity(
    document_id: str, entity_id: str, db: Session = Depends(get_db)
):
    from fastapi import HTTPException

    entity = db.get(MapEntity, entity_id)
    if not entity or entity.provenance_document_id != document_id:
        raise HTTPException(status_code=404, detail="Entity not found")
    entity.state = "deleted"
    # Cascade-delete claims where this entity is the subject
    for claim in db.query(MapClaim).filter(
        MapClaim.subject_ref == entity_id,
        MapClaim.state == "active",
    ).all():
        claim.state = "deleted"
    # Also cascade-delete claims on other entities that reference this entity as an object
    # (e.g. "A CONTAINS deleted_entity" — otherwise those orphan references linger)
    for claim in db.query(MapClaim).filter(
        MapClaim.provenance_document_id == document_id,
        MapClaim.state == "active",
    ).all():
        if claim.object_refs and entity_id in claim.object_refs:
            claim.state = "deleted"
    db.commit()
    return {"ok": True}


@router.delete("/api/documents/{document_id}/atlas/claims/{claim_id}")
def delete_atlas_claim(
    document_id: str, claim_id: str, db: Session = Depends(get_db)
):
    from fastapi import HTTPException

    claim = db.get(MapClaim, claim_id)
    if not claim or claim.provenance_document_id != document_id:
        raise HTTPException(status_code=404, detail="Claim not found")
    claim.state = "deleted"
    db.commit()
    return {"ok": True}


@router.post("/api/documents/{document_id}/atlas/claims", response_model=ClaimOut)
def create_atlas_claim(
    document_id: str, body: ClaimCreateRequest, db: Session = Depends(get_db)
):
    claim = MapClaim(
        id=str(uuid.uuid4()),
        claim_type=body.claim_type,
        predicate=body.predicate,
        subject_ref=body.subject_ref,
        object_refs=body.object_refs,
        provenance_document_id=document_id,
        provenance_section_id=None,
        payload={},
        confidence=1.0,
        excerpt="",
        status="manual",
        state="active",
    )
    db.add(claim)
    db.commit()
    db.refresh(claim)
    return ClaimOut(
        id=claim.id,
        claim_type=claim.claim_type,
        predicate=claim.predicate,
        subject_ref=claim.subject_ref,
        object_refs=claim.object_refs,
        payload=claim.payload,
        confidence=claim.confidence,
        excerpt=claim.excerpt,
        status=claim.status,
        provenance=_provenance(claim.provenance_document_id, claim.provenance_section_id),
    )


# ── Assign containment (promote enrichment containment candidates → MapClaims) ─

@router.post("/api/documents/{document_id}/assign-containment")
def assign_containment(document_id: str, db: Session = Depends(get_db)):
    from app.extraction.prompts import CONTAINMENT_EVIDENCE_VERSION
    # Collect all completed per-section containment runs for this document
    section_ids = [
        s.id for s in db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .all()
    ]
    if not section_ids:
        return {"status": "no_enrichment_candidates", "claims_created": 0}

    runs = (
        db.query(ExtractionRun)
        .filter(
            ExtractionRun.section_id.in_(section_ids),
            ExtractionRun.status == "completed",
            ExtractionRun.prompt_version == CONTAINMENT_EVIDENCE_VERSION,
        )
        .all()
    )
    if not runs:
        # Fallback: try old global-run approach
        run = (
            db.query(ExtractionRun)
            .filter(
                ExtractionRun.document_id == document_id,
                ExtractionRun.section_id.is_(None),
                ExtractionRun.status == "completed",
                ExtractionRun.prompt_version == GLOBAL_EVIDENCE_CONTAINMENT_VERSION,
            )
            .order_by(ExtractionRun.completed_at.desc())
            .first()
        )
        if run is None:
            return {"status": "no_enrichment_candidates", "claims_created": 0}
        run_ids = [run.id]
    else:
        run_ids = [r.id for r in runs]

    containment_candidates = (
        db.query(Candidate)
        .filter(
            Candidate.extraction_run_id.in_(run_ids),
            Candidate.kind == "claim",
            Candidate.review_state != "rejected",
        )
        .all()
    )
    containment_candidates = [
        c for c in containment_candidates
        if (c.payload or {}).get("predicate") in {"CONTAINS", "LOCATED_IN", "PART_OF"}
    ]

    if not containment_candidates:
        return {"status": "no_enrichment_candidates", "claims_created": 0}

    # Build name→id lookup from active MapEntity records
    entities = (
        db.query(MapEntity)
        .filter(MapEntity.provenance_document_id == document_id, MapEntity.state == "active")
        .all()
    )
    name_to_id: dict[str, str] = {}
    for e in entities:
        name_to_id[e.name.lower()] = e.id
        for alias in (e.aliases or []):
            if alias.lower() not in name_to_id:
                name_to_id[alias.lower()] = e.id

    # Build set of existing active containment claims to avoid dupes
    existing: set[tuple[str, str]] = set()
    for claim in (
        db.query(MapClaim)
        .filter(
            MapClaim.provenance_document_id == document_id,
            MapClaim.predicate.in_(["LOCATED_IN", "CONTAINS", "PART_OF"]),
            MapClaim.state == "active",
        )
        .all()
    ):
        if claim.subject_ref and claim.object_refs:
            existing.add((claim.subject_ref, claim.object_refs[0]))

    created = 0
    for cand in containment_candidates:
        payload = cand.payload or {}
        predicate = str(payload.get("predicate", "")).upper()
        subject_name = str(payload.get("subject", "")).lower()
        object_name = str(payload.get("object", "")).lower()

        if predicate == "CONTAINS":
            # CONTAINS(subject=container, object=contained) → contained LOCATED_IN container
            contained_id = name_to_id.get(object_name)
            container_id = name_to_id.get(subject_name)
        else:
            # LOCATED_IN / PART_OF: subject is inside object
            contained_id = name_to_id.get(subject_name)
            container_id = name_to_id.get(object_name)

        if not container_id or not contained_id or container_id == contained_id:
            continue
        if (contained_id, container_id) in existing:
            continue

        claim = MapClaim(
            id=str(uuid.uuid4()),
            claim_type="spatial",
            predicate="LOCATED_IN",
            subject_ref=contained_id,
            object_refs=[container_id],
            provenance_document_id=document_id,
            provenance_section_id=cand.section_id,
            payload={},
            confidence=cand.confidence or 0.85,
            excerpt=cand.excerpt or "",
            status="explicit",
            state="active",
        )
        db.add(claim)
        existing.add((contained_id, container_id))
        created += 1

    db.commit()
    return {"status": "ok", "claims_created": created}


# ── Promote dedup candidates → entity merges ─────────────────────────────────

@router.post("/api/documents/{document_id}/promote-dedup")
def promote_dedup(document_id: str, db: Session = Depends(get_db)):
    from fastapi import HTTPException

    # Find the most recent completed dedup run for this document
    run = (
        db.query(ExtractionRun)
        .filter(
            ExtractionRun.document_id == document_id,
            ExtractionRun.section_id.is_(None),
            ExtractionRun.status == "completed",
            ExtractionRun.prompt_version == GLOBAL_EVIDENCE_DEDUP_VERSION,
        )
        .order_by(ExtractionRun.completed_at.desc())
        .first()
    )
    if run is None:
        return {"status": "no_dedup_candidates", "merges_performed": 0}

    # Fetch SAME_AS candidates
    dedup_candidates = (
        db.query(Candidate)
        .filter(
            Candidate.extraction_run_id == run.id,
            Candidate.kind == "claim",
        )
        .all()
    )
    dedup_candidates = [
        c for c in dedup_candidates
        if (c.payload or {}).get("predicate") == "SAME_AS"
    ]

    if not dedup_candidates:
        return {"status": "no_dedup_candidates", "merges_performed": 0}

    # Build name→entity lookup from active MapEntity records
    entities = (
        db.query(MapEntity)
        .filter(MapEntity.provenance_document_id == document_id, MapEntity.state == "active")
        .all()
    )
    name_to_entity: dict[str, MapEntity] = {}
    for e in entities:
        name_to_entity[e.name.lower()] = e
        for alias in (e.aliases or []):
            if alias.lower() not in name_to_entity:
                name_to_entity[alias.lower()] = e

    merges = 0
    merged_ids: set[str] = set()

    for cand in dedup_candidates:
        payload = cand.payload or {}
        # SAME_AS: subject=canonical, object=alias/duplicate
        canonical_name = str(payload.get("subject", "")).lower()
        alias_name = str(payload.get("object", "")).lower()
        keep = name_to_entity.get(canonical_name)
        drop = name_to_entity.get(alias_name)
        if not keep or not drop:
            continue
        if keep.id == drop.id:
            continue
        if keep.id in merged_ids or drop.id in merged_ids:
            continue
        if keep.state != "active" or drop.state != "active":
            continue

        # Absorb drop into keep
        new_aliases = list(keep.aliases or [])
        for name in [drop.name, *(drop.aliases or [])]:
            if name and name != keep.name and name not in new_aliases:
                new_aliases.append(name)
        keep.aliases = new_aliases

        db.query(MapClaim).filter(
            MapClaim.subject_ref == drop.id,
            MapClaim.state == "active",
        ).update({"subject_ref": keep.id}, synchronize_session=False)

        object_claims = db.query(MapClaim).filter(MapClaim.state == "active").all()
        for c in object_claims:
            if c.object_refs and drop.id in c.object_refs:
                c.object_refs = [keep.id if r == drop.id else r for r in c.object_refs]

        drop.state = "merged"
        merged_ids.add(drop.id)
        # Update lookup so subsequent merges see the new state
        for k, v in list(name_to_entity.items()):
            if v.id == drop.id:
                name_to_entity[k] = keep
        merges += 1

    db.commit()
    return {"status": "ok", "merges_performed": merges}


# ── Entity merge ──────────────────────────────────────────────────────────────

class EntityMergeRequest(BaseModel):
    keep_id: str   # stays active, gains aliases
    drop_id: str   # becomes alias, state → "merged"


class EntityMergeResponse(BaseModel):
    merged: bool
    canonical_entity_id: str
    canonical_entity_name: str
    new_aliases: list[str]


@router.post("/api/entities/merge", response_model=EntityMergeResponse)
def merge_entities(body: EntityMergeRequest, db: Session = Depends(get_db)):
    from fastapi import HTTPException
    keep = db.get(MapEntity, body.keep_id)
    drop = db.get(MapEntity, body.drop_id)
    if not keep or not drop:
        raise HTTPException(status_code=404, detail="One or both entities not found")
    if keep.id == drop.id:
        raise HTTPException(status_code=422, detail="Cannot merge an entity with itself")
    if keep.state != "active" or drop.state != "active":
        raise HTTPException(status_code=422, detail="Both entities must be active")

    # Absorb drop's name and aliases into keep's alias list
    new_aliases = list(keep.aliases or [])
    for name in [drop.name, *(drop.aliases or [])]:
        if name and name != keep.name and name not in new_aliases:
            new_aliases.append(name)
    keep.aliases = new_aliases

    # Redirect active claims: subject_ref
    db.query(MapClaim).filter(
        MapClaim.subject_ref == body.drop_id,
        MapClaim.state == "active",
    ).update({"subject_ref": body.keep_id}, synchronize_session=False)

    # Redirect active claims: object_refs (JSON array — must iterate in Python)
    object_claims = (
        db.query(MapClaim)
        .filter(MapClaim.state == "active")
        .all()
    )
    for c in object_claims:
        if c.object_refs and body.drop_id in c.object_refs:
            c.object_refs = [body.keep_id if r == body.drop_id else r for r in c.object_refs]

    drop.state = "merged"
    db.commit()
    db.refresh(keep)

    return EntityMergeResponse(
        merged=True,
        canonical_entity_id=keep.id,
        canonical_entity_name=keep.name,
        new_aliases=new_aliases,
    )


# ── Oracle evaluation ──────────────────────────────────────────────────────────

class OracleRequest(BaseModel):
    expected_entities: list[str]
    expected_claims: list[dict] = []


class OracleResultOut(BaseModel):
    document_id: str
    entity_recall: float
    entity_precision: float
    found_entities: list[str]
    missed_entities: list[str]
    extra_entities: list[str]
    claim_recall: float | None
    found_claims: list[dict]
    missed_claims: list[dict]


@router.post("/api/documents/{document_id}/atlas/evaluate", response_model=OracleResultOut)
def evaluate_document_atlas(
    document_id: str,
    body: OracleRequest,
    db: Session = Depends(get_db),
) -> OracleResultOut:
    entities = (
        db.query(MapEntity)
        .filter(MapEntity.provenance_document_id == document_id, MapEntity.state == "active")
        .all()
    )
    approved_names = [e.name for e in entities]

    all_claims = (
        db.query(MapClaim)
        .filter(
            MapClaim.provenance_document_id == document_id,
            MapClaim.state == "active",
            MapClaim.claim_type == "spatial",
        )
        .all()
    )
    approved_claims = [
        {
            "subject": c.payload.get("subject", ""),
            "predicate": c.predicate or "",
            "object": c.payload.get("object", ""),
        }
        for c in all_claims
    ]

    result = evaluate_atlas(
        approved_names=approved_names,
        oracle_names=body.expected_entities,
        approved_claims=approved_claims,
        oracle_claims=body.expected_claims if body.expected_claims else None,
    )

    return OracleResultOut(
        document_id=document_id,
        entity_recall=result.entity_recall,
        entity_precision=result.entity_precision,
        found_entities=result.found_entities,
        missed_entities=result.missed_entities,
        extra_entities=result.extra_entities,
        claim_recall=result.claim_recall,
        found_claims=result.found_claims,
        missed_claims=result.missed_claims,
    )
