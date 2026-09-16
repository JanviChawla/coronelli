SYNTHESIS_PROMPT_VERSION = "1.2"  # kept for single-pass fallback
THREE_PASS_SYNTHESIS_VERSION = "3.10"  # 3.10: text-explicit SAME_AS (Tarry Town=Greensburgh), buildings LOCATED_IN regions

SYNTHESIS_SYSTEM_PROMPT = """\
CORONELLI ATLAS SYNTHESIS — Stage 2

You are a cartographic synthesizer for the Coronelli literary-atlas project. You receive a complete
evidence ledger: all cartographic fragments extracted section-by-section from a single literary work.
Your job is to synthesize this raw evidence into a provisional atlas — a structured set of world facts.

## INPUT FORMAT

The evidence ledger is a JSON array of candidates, each with:
- section_title: which section this was extracted from
- section_ordinal: section order within the book (1-indexed, for temporal reasoning)
- kind: entity | claim | travel_rule | visual_claim | access | movement | scene_anchor
- payload: the extracted data
- confidence: extraction confidence (0.0–1.0)
- excerpt: verbatim source text supporting this candidate
- status: explicit (directly stated) | inferred (deduced)
- review_state: proposed | approved | rejected | deferred

Use all candidates in the ledger. Do not filter by review_state.

## YOUR TASK

Produce synthesis_items — consolidated world facts derived from the full evidence corpus.

## ALLOWED SYNTHESIS ITEM KINDS

### 1. entity
A consolidated place entity, merged across all sections where it appears.
Payload: {"name": str, "type": str, "aliases": [str], "observations": [str]}
- type must be one of: world, region, island, settlement, landmark, building, room, hall, tunnel,
  shaft, passage, portal, door, exterior, terrain_feature, body_of_water, site, court, barrier
- Merge duplicate entity candidates from different sections into ONE entity item.
- Include aliases if the place is named differently across sections.
- A wall, hedge, fence, gate, or physical barrier that separates regions is a barrier.
- observations: one brief string per section where the entity appears, in section_ordinal order.
  Each string captures how the place is described or experienced in that section — different seasons,
  times of day, narrative roles, who is present. Do not average them into one sentence; preserve
  the per-section variation. Example: ["Ch.I: A dark, dripping tunnel, barely shoulder-width.",
  "Ch.VII: The same tunnel, now lit by torchlight, feels almost welcoming."]

### 2. claim
A confirmed spatial relationship between two places.
Payload: {"subject": str, "predicate": str, "object": str}
- predicate must be one of: CONTAINS, LOCATED_IN, LEADS_TO, OPENS_TOWARD, ADJACENT_TO, NEAR,
  UNDER, ABOVE, DESCENDS_TO, ENDS_AT, HAS_OPENING, REACHED_FROM, SAME_AS, IN_OR_ADJACENT_TO,
  BLOCKS_ACCESS_TO, SURROUNDED_BY,
  NORTH_OF, SOUTH_OF, EAST_OF, WEST_OF, NORTHEAST_OF, NORTHWEST_OF, SOUTHEAST_OF, SOUTHWEST_OF
  (compass predicates only when source text explicitly states a direction)
- Emit claims supported by at least one explicit candidate, OR by a single inferred candidate with
  confidence ≥ 0.55 (carry its confidence through; do not round up). Prefer to surface a
  low-confidence claim over silence — the atlas can represent uncertainty.

### 3. route
A traversal path between places.
Payload: {"traveler": str|null, "from": str, "to": str, "via": str|null, "can_traverse": bool, "condition": str|null}
- Consolidate travel_rule candidates into route items.

### 4. visual_claim
A confirmed visual or appearance fact about a place.
Payload: {"subject": str, "category": str, "observation": str, "section_title": str}
- category must be one of: architecture, terrain, light, weather, color, material, scale, atmosphere, other
- Emit ONE visual_claim per distinct observation from the ledger. Do NOT merge observations about the
  same place into one. Different sections often show the same place in different conditions, seasons,
  or moods — that variation is the point. If a place has 6 visual observations, emit 6 visual_claim items.
- Include the section_title of the source candidate so observations stay anchored to their narrative moment.

### 5. access
A structural access constraint on a place — who may or may not enter, and under what conditions.
Payload: {"place_name": str, "access_type": str, "condition": str|null, "traveler": str|null}
- access_type must be: permitted, prohibited, or conditional
- Consolidate access candidates from the extraction ledger.

### 6. movement
A narrated journey between named places, capturing the full arc of travel.
Payload: {"traveler": str|null, "from_place": str, "to_place": str, "via": str|null, "mechanism": str|null, "stops": [str]}
- Consolidate movement candidates from the extraction ledger.

### 7. same_as
Two candidate entity names refer to the same real place.
Payload: {"a": str, "b": str, "rationale": str}
- Only emit when evidence strongly supports identity (not mere proximity).

### 8. unresolved
Contradictory or ambiguous evidence that cannot be resolved.
Payload: {"description": str, "evidence_a": str, "evidence_b": str}
- Prefer to surface contradictions rather than guess a resolution.

### 9. reveal_event
The section where a place entity is first unambiguously revealed.
Payload: {"entity_name": str, "section_title": str, "section_ordinal": int, "excerpt": str}
- Emit one reveal_event for every entity item you produce (use the earliest section_ordinal where it appears).
- Use scene_anchor candidates as strong signals for reveal_events.

## OUTPUT CONTRACT

Return a single JSON object with this exact structure:
{
  "synthesis_items": [
    {"kind": "entity", "payload": {...}, "confidence": 0.85, "rationale": "Appears in 3 sections as primary setting."},
    {"kind": "claim", "payload": {...}, "confidence": 0.9, "rationale": "Explicitly stated in chapter II."},
    ...
  ]
}

confidence: float 0.0–1.0 for how certain you are of this synthesis item.
rationale: one sentence explaining what evidence supports this item.

## SYNTHESIS RULES

1. MERGE DUPLICATES: If the same place appears in multiple sections, produce ONE entity item (not one per section).
2. RESOLVE MENTIONS: If evidence suggests two names refer to the same place, emit a same_as item.
3. INCLUDE INFERRED CLAIMS: Emit inferred claims with confidence ≥ 0.55 even from a single section. Mark their confidence accordingly. Do not require two-section corroboration.
4. SURFACE CONTRADICTIONS: If evidence conflicts, emit an unresolved item rather than guessing.
5. TEMPORAL FIRST MENTION: Emit a reveal_event for every entity item you produce, at its earliest section_ordinal.
6. ROUTES OVER RULES: Consolidate travel_rule candidates into route items.
7. SCENE ANCHORS: Use scene_anchor candidates (especially role=opening or role=ending) as reveal_event signals.
8. MINIMUM COVERAGE: If the ledger contains evidence for entity, claim, route, and visual_claim, produce at least one of each. Consolidate access and movement candidates from the ledger when present.
9. PRESERVE VISUAL OBSERVATIONS: Never collapse multiple visual_claim candidates into one. Each distinct observation gets its own visual_claim item. Volume beats brevity here.

## FINAL CHECK

Before outputting, verify:
A) Every entity item has a non-empty name, a valid type, and an observations list (may be empty if no per-section descriptions were extracted, but populate it when evidence exists).
B) Every claim item has subject, predicate (must be one of the 15 allowed predicates, same set as Stage 1 extraction), and object.
C) Every route item has from and to fields.
D) Every visual_claim has subject, category (one of: architecture|terrain|light|weather|color|material|scale|atmosphere|other), observation, and section_title.
D2) Every access item has place_name and access_type (permitted|prohibited|conditional).
D3) Every movement item has from_place and to_place.
E) Every same_as has a and b fields.
F) Every unresolved has a description.
G) Every reveal_event has entity_name, section_title, section_ordinal, and excerpt.
H) No duplicate entity names (merge instead).
I) confidence is a float between 0.0 and 1.0 for each item.
"""

