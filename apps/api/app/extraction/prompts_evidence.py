"""
Evidence-pass prompts — extracts spatial relationships, visual claims, travel rules,
containment, and entity deduplication from section text and the place catalog.

Covers passes A, B, C, F, F2, G (spatial, visual, travelrule, containment sweep,
containment evidence, entity dedup).
"""

# ---------------------------------------------------------------------------
# Version constants
# ---------------------------------------------------------------------------

GLOBAL_EVIDENCE_VERSION             = "4.0-evidence"
GLOBAL_EVIDENCE_SPATIAL_VERSION     = "4.2-spatial"
GLOBAL_EVIDENCE_VISUAL_VERSION      = "4.1-visual"
GLOBAL_EVIDENCE_TRAVELRULE_VERSION  = "4.1-travelrule"
GLOBAL_EVIDENCE_CONTAINMENT_VERSION = "4.1-containment"
CONTAINMENT_EVIDENCE_VERSION        = "4.1-containment-evidence"
GLOBAL_EVIDENCE_DEDUP_VERSION       = "4.0-dedup"
GLOBAL_ENRICHMENT_VERSION           = "4.0-enrichment"

# ---------------------------------------------------------------------------
# Shared user templates
# ---------------------------------------------------------------------------

# Used by sub-passes A–E (text + catalog)
EVIDENCE_SUBPASS_USER_TEMPLATE = """\
WORLD ATLAS CATALOG (all known places in this book — use exact names as subject/object):
{place_catalog_json}

SECTION {section_order} — {title}

{text}

Respond with a JSON object matching the structure in the system prompt.
"""

# Used by sub-passes F–G (catalog-only, no section text)
CATALOG_ONLY_USER_TEMPLATE = """\
WORLD ATLAS CATALOG (complete place catalog for this book):
{place_catalog_json}

Respond with a JSON object matching the structure in the system prompt.
"""

# ---------------------------------------------------------------------------
# EVIDENCE PASS A — Spatial Claims
# ---------------------------------------------------------------------------

SPATIAL_CLAIMS_SYSTEM_PROMPT = """\
You are extracting spatial relationships between named places in a passage of literary fiction.

TASK
For each spatial relationship between two catalog places, emit one claim candidate.
Both subject and object MUST be exact names from the atlas catalog (or a recognized alias listed there).
Do not invent place names.

Also emit up to three scene_anchor entries per section: one for the primary setting and up to two secondary settings when the section contains multiple distinct scenes in different locations.

OUTPUT FORMAT:
{
  "candidates": [
    {
      "kind":       "claim",
      "payload":    {
        "subject":   "<exact catalog name>",
        "predicate": "<PREDICATE from list below>",
        "object":    "<exact catalog name>"
      },
      "status":     "explicit" | "inferred",
      "confidence": 0.85,
      "excerpt":    "<shortest verbatim quote supporting this relationship>",
      "rationale":  "<one sentence>"
    },
    {
      "kind":       "scene_anchor",
      "payload":    {
        "place":          "<exact catalog name>",
        "scene_role":     "primary" | "secondary",
        "narrative_role": "setting" | "arrival" | "departure" | "revelation" | "conflict"
      },
      "status":     "explicit",
      "confidence": 0.90,
      "excerpt":    "<quote>",
      "rationale":  "Primary setting for this section"
    }
  ]
}

PREDICATES  (use exact uppercase strings — there are only four)

LOCATED_IN    subject is physically inside or part of object             (room LOCATED_IN house)
LEADS_TO      subject is a traversable connection to object              (path LEADS_TO bridge)
ADJACENT_TO   subject is beside, near, or spatially related to object    (garden ADJACENT_TO house)
FLOWS_THROUGH subject (river/road/path) flows or passes through object   (river FLOWS_THROUGH valley)

CONTAINMENT RULES — read before emitting LOCATED_IN:
  - Require explicit textual evidence: the text must say or clearly imply one place is inside another.
    Narrative proximity (two places mentioned in the same paragraph) is NOT evidence of containment.
  - Physical plausibility: the container must be large enough to hold the contained thing.
    A tree, forest, hill, river, or other outdoor/natural feature cannot be LOCATED_IN a building or room.
    A building cannot be LOCATED_IN a room or furniture item.
    If the relationship would be physically absurd, use ADJACENT_TO instead.
  - When in doubt between LOCATED_IN and ADJACENT_TO, prefer ADJACENT_TO.

LEADS_TO covers any navigable connection: doors, gates, paths, stairs, passages, portals.
  Optional: add "bidirectional": true to the payload when the connection is freely traversable in
  both directions (a door, corridor, standard path). When bidirectional: true, you may omit the
  reverse claim (B LEADS_TO A) — the pipeline will infer it. Omit or set false for one-way
  connections (a waterfall descent, a river current, a one-way gate).

ADJACENT_TO covers everything else: beside, near, visible from, borders, on the bank of,
  above, below, north/south/east/west of — any spatial relationship that is not containment,
  traversal, or flowing-through.

FLOWS_THROUGH covers rivers, roads, and paths that run through or across a region or terrain feature.
  Direction: the moving element (river, road, path) is subject; the traversed region or feature is object.
  When the text says something "runs through", "passes through", or "winds through" — use FLOWS_THROUGH,
  not ADJACENT_TO.

EXTRACTION PRIORITY
  1. LOCATED_IN — only physically accurate, textually supported instances
  2. LEADS_TO — traversal edges; extract every one
  3. ADJACENT_TO — any proximity or positional relationship not covered above

RULES
  - subject must not equal object
  - Prefer explicit over inferred; mark inferred with confidence < 0.70
  - One claim per directional relationship (A LEADS_TO B and B LEADS_TO A are two separate claims,
    unless you set bidirectional: true on the LEADS_TO claim — then emit only A LEADS_TO B)
  - Compass directions only when the source text uses "north", "south", etc. — never infer from map logic

SCENE_ANCHOR RULES
  scene_role:     "primary" for the main setting of the section; "secondary" for additional locations
                  in a multi-scene section (emit at most one primary and two secondary per section)
  narrative_role: "setting"     — characters present; action or dialogue occurs here
                  "arrival"     — a place characters reach for the first time or return to
                  "departure"   — a place characters leave at a pivotal or conclusive moment
                  "revelation"  — where a discovery, twist, or key information surfaces
                  "conflict"    — site of confrontation, argument, or climactic action
"""

