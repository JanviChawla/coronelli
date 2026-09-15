import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, Session, mapped_column
from sqlalchemy.types import JSON

from app.db.base import Base
from app.domain.world import MapClaim, MapEntity, MapTravelRule
from app.extraction.models import Candidate


class ReviewEvent(Base):
    __tablename__ = "review_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    candidate_id: Mapped[str] = mapped_column(
        String, ForeignKey("candidates.id", ondelete="CASCADE"), nullable=False
    )
    action: Mapped[str] = mapped_column(String, nullable=False)  # approve|reject|defer|merge
    before_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    after_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    merge_target_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("candidates.id", ondelete="SET NULL"), nullable=True
    )
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    canonical_entity_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("map_entities.id", ondelete="SET NULL"), nullable=True
    )
    canonical_claim_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("map_claims.id", ondelete="SET NULL"), nullable=True
    )
    canonical_travel_rule_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("map_travel_rules.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )


class ReviewError(Exception):
    pass


def _resolve_entity_id(session: Session, document_id: str | None, name: str | None) -> str | None:
    if not document_id or not name:
        return None
    entity = (
        session.query(MapEntity)
        .filter(
            MapEntity.name == name,
            MapEntity.provenance_document_id == document_id,
            MapEntity.state == "active",
        )
        .first()
    )
    return entity.id if entity else None


_VALID_ACTIONS = {"approve", "reject", "defer", "merge"}

_ACTION_TO_STATE = {
    "approve": "approved",
    "reject": "rejected",
    "defer": "deferred",
    "merge": "merged",
}


@dataclass
class ReviewResult:
    event: ReviewEvent
    canonical_entity: MapEntity | None = field(default=None)
    canonical_claim: MapClaim | None = field(default=None)
    canonical_travel_rule: MapTravelRule | None = field(default=None)


def review_candidate(
    session: Session,
    candidate_id: str,
    action: str,
    edited_payload: dict | None = None,
    merge_target_id: str | None = None,
    rationale: str | None = None,
) -> ReviewResult:
    if action not in _VALID_ACTIONS:
        raise ReviewError(f"Invalid action '{action}'. Must be one of: {sorted(_VALID_ACTIONS)}.")

    candidate = session.get(Candidate, candidate_id)
    if candidate is None:
        raise ReviewError(f"Candidate '{candidate_id}' not found.")

    if action == "merge" and merge_target_id is None:
        raise ReviewError("merge_target_id is required when action is 'merge'.")

    effective_payload = edited_payload if edited_payload is not None else candidate.payload
    before_payload = dict(candidate.payload) if edited_payload is not None else None
    after_payload = dict(edited_payload) if edited_payload is not None else None

    entity: MapEntity | None = None
    claim: MapClaim | None = None
    travel_rule: MapTravelRule | None = None

    if action == "approve":
        # Lazy import avoids circular dependency with app.db.models importing this module.
        from app.db.models import SourceSection  # noqa: PLC0415

        section = session.get(SourceSection, candidate.section_id)
        document_id = section.document_id if section else None

        if candidate.kind == "entity":
            entity_name = effective_payload.get("name", "")
            existing_entity = (
                session.query(MapEntity)
                .filter(
                    MapEntity.name == entity_name,
                    MapEntity.provenance_document_id == document_id,
                    MapEntity.state == "active",
                )
                .first()
            ) if document_id else None

            if existing_entity:
                entity = existing_entity
            else:
                entity = MapEntity(
                    name=entity_name,
                    entity_kind="place",
                    place_kind=effective_payload.get("type"),
                    status=candidate.status,
                    state="active",
                    provenance_document_id=document_id,
                    provenance_section_id=candidate.section_id,
                    candidate_id=candidate.id,
                    payload=effective_payload,
                )
                session.add(entity)

        elif candidate.kind in ("claim", "visual_claim"):
            claim_type = "spatial" if candidate.kind == "claim" else "visual"
            subject_ref = _resolve_entity_id(session, document_id, effective_payload.get("subject"))
            object_id = _resolve_entity_id(session, document_id, effective_payload.get("object"))
            claim = MapClaim(
                claim_type=claim_type,
                subject_ref=subject_ref,
                predicate=effective_payload.get("predicate"),
                object_refs=[object_id] if object_id else None,
                status=candidate.status,
                confidence=candidate.confidence,
                state="active",
                provenance_document_id=document_id,
                provenance_section_id=candidate.section_id,
                excerpt=candidate.excerpt,
                candidate_id=candidate.id,
                payload=effective_payload,
            )
            session.add(claim)

        elif candidate.kind == "travel_rule":
            raw_traverse = effective_payload.get("can_traverse")
            travel_rule = MapTravelRule(
                traveler=effective_payload.get("traveler"),
                can_traverse=bool(raw_traverse) if raw_traverse is not None else None,
                route=effective_payload.get("route"),
                condition=effective_payload.get("condition"),
                status=candidate.status,
                state="active",
                provenance_document_id=document_id,
                provenance_section_id=candidate.section_id,
                candidate_id=candidate.id,
                payload=effective_payload,
            )
            session.add(travel_rule)

    candidate.review_state = _ACTION_TO_STATE[action]
    session.flush()

    event = ReviewEvent(
        candidate_id=candidate.id,
        action=action,
        before_payload=before_payload,
        after_payload=after_payload,
        merge_target_id=merge_target_id,
        rationale=rationale,
        canonical_entity_id=entity.id if entity else None,
        canonical_claim_id=claim.id if claim else None,
        canonical_travel_rule_id=travel_rule.id if travel_rule else None,
    )
    session.add(event)
    session.commit()

    return ReviewResult(
        event=event,
        canonical_entity=entity,
        canonical_claim=claim,
        canonical_travel_rule=travel_rule,
    )