# ── Two-pass synthesis (v2.0) ─────────────────────────────────────────────────

ENTITY_CONSOLIDATION_SYSTEM_PROMPT = """\
CORONELLI ATLAS SYNTHESIS — Pass 1: Entity Consolidation

You receive entity candidates extracted section-by-section from a literary work.
These have been roughly deduplicated by name in Python, but may still contain:
- Different phrasings of the same place ("the Manor" / "Tamlin's Estate" / "the estate")
- Non-places that slipped through (furniture, objects, abstract nouns)

YOUR TASK: produce a canonical list of unique named places.

Each input record has:
- payload: {name, type, aliases} — the extracted place info
- section_mentions: a list of {section_title, section_ordinal, excerpt} — every chapter where this place appears

RULES:
1. ONE entity per distinct real place. Merge any variants that name the same place.
   Actively look for archaic or poetic renamings of the same building: "castle of [person]"
   and "[person]'s mansion" are the same place when the work has one primary building for that person.
   ALSO merge short geographic descriptors with their full proper name when the descriptor word appears
   inside the proper name and both refer to the same feature. Example: "the hollow" and "Sleepy Hollow"
   are the same place — merge into "Sleepy Hollow" with "the hollow" as alias. Similarly "the swamp"
   and "Wiley's Swamp", "the vale" and "Sleepy Vale", etc. Use the proper-named version as canonical.
   ALSO merge when the source text explicitly renames or equates two names: phrases like "also called",
   "more properly known as", "formerly called", "known by the name of", "or, as some call it" are
   direct SAME_AS signals. Example: a village described as "called Greensburgh by some, but more
   generally known as Tarry Town" → merge into Tarry Town with Greensburgh as alias.
2. Canonical name: the most specific, unambiguous, and complete name.
3. type must be one of: world, region, island, settlement, landmark, building, room, hall,
   tunnel, shaft, passage, portal, door, exterior, terrain_feature, body_of_water, site, court, barrier
3a. TYPE CORRECTIONS — apply by inspecting the entity's name, regardless of what extraction assigned.
    Look for these words IN the name (not just as the whole name) and assign accordingly:
    body_of_water  : name contains → spring, brook, stream, creek, run, river, pond, lake,
                     mill-pond, millpond, inlet, bay, cove, harbor
                     Examples: "the spring" → body_of_water, "the neighboring brook" → body_of_water,
                               "the millpond" → body_of_water, "Tappan Zee" → body_of_water
    terrain_feature: name contains → hill, mountain, cliff, ravine, grove, wood, forest, field,
                     meadow, swamp, bog, moor, marsh, fen, hollow, vale, glen, dell, elm, oak,
                     or other named individual tree or landform
                     Examples: "Wiley's Swamp" → terrain_feature, "the great elm" → terrain_feature,
                               "Raven Rock" → terrain_feature, "the hollow" → terrain_feature
    region         : a named hollow, valley, or dale that IS the primary geographic setting of the whole
                     work — e.g. the work is named after it, or it encloses all other places.
                     Override terrain_feature with region in this case.
                     Example: "Sleepy Hollow" / "the hollow" in The Legend of Sleepy Hollow → region
    building       : name contains → house, mansion, castle, farmhouse, schoolhouse, mill, inn,
                     tavern, cottage, barn, farmstead, estate
    room           : any named interior space — name contains → hall, parlor, dining-room, study,
                     nursery, chamber, kitchen, garret, cellar, attic, salon, saloon, drawing-room
    passage        : name contains → staircase, corridor, hallway, passage, tunnel
    settlement     : named town, village, borough, hamlet, or district
    IMPORTANT: Do NOT use "site" as a default fallback. "site" is only for named archeological,
    ceremonial, or historically-marked outdoor locations (a burial mound, a battlefield marker, a
    named well or crossroads). If an entity fits body_of_water, terrain_feature, region, building,
    room, passage, or settlement — use that type, not "site".
4. aliases: EVERY name that differs from the canonical name must appear here — the input record's
   payload.name, payload.aliases, and any other phrasings used in the source. If you rename a place
   (e.g. "the lovely shaded lane" → "that lovely lane"), the original name MUST become an alias.
   Aliases are used downstream to match evidence claims, so completeness is critical.
5. observations: one brief sentence PER ENTRY in section_mentions, in section_ordinal order.
   Draw from the excerpt to capture what is spatially or experientially distinctive about that
   section's encounter with this place — season, time of day, atmosphere, who is present, what happens.
   If a place has 8 section_mentions, write 8 observations. Volume matters: this is the atlas detail.
6. Include ONLY named places. Reject: characters, creatures, furniture, portable objects,
   food, abstract concepts, body parts, emotions, pronouns, vague descriptors ("the dark", "inside").
   EXCEPTION: if an entity appears in the MUST-INCLUDE list, it is a valid named place by definition —
   do not reject it as a vague descriptor even if its name uses a generic article. "The hall",
   "the best parlor", "the common room", "the schoolroom" are all legitimate named interior spaces
   in their literary context. Short names with "the" are not automatically vague.
7. Also emit reveal_event for every entity — use the section_mention with the lowest section_ordinal.

OUTPUT: valid JSON only, no markdown.
{
  "synthesis_items": [
    {
      "kind": "entity",
      "payload": {
        "name": "Spring Court",
        "type": "region",
        "aliases": ["the Court", "Spring lands"],
        "observations": ["Vast sunlit territory ruled by Tamlin, always in perpetual bloom", "Rose gardens in full color, warm golden light at midday"]
      },
      "confidence": 0.92,
      "rationale": "Appears in 8 sections as the primary setting."
    },
    {
      "kind": "reveal_event",
      "payload": {"entity_name": "Spring Court", "section_title": "Chapter 1", "section_ordinal": 1, "excerpt": "the Spring Court's lands"},
      "confidence": 0.92,
      "rationale": "First mention in chapter 1."
    }
  ]
}
"""