# ---------------------------------------------------------------------------
# EVIDENCE PASS B — Visual Claims
# ---------------------------------------------------------------------------

VISUAL_CLAIMS_SYSTEM_PROMPT = """\
You are extracting visual and atmospheric descriptions of named places in a passage of literary fiction.

TASK
For each distinct visual quality, color, material, or atmospheric observation about a catalog place, emit one visual_claim candidate. Focus on observations that give the place a distinctive appearance useful for illustration.

OUTPUT FORMAT:
{
  "candidates": [
    {
      "kind":       "visual_claim",
      "payload":    {
        "subject":       "<exact catalog place name>",
        "category":      "<category from list below>",
        "observation":   "<the description, verbatim or near-verbatim from text>",
        "palette":       [{"color": "#RRGGBB", "label": "<color name>"}],
        "section_title": "<chapter or section heading if present, else empty string>",
        "permanent":     true | false,
        "view":          "exterior" | "interior" | "unspecified"
      },
      "status":     "explicit" | "inferred",
      "confidence": 0.85,
      "excerpt":    "<supporting quote>",
      "rationale":  "<one sentence>"
    }
  ]
}

CATEGORIES
  architecture  structural form: columns, arches, towers, windows, rooflines, overall layout
  terrain       landform character: slopes, rock type, vegetation density, ground texture
  light         illumination: sunlight quality, lamplight, shadows, glow, total darkness
  weather       atmospheric conditions at or around the place
  color         named or described surface colors, tints, hues of the place itself
  material      construction or surface material: stone, wood, iron, glass, earth, fabric
  texture       surface quality: rough, smooth, weathered, mossy, gilded, crumbling, damp
  scale         size relative to characters or surrounding landscape
  atmosphere    mood and sensory impression: smell, sound, temperature, emotional feeling
  decay         ruin state, deterioration, neglect, overgrowth, staining, disrepair

PALETTE FIELD
Emit palette ONLY when category is "color" or "material" and specific colors are described or strongly implied by the material.
  - Maximum 4 entries per claim
  - Derive best-fit hex from the text's color words. Reference table:

    golden/gold        #C9A84C    silver/bright metal   #C0C0C0    crimson/deep red   #DC143C
    obsidian/jet black #1C1C1C    ivory/cream white      #FFFFF0    emerald/deep green #2D6A4F
    stone/slate grey   #8B8878    rust/weathered iron    #7B4B3A    midnight blue      #191970
    pale/sickly yellow #F5F0C4    warm amber/honey       #D97B2D    forest/pine green  #2D5A27
    blood red          #8B0000    chalk/bright white     #F5F5F0    parchment/tan      #E8D9B5
    moss/lichen green  #5A7A3A    copper/verdigris       #4A7C6F    shadow purple      #4A3060
    fog/mist grey      #D0D0C8    bark/earth brown       #6B4226    pale lavender      #C8B8D8
    yellow wallpaper   #D4B483    faded rose             #C2857A    stagnant water     #3D5C4A

Omit the palette field entirely for non-color/material categories.

RULES
  - One claim per distinct observation — do not bundle multiple observations into one candidate
  - subject must be an exact catalog name or recognized alias
  - Prefer verbatim or near-verbatim quotations over paraphrase
  - Mark "inferred" when the observation is implied rather than directly stated
  - Do not emit visual_claims for places that appear only as relationship objects with no description
  - Limit to at most 5 visual_claims per place per section. When more than 5 observations exist,
    prefer architecture, color, material, and decay (permanent = true) over weather, light,
    and atmosphere (permanent = false).

  permanent: true  — lasting, structural quality: architecture, material, terrain form, decay state
             false — transient condition: weather, current lighting, momentary atmosphere, seasonal mood
  view:  "exterior" — the place observed from outside (approaching, distant view)
         "interior" — describing the inside of the place
         "unspecified" — unclear, or not applicable (open terrain, open-air landmarks, bodies of water)
"""

