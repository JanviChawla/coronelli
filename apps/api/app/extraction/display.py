def candidate_display_summary(kind: str, payload: dict) -> str:
    """Deterministic, human-readable one-line summary of a candidate.

    Used as a computed property on Candidate and on API response models.
    Never delegates to the LLM. Never returns an empty string.
    """
    def _s(key: str) -> str:
        return (payload.get(key) or "").strip()

    if kind == "entity":
        name = _s("name")
        place_kind = _s("type")
        return f"{name} ({place_kind})" if (name and place_kind) else name or f"(unnamed {place_kind or 'entity'})"

    if kind == "claim":
        subject = _s("subject")
        predicate = _s("predicate")
        obj = _s("object")
        if subject and predicate and obj:
            return f"{subject} {predicate} {obj}"
        parts = [x for x in [subject, predicate, obj] if x]
        return " ".join(parts) if parts else "(incomplete claim)"

    if kind == "travel_rule":
        traveler = _s("traveler")
        route = _s("route")
        if traveler and route:
            return f"{traveler}: {route}"
        return route or traveler or "(unnamed route)"

    if kind == "visual_claim":
        subject = _s("subject")
        prop = _s("visual_property")
        value = _s("value")
        if subject and prop and value:
            return f"{subject} · {prop}: {value}"
        parts = [x for x in [subject, prop, value] if x]
        return " · ".join(parts) if parts else "(incomplete visual claim)"

    if kind == "scene_anchor":
        place = _s("place")
        role = _s("scene_role")
        role_display = role.capitalize() if role else ""
        if role_display and place:
            return f"{role_display} scene · {place}"
        return place or "(unresolved scene)"

    return f"({kind})"
