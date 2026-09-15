def synthesis_item_display_summary(kind: str, payload: dict) -> str:
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
    if kind == "route":
        frm = _s("from")
        to = _s("to")
        traveler = _s("traveler")
        route_str = f"{frm} → {to}" if (frm and to) else frm or to or "(unknown route)"
        return f"{traveler}: {route_str}" if traveler else route_str
    if kind == "visual_claim":
        subject = _s("subject")
        # Support both new (category/observation) and legacy (visual_property/value) fields
        prop = _s("category") or _s("visual_property")
        value = _s("observation") or _s("value")
        if subject and prop and value:
            return f"{subject} · {prop}: {value}"
        parts = [x for x in [subject, prop, value] if x]
        return " · ".join(parts) if parts else "(incomplete visual claim)"
    if kind == "access":
        place = _s("place_name")
        access_type = _s("access_type")
        traveler = _s("traveler")
        condition = _s("condition")
        base = f"{place}: {access_type}" if (place and access_type) else place or access_type or "(access)"
        if traveler:
            base = f"{traveler} → {base}"
        if condition:
            base = f"{base} ({condition})"
        return base
    if kind == "movement":
        traveler = _s("traveler")
        frm = _s("from_place")
        to = _s("to_place")
        via = _s("via")
        route = f"{frm} → {to}" if (frm and to) else frm or to or "(unknown route)"
        if via:
            route = f"{frm} → {via} → {to}"
        return f"{traveler}: {route}" if traveler else route
    if kind == "same_as":
        a = _s("a")
        b = _s("b")
        if a and b:
            return f"{a} = {b}"
        return a or b or "(unknown identity)"
    if kind == "unresolved":
        desc = _s("description")
        return f"(unresolved) {desc[:80]}" if desc else "(unresolved)"
    if kind == "reveal_event":
        entity = _s("entity_name")
        section = _s("section_title")
        if entity and section:
            return f"{entity} first seen in {section}"
        return entity or "(unnamed reveal)"
    return f"({kind})"