# ---------------------------------------------------------------------------
# EVIDENCE PASS C — Travel Rules
# ---------------------------------------------------------------------------

TRAVELRULE_SYSTEM_PROMPT = """\
You are extracting constraints on movement between named places in a passage of literary fiction.

TASK
For each described traversal rule — a route that can or cannot be used, and under what conditions — emit one travel_rule candidate.

OUTPUT FORMAT:
{
  "candidates": [
    {
      "kind":       "travel_rule",
      "payload":    {
        "route":          "<catalog place A> -> <catalog place B>",
        "can_traverse":   true | false,
        "bidirectional":  true | false,
        "conditions":     "<what makes this rule apply; empty string if unconditional>",
        "transport_mode": "on foot | on horseback | by boat | by carriage | by air | unspecified",
        "notes":          "<any additional context>"
      },
      "status":     "explicit" | "inferred",
      "confidence": 0.80,
      "excerpt":    "<supporting quote>",
      "rationale":  "<one sentence>"
    }
  ]
}

Focus on:
  - Routes described as impassable, dangerous, flooded, blocked, or forbidden
  - Conditions that affect traversability: time of day, season, character state, equipment, identity
  - One-way passages: a staircase only going down, a river current, a gate that opens in one direction
  - Shortcuts or alternate routes explicitly described
  - Warnings given to characters about particular paths

Both place names in the route must be exact catalog names.
Do NOT emit travel_rule candidates for ordinary movement — those belong in the Movement pass (D).
Return {"candidates": []} if no traversal constraints appear in this section.
"""

# ---------------------------------------------------------------------------
# EVIDENCE PASS F — Containment Sweep (catalog-only)
# ---------------------------------------------------------------------------

CONTAINMENT_SWEEP_SYSTEM_PROMPT = """\
You are building a containment hierarchy for a literary atlas. Given a complete place catalog, \
emit a CONTAINS claim for every pair of places where one is physically inside the other.

SPATIAL LEVEL GUIDE
  L0 = realm / landscape  (country, forest, coastline)
  L1 = territory / locale (estate, village, district)
  L2 = place / structure  (house, building, garden, courtyard)
  L3 = feature / sub-space (room, corridor, staircase, window, cellar, attic, threshold)

CONTAINMENT LOGIC — apply in order:
  1. SPATIAL LEVEL: A lower-level place almost always contains higher-level ones at the same site.
     A L1 estate CONTAINS its L2 buildings and gardens; a L2 house CONTAINS its L3 rooms and features.
     Emit claims for ALL such pairs that share an obvious site (same book location).
  2. PLACE TYPE: Use type/kind_descriptor to infer containment when spatial_level alone is ambiguous.
     Rooms, corridors, staircases, cellars, attics, thresholds are inside their parent building.
     Gardens, courtyards, walls, gates are inside their parent estate or grounds.
  3. TIER: Use tier (surface / aerial / underground / aquatic) only as a secondary confirmation signal.

Be conservative: only emit claims you are genuinely confident about (confidence 0.85+).
A wrong containment claim corrupts the spatial hierarchy for every viewer — an absent claim
is always safer than an incorrect one. When the containment relationship is not clear from the
names and types alone, skip the pair rather than guessing.

OUTPUT FORMAT:
{
  "candidates": [
    {
      "kind":       "claim",
      "payload":    {
        "subject":   "<container place — exact catalog name>",
        "predicate": "CONTAINS",
        "object":    "<contained place — exact catalog name>"
      },
      "status":     "inferred",
      "confidence": 0.85,
      "excerpt":    "",
      "rationale":  "<one sentence>"
    }
  ]
}

Rules:
  - subject and object must be exact names from the catalog
  - subject spatial_level must be < object spatial_level (container has lower number)
  - Do NOT emit a claim where you cannot identify a clear container
  - Do NOT emit CONTAINS between two places at the same spatial_level unless one is a named sub-area
    of the other (e.g. "the garden" CONTAINS "the rose bed")
  - Every L3 feature should have exactly one L2 or L1 parent; every L2 structure should have at most one L1 parent

Return {"candidates": []} only if the catalog has fewer than two places or no containment is evident.
"""

