import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.atlas_read import ClaimOut, _provenance
from app.db.engine import get_db
from app.db.models import SourceSection
from app.domain.world import MapClaim, MapEntity
from app.extraction.models import Candidate, ExtractionRun

router = APIRouter(tags=["atlas"])


# ── Entity patch / delete ─────────────────────────────────────────────────────

class EntityPatchRequest(BaseModel):
    name: str | None = None
    place_kind: str | None = None
    tier: str | None = None
    spatial_level: int | None = None


@router.patch("/api/documents/{document_id}/atlas/entities/{entity_id}")
def patch_atlas_entity(
    document_id: str, entity_id: str, body: EntityPatchRequest, db: Session = Depends(get_db)
):
    from fastapi import HTTPException
    from sqlalchemy.orm.attributes import flag_modified

    entity = db.get(MapEntity, entity_id)
    if not entity or entity.provenance_document_id != document_id:
        raise HTTPException(status_code=404, detail="Entity not found")
    if body.name is not None:
        new_name = body.name.strip()
        if new_name and new_name != entity.name:
            old_name = entity.name
            entity.name = new_name
            aliases = list(entity.aliases or [])
            if old_name and old_name not in aliases:
                aliases.insert(0, old_name)
            entity.aliases = aliases
            flag_modified(entity, "aliases")
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
    if body.spatial_level is not None:
        payload = dict(entity.payload or {})
        if body.spatial_level >= 0:
            payload["spatial_level"] = body.spatial_level
        else:
            payload.pop("spatial_level", None)
        entity.payload = payload
        flag_modified(entity, "payload")
    entity.status = "manual"
    db.commit()
    return {"ok": True}


@router.delete("/api/documents/{document_id}/atlas/entities/{entity_id}")
def delete_atlas_entity(document_id: str, entity_id: str, db: Session = Depends(get_db)):
    from fastapi import HTTPException

    entity = db.get(MapEntity, entity_id)
    if not entity or entity.provenance_document_id != document_id:
        raise HTTPException(status_code=404, detail="Entity not found")
    entity.state = "deleted"
    for claim in db.query(MapClaim).filter(
        MapClaim.subject_ref == entity_id,
        MapClaim.state == "active",
    ).all():
        claim.state = "deleted"
    for claim in db.query(MapClaim).filter(
        MapClaim.provenance_document_id == document_id,
        MapClaim.state == "active",
    ).all():
        if claim.object_refs and entity_id in claim.object_refs:
            claim.state = "deleted"
    db.commit()
    return {"ok": True}


# ── Claim patch / delete / create ─────────────────────────────────────────────

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
    claim.status = "manual"
    db.commit()
    return {"ok": True}


@router.delete("/api/documents/{document_id}/atlas/claims/{claim_id}")
def delete_atlas_claim(document_id: str, claim_id: str, db: Session = Depends(get_db)):
    from fastapi import HTTPException

    claim = db.get(MapClaim, claim_id)
    if not claim or claim.provenance_document_id != document_id:
        raise HTTPException(status_code=404, detail="Claim not found")
    claim.state = "deleted"
    db.commit()
    return {"ok": True}


@router.post("/api/documents/{document_id}/atlas/claims", response_model=ClaimOut)
def create_atlas_claim(document_id: str, body: ClaimCreateRequest, db: Session = Depends(get_db)):
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


# ── Manual entity creation ─────────────────────────────────────────────────────

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


# ── Entity merge ───────────────────────────────────────────────────────────────

class EntityMergeRequest(BaseModel):
    keep_id: str
    drop_id: str


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

    new_aliases = list(keep.aliases or [])
    for name in [drop.name, *(drop.aliases or [])]:
        if name and name != keep.name and name not in new_aliases:
            new_aliases.append(name)
    keep.aliases = new_aliases

    db.query(MapClaim).filter(
        MapClaim.subject_ref == body.drop_id,
        MapClaim.state == "active",
    ).update({"subject_ref": body.keep_id}, synchronize_session=False)

    object_claims = db.query(MapClaim).filter(MapClaim.state == "active").all()
    for c in object_claims:
        if c.object_refs and body.drop_id in c.object_refs:
            c.object_refs = [body.keep_id if r == body.drop_id else r for r in c.object_refs]

    drop.state = "merged"

    _existing_same_as = db.query(MapClaim).filter(
        MapClaim.subject_ref == keep.id,
        MapClaim.predicate == "SAME_AS",
        MapClaim.state == "active",
    ).all()
    if not any(c.object_refs and drop.id in c.object_refs for c in _existing_same_as):
        db.add(MapClaim(
            claim_type="spatial",
            subject_ref=keep.id,
            predicate="SAME_AS",
            object_refs=[drop.id],
            status="manual",
            state="active",
            provenance_document_id=keep.provenance_document_id,
            payload={"subject": keep.name, "object": drop.name, "predicate": "SAME_AS"},
        ))

    db.commit()
    db.refresh(keep)

    return EntityMergeResponse(
        merged=True,
        canonical_entity_id=keep.id,
        canonical_entity_name=keep.name,
        new_aliases=new_aliases,
    )
