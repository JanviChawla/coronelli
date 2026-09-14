from .models import ValidationIssue

_PORTAL_KINDS = frozenset({
    "fixed-portal",
    "temporary-portal",
    "directed-magical-transition",
    "frame-transition",
    "flight-transition",
    "water-journey",
    "special-air-transit",
    "narrative-journey",
})


def validate_semantics(package: dict) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []

    sources = package.get("sources", [])
    world = package.get("world", {})
    layouts = package.get("layouts", [])
    interpretations = package.get("interpretations", [])

    # Build lookup maps
    valid_sections: dict[str, set[str]] = {
        src["id"]: {sec["id"] for sec in src.get("sections", [])}
        for src in sources
    }
    entity_ids = {e["id"] for e in world.get("entities", [])}
    travel_rule_ids = {r["id"] for r in world.get("travelRules", [])}
    travel_rule_kind: dict[str, str] = {
        r["id"]: r["travelKind"] for r in world.get("travelRules", [])
    }

    interpretation_applies: set[str] = {
        interp["appliesToRef"] for interp in interpretations
    }

    def _check_discovery(discovery: dict, path: str) -> None:
        loc = discovery.get("becomesVisibleAt", {})
        doc_id = loc.get("documentId", "")
        sec_id = loc.get("sectionId", "")
        if doc_id not in valid_sections:
            issues.append(ValidationIssue(
                code="INVALID_DISCOVERY_REF",
                path=path,
                message=f"Discovery documentId '{doc_id}' not found in sources.",
            ))
        elif sec_id not in valid_sections[doc_id]:
            issues.append(ValidationIssue(
                code="INVALID_DISCOVERY_REF",
                path=path,
                message=f"Discovery sectionId '{sec_id}' not found in document '{doc_id}'.",
            ))

    # Validate entity discovery refs
    for i, entity in enumerate(world.get("entities", [])):
        if "discovery" in entity:
            _check_discovery(entity["discovery"], f"/world/entities/{i}/discovery")

        # Check mobile layout-anchor-allowed requires an interpretation
        behavior = entity.get("mapBehavior", {})
        if (
            behavior.get("mobility") == "mobile"
            and behavior.get("coordinatePolicy") == "layout-anchor-allowed"
        ):
            # Find layout elements referencing this entity
            referencing_elements = [
                elem["id"]
                for layout in layouts
                for elem in layout.get("elements", [])
                if elem.get("entityRef") == entity["id"]
            ]
            if not any(eid in interpretation_applies for eid in referencing_elements):
                issues.append(ValidationIssue(
                    code="MOBILE_ANCHOR_REQUIRES_INTERPRETATION",
                    path=f"/world/entities/{i}",
                    message=(
                        f"Mobile entity '{entity['id']}' uses 'layout-anchor-allowed' "
                        "but no interpretation record references its layout element(s)."
                    ),
                ))

    # Validate travel rule discovery refs
    for i, rule in enumerate(world.get("travelRules", [])):
        if "discovery" in rule:
            _check_discovery(rule["discovery"], f"/world/travelRules/{i}/discovery")

    # Validate layout elements
    for li, layout in enumerate(layouts):
        for ei, element in enumerate(layout.get("elements", [])):
            elem_path = f"/layouts/{li}/elements/{ei}"

            # Discovery ref check
            if "discovery" in element:
                _check_discovery(element["discovery"], f"{elem_path}/discovery")

            # entityRef must resolve
            if "entityRef" in element and element["entityRef"] not in entity_ids:
                issues.append(ValidationIssue(
                    code="DANGLING_REF",
                    path=f"{elem_path}/entityRef",
                    message=f"entityRef '{element['entityRef']}' does not match any world entity.",
                ))

            # travelRuleRef must resolve
            if "travelRuleRef" in element:
                rule_ref = element["travelRuleRef"]
                if rule_ref not in travel_rule_ids:
                    issues.append(ValidationIssue(
                        code="DANGLING_REF",
                        path=f"{elem_path}/travelRuleRef",
                        message=f"travelRuleRef '{rule_ref}' does not match any travel rule.",
                    ))
                elif (
                    travel_rule_kind.get(rule_ref) in _PORTAL_KINDS
                    and element.get("kind") == "stated-road"
                ):
                    issues.append(ValidationIssue(
                        code="PORTAL_STYLED_AS_ROAD",
                        path=f"{elem_path}/kind",
                        message=(
                            f"Travel rule '{rule_ref}' is a portal/non-road type "
                            "but layout element kind is 'stated-road'."
                        ),
                    ))

    # Validate claim refs
    for i, claim in enumerate(world.get("claims", [])):
        if claim.get("subjectRef") not in entity_ids:
            issues.append(ValidationIssue(
                code="DANGLING_REF",
                path=f"/world/claims/{i}/subjectRef",
                message=f"subjectRef '{claim.get('subjectRef')}' does not match any entity.",
            ))
        for obj_ref in claim.get("objectRefs", []):
            if obj_ref not in entity_ids:
                issues.append(ValidationIssue(
                    code="DANGLING_REF",
                    path=f"/world/claims/{i}/objectRefs",
                    message=f"objectRef '{obj_ref}' does not match any entity.",
                ))

    return issues