# ---------------------------------------------------------------------------
# EVIDENCE PASS F2 — Per-section containment extraction (reads text)
# ---------------------------------------------------------------------------

CONTAINMENT_EVIDENCE_SYSTEM_PROMPT = """\
You are extracting spatial containment relationships from a passage of literary fiction.

TASK
Read the section carefully. For every place that the text positions INSIDE, WITHIN, or AS PART OF another catalog place, emit one containment claim.

CONTAINMENT PREDICATE:
  LOCATED_IN — subject is physically inside or part of the object
               ("she was in the nursery of the old house" → nursery LOCATED_IN house)
               ("the house contained a nursery" → nursery LOCATED_IN house)
               ("the west wing of the mansion" → west wing LOCATED_IN mansion)

Both subject and object MUST be exact names from the World Atlas Catalog.

OUTPUT FORMAT:
{
  "candidates": [
    {
      "kind":       "claim",
      "payload":    {
        "subject":   "<exact catalog name>",
        "predicate": "LOCATED_IN",
        "object":    "<exact catalog name>"
      },
      "status":     "explicit",
      "confidence": 0.9,
      "excerpt":    "<the phrase that expresses the containment>",
      "rationale":  "<one sentence>"
    }
  ]
}

Rules:
  - Use "explicit" when the text directly states the relationship; "inferred" when strongly implied
  - Emit at most one claim per ordered pair
  - Only use place names from the World Atlas Catalog — do not invent names
  - VISIBILITY IS NOT CONTAINMENT: a place seen, glimpsed, or described through a window,
    door, or from a vantage point is NOT inside the viewing location. Do not emit a
    containment claim for "the bay/garden/lane/wharf seen from the nursery window" —
    that is a spatial view relationship, not containment. Reserve those for step 4.
  - Only emit containment when the text physically places one place INSIDE or AS PART OF another
  - If no containment is expressed in this section, return {"candidates": []}
"""

# ---------------------------------------------------------------------------
# EVIDENCE PASS G — Entity Deduplication (catalog-only)
# ---------------------------------------------------------------------------

ENTITY_DEDUP_SYSTEM_PROMPT = """\
You are reviewing a complete world atlas catalog to identify duplicate place entries — different names for the same physical location.

TASK
Examine the catalog and identify any two entries that refer to the same place. Emit one SAME_AS claim per pair.

OUTPUT FORMAT:
{
  "candidates": [
    {
      "kind":       "claim",
      "payload":    {
        "subject":   "<primary / more complete name>",
        "predicate": "SAME_AS",
        "object":    "<alias / informal or shorter variant>"
      },
      "status":     "inferred",
      "confidence": 0.85,
      "excerpt":    "",
      "rationale":  "<one sentence explaining why these are the same place>"
    }
  ]
}

Rules:
  - subject is the more canonical or complete name; object is the alias or informal variant
  - Only emit SAME_AS when you are confident the two entries are the same physical place
  - Do NOT emit SAME_AS for places that are merely nearby, related, or similarly named
  - Confidence must be ≥ 0.80 for any SAME_AS claim
  - Common duplicate patterns to look for:
      * Formal vs. colloquial name ("Thornfield Hall" / "the hall")
      * Full name vs. shortened form ("the colonial mansion" / "the house")
      * Descriptive epithet vs. generic reference at the same spatial level and kind
        — e.g. if both are L2 buildings of the same place_kind, one entry is probably
        a more vivid description of the other
      * Generic room reference vs. named room ("the room" / "the nursery") when
        both are L3 features of the same kind and no other room by that generic
        name appears in the catalog
      * English name vs. translated name
      * Building name vs. owner-possessive reference

Return {"candidates": []} if no duplicates are evident.
"""
