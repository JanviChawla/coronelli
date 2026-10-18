import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db.engine import get_db
from app.db.models import SourceDocument, SourceSection
from app.domain.world import MapClaim, MapEntity
from app.extraction.models import Candidate, ExtractionRun
from app.extraction.prompts import GLOBAL_EVIDENCE_CONTAINMENT_VERSION, GLOBAL_EVIDENCE_DEDUP_VERSION

router = APIRouter(tags=["atlas"])


# ── Containment assignment ─────────────────────────────────────────────────────

@router.post("/api/documents/{document_id}/assign-containment")
def assign_containment(document_id: str, db: Session = Depends(get_db)):
    from app.extraction.prompts import CONTAINMENT_EVIDENCE_VERSION

    section_ids = [
        s.id for s in db.query(SourceSection)
        .filter(SourceSection.document_id == document_id)
        .all()
    ]
    if not section_ids:
        return {"status": "no_sections", "claims_created": 0}

    entities = (
        db.query(MapEntity)
        .filter(MapEntity.provenance_document_id == document_id, MapEntity.state == "active")
        .all()
    )
    if not entities:
        return {"status": "no_entities", "claims_created": 0}

    name_to_id: dict[str, str] = {}
    for e in entities:
        name_to_id[e.name.lower()] = e.id
        for alias in (e.aliases or []):
            if alias.lower() not in name_to_id:
                name_to_id[alias.lower()] = e.id

    existing: set[tuple[str, str]] = set()
    for claim in (
        db.query(MapClaim)
        .filter(
            MapClaim.provenance_document_id == document_id,
            MapClaim.predicate.in_(["CONTAINS", "LOCATED_IN", "PART_OF"]),
            MapClaim.state == "active",
        )
        .all()
    ):
        if claim.subject_ref and claim.object_refs:
            if claim.predicate == "CONTAINS":
                existing.add((claim.subject_ref, claim.object_refs[0]))
            else:
                existing.add((claim.object_refs[0], claim.subject_ref))

    created = 0

    # Pass 1: promote extraction-evidence candidates if any exist
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
        global_run = (
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
        if global_run:
            runs = [global_run]

    if runs:
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

        for cand in containment_candidates:
            payload = cand.payload or {}
            predicate = str(payload.get("predicate", "")).upper()
            subject_name = str(payload.get("subject", "")).lower()
            object_name = str(payload.get("object", "")).lower()

            if predicate == "CONTAINS":
                container_id = name_to_id.get(subject_name)
                contained_id = name_to_id.get(object_name)
            else:
                contained_id = name_to_id.get(subject_name)
                container_id = name_to_id.get(object_name)

            if not container_id or not contained_id or container_id == contained_id:
                continue
            if (container_id, contained_id) in existing:
                continue

            claim = MapClaim(
                id=str(uuid.uuid4()),
                claim_type="spatial",
                predicate="CONTAINS",
                subject_ref=container_id,
                object_refs=[contained_id],
                provenance_document_id=document_id,
                provenance_section_id=cand.section_id,
                payload={},
                confidence=cand.confidence or 0.85,
                excerpt=cand.excerpt or "",
                status="explicit",
                state="active",
            )
            db.add(claim)
            existing.add((container_id, contained_id))
            created += 1

        if created:
            db.commit()

    # Pass 2: always supplement with LLM inference
    created += _llm_infer_containment(db, document_id, entities, name_to_id, existing)

    return {"status": "ok", "claims_created": created}


def _llm_infer_containment(
    db,
    document_id: str,
    entities: list,
    name_to_id: dict,
    existing: set,
) -> int:
    import json
    import os

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key or not entities:
        return 0

    model = os.environ.get("OPENAI_EXTRACTION_MODEL", "gpt-4o-mini")

    doc = db.query(SourceDocument).filter(SourceDocument.id == document_id).first()
    title = (doc.title or "") if doc else ""
    author = (doc.author or "") if doc else ""

    canonical_names: dict[str, str] = {e.name: e.id for e in entities}

    def _kind_label(e) -> str:
        k = (e.place_kind or "").lower()
        labels = {
            "room": "room", "chamber": "room", "hall": "room",
            "building": "building", "structure": "building",
            "district": "district", "street": "street", "alley": "street",
            "settlement": "settlement", "city": "settlement", "town": "settlement", "village": "settlement",
            "region": "region", "country": "region", "continent": "region",
        }
        for key, label in labels.items():
            if key in k:
                return label
        return k or "place"

    names_list = "\n".join(
        f'- "{e.name}" ({_kind_label(e)})'
        for e in entities
    )

    prompt = (
        f'You are a literary expert who knows "{title}"'
        f"{(' by ' + author) if author else ''} thoroughly.\n\n"
        "Below is the COMPLETE list of named locations from this book with their type in parentheses. "
        "Your task: identify every place that is physically INSIDE another place on this list "
        "(e.g., a room inside a building, a shop inside a street, a building inside a settlement).\n\n"
        f"{names_list}\n\n"
        "Rules:\n"
        "1. Use your knowledge of the book — include implicit containment (e.g., rooms within a school "
        "even if not stated word-for-word in the text).\n"
        "2. Use ONLY the exact name strings shown in the list above. Do NOT paraphrase or invent names.\n"
        "3. Only create one level of direct containment per pair (e.g., room→building, NOT room→region).\n"
        "4. Omit pairs where either name is not in the list.\n\n"
        'Return JSON only: {"pairs": [{"container": "Exact Name From List", "contained": "Exact Name From List"}]}'
    )

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            max_tokens=1500,
            response_format={"type": "json_object"},
        )
        raw = resp.choices[0].message.content or "{}"
        parsed = json.loads(raw)
        pairs = parsed.get("pairs", [])
    except Exception:
        return 0

    def _resolve(name: str) -> str | None:
        lower = name.lower().strip()
        if lower in name_to_id:
            return name_to_id[lower]
        without_the = lower.removeprefix("the ").strip()
        if without_the in name_to_id:
            return name_to_id[without_the]
        for canon, eid in canonical_names.items():
            if lower in canon.lower() or canon.lower() in lower:
                return eid
        return None

    created = 0
    for pair in pairs:
        container_id = _resolve(str(pair.get("container", "")))
        contained_id = _resolve(str(pair.get("contained", "")))
        if not container_id or not contained_id or container_id == contained_id:
            continue
        if (container_id, contained_id) in existing:
            continue
        claim = MapClaim(
            id=str(uuid.uuid4()),
            claim_type="spatial",
            predicate="CONTAINS",
            subject_ref=container_id,
            object_refs=[contained_id],
            provenance_document_id=document_id,
            provenance_section_id=None,
            payload={},
            confidence=0.75,
            excerpt="",
            status="inferred",
            state="active",
        )
        db.add(claim)
        existing.add((container_id, contained_id))
        created += 1

    if created:
        db.commit()
    return created


# ── Dedup promotion ────────────────────────────────────────────────────────────

@router.post("/api/documents/{document_id}/promote-dedup")
def promote_dedup(document_id: str, db: Session = Depends(get_db)):
    from fastapi import HTTPException

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
        for k, v in list(name_to_entity.items()):
            if v.id == drop.id:
                name_to_entity[k] = keep

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
                status="explicit",
                state="active",
                provenance_document_id=keep.provenance_document_id,
                payload={"subject": keep.name, "object": drop.name, "predicate": "SAME_AS"},
            ))

        merges += 1

    db.commit()
    return {"status": "ok", "merges_performed": merges}