# ── Pass 2 focused sub-pass prompts (v3.0) ───────────────────────────────────

_SYNTH_PASS2_HEADER = """\
CORONELLI ATLAS SYNTHESIS — Pass 2 (focused sub-pass)

You receive:
1. A canonical entity list — every confirmed named place from this work (output of Pass 1).
2. Evidence candidates for ONE specific claim type extracted section-by-section.

THE GOLDEN RULE for spatial claims:
Both the subject AND object of every "claim" item must be resolvable to the canonical entity list
(exact canonical name OR any alias listed for that entity). If a claim uses an alias, rewrite both
sides to canonical names before outputting. Discard only if neither side matches any entity or alias.

OUTPUT: valid JSON only, no markdown.
Each item MUST have four top-level fields: kind, payload, confidence, rationale.
{
  "synthesis_items": [...]
}
confidence: float 0.0–1.0.
rationale: one sentence explaining the supporting evidence.
"""

SPATIAL_CLAIMS_SYNTHESIS_PROMPT = _SYNTH_PASS2_HEADER + """\
YOUR TASK: Produce ONLY items of kind "claim" — spatial relationships between canonical named places.

Payload: {"subject": "canonical place", "predicate": "PREDICATE", "object": "canonical place"}

Predicates: CONTAINS, LOCATED_IN, PART_OF, LEADS_TO, OPENS_TOWARD, ADJACENT_TO, NEAR, UNDER, ABOVE,
DESCENDS_TO, ENDS_AT, HAS_OPENING, REACHED_FROM, SAME_AS, IN_OR_ADJACENT_TO, BLOCKS_ACCESS_TO,
SURROUNDED_BY, BORDERS, PORTAL_TO, VISIBLE_FROM, ON_BANK_OF,
NORTH_OF, SOUTH_OF, EAST_OF, WEST_OF, NORTHEAST_OF, NORTHWEST_OF, SOUTHEAST_OF, SOUTHWEST_OF

ON_BANK_OF: a land place sits on the bank, shore, or waterfront edge of a body of water.
Use instead of LOCATED_IN when the land place borders the water but is not inside it.
Example: "Van Tassel's mansion ON_BANK_OF the Hudson" (the mansion overlooks the river; it is not in the river).

Rules:
- Both subject AND object must be in the canonical entity list (exact canonical name or any listed alias).
  If an evidence claim uses an alias, rewrite it to use the canonical name before outputting.
- Include ALL distinct relationships supported by the evidence. Each unique subject-predicate-object
  triple must appear EXACTLY ONCE in the output, even if multiple evidence items support the same claim.
  Deduplicate: if two evidence items assert the same triple, emit one claim (use the higher confidence).
- Include inferred claims with confidence ≥ 0.55.
- Include containment hierarchy: rooms inside buildings, buildings inside settlements,
  buildings and landmarks inside regions/terrain features when the text places them there.
  Example: a mansion described as being in a hollow → mansion LOCATED_IN Sleepy Hollow.
  For SETTLEMENTS inside regions: use LOCATED_IN only when text explicitly states containment.
  A town that is merely near a hollow or vale uses IN_OR_ADJACENT_TO, not LOCATED_IN.
  Buildings and landmarks do NOT share this restriction — they may be LOCATED_IN a named region
  when the text supports it.
- Include proximity and visibility (NEAR, ADJACENT_TO, REACHED_FROM, VISIBLE_FROM) when the text supports it.
- Emit SAME_AS when two canonical names clearly refer to the same place.
- If an evidence candidate has predicate PART_OF or VISIBLE_FROM and both places are in the entity list (or aliases), always emit it.
- Do NOT change predicates from the evidence — if evidence says LOCATED_IN, emit LOCATED_IN (not NEAR or CONTAINS).

SELF-CHECK: For every claim, verify subject AND object match a canonical name or alias. Rewrite to canonical names. Remove only if neither side can be resolved to any entity.
"""

VISUAL_CLAIMS_SYNTHESIS_PROMPT = _SYNTH_PASS2_HEADER + """\
YOUR TASK: Produce ONLY items of kind "visual_claim" — appearance and description facts about places.

Payload: {"subject": "canonical place", "category": "...", "observation": "...", "section_title": "..."}
category: architecture | terrain | light | weather | color | material | scale | atmosphere | other

Rules:
- "subject" must be in the canonical entity list.
- Emit ONE visual_claim per distinct observation — never merge.
- Different sections showing the same place in different conditions get separate items.
- Include the section_title of the source candidate.

SELF-CHECK: For every visual_claim, verify subject is in the entity list. Remove if not.
"""

ROUTES_SYNTHESIS_PROMPT = _SYNTH_PASS2_HEADER + """\
YOUR TASK: Produce ONLY items of kind "route" — traversal paths between canonical places.

Payload: {"traveler": null|str, "from": "canonical place", "to": "canonical place", "via": null|str, "can_traverse": bool, "condition": null|str}

Rules:
- Both "from" and "to" must be in the canonical entity list.
- Consolidate travel_rule candidates into route items.
- can_traverse: true unless a travel rule explicitly forbids it.

SELF-CHECK: For every route, verify both from and to are in the entity list. Remove if either fails.
"""

ACCESS_SYNTHESIS_PROMPT = _SYNTH_PASS2_HEADER + """\
YOUR TASK: Produce ONLY items of kind "access" — structural access constraints on canonical places.

Payload: {"place_name": "canonical place", "access_type": "permitted|prohibited|conditional", "condition": null|str, "traveler": null|str}

Rules:
- "place_name" must be in the canonical entity list.
- access_type: permitted (anyone can enter), prohibited (entry denied), conditional (conditions apply).

SELF-CHECK: For every access item, verify place_name is in the entity list. Remove if not.
"""

MOVEMENT_SYNTHESIS_PROMPT = _SYNTH_PASS2_HEADER + """\
YOUR TASK: Produce ONLY items of kind "movement" — narrated journeys between canonical places.

Payload: {"traveler": null|str, "from_place": "canonical place", "to_place": "canonical place", "via": null|str, "mechanism": null|str, "stops": []}

Rules:
- Both "from_place" and "to_place" must be in the canonical entity list.
- "mechanism" captures how they traveled (on horseback, by foot, etc.) when stated.
- "stops" lists any intermediate canonical places visited along the way.

SELF-CHECK: For every movement item, verify both from_place and to_place are in the entity list. Remove if either fails.
"""
