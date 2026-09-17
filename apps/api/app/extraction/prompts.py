"""
Coronelli extraction prompt library — v4.0

Pipeline architecture:
  1. CATALOG PASS  (per section, sequential within a book)
       Reads section text → emits every named place with full atlas metadata
       Output: places[] with name, type, kind_descriptor, tier, spatial_level, aliases

  2. EVIDENCE PASSES  (per section, 7 sub-passes in parallel)
       A — Spatial Claims:     subject / predicate / object spatial relationships
       B — Visual Claims:      visual and atmospheric observations + structured palette
       C — Travel Rules:       traversal constraints and conditions
       D — Movement Events:    character movements between places
       E — Access Rules:       permitted / prohibited / conditional access
       F — Containment Sweep:  global catalog → any missed CONTAINS claims (catalog-only)
       G — Entity Dedup:       global catalog → SAME_AS alias resolution (catalog-only)

  Version scheme: MAJOR.MINOR-pass
    Bump MAJOR on breaking schema changes (new required field, removed field).
    Bump MINOR on prompt text changes that alter output distribution.
"""

# ---------------------------------------------------------------------------
# Version constants — bump to invalidate the extraction cache
# ---------------------------------------------------------------------------

GLOBAL_CATALOG_VERSION           = "4.0-catalog"
GLOBAL_CATALOG_GAP_VERSION       = "4.0-catalog-gap"
GLOBAL_EVIDENCE_VERSION          = "4.0-evidence"

GLOBAL_EVIDENCE_SPATIAL_VERSION     = "4.0-spatial"
GLOBAL_EVIDENCE_VISUAL_VERSION      = "4.0-visual"
GLOBAL_EVIDENCE_TRAVELRULE_VERSION  = "4.0-travelrule"
GLOBAL_EVIDENCE_MOVEMENT_VERSION    = "4.0-movement"
GLOBAL_EVIDENCE_ACCESS_VERSION      = "4.0-access"
GLOBAL_EVIDENCE_CONTAINMENT_VERSION = "4.0-containment"
GLOBAL_EVIDENCE_DEDUP_VERSION       = "4.0-dedup"

COMBINED_PROMPT_VERSION = f"{GLOBAL_CATALOG_VERSION}+{GLOBAL_EVIDENCE_VERSION}"

# Legacy alias — kept so the service cache-key comparison doesn't break on import
PROMPT_VERSION = COMBINED_PROMPT_VERSION


# ---------------------------------------------------------------------------
# Shared taxonomy blocks — embedded into system prompts at module load time
# ---------------------------------------------------------------------------

_ENTITY_TYPE_BLOCK = """\
ENTITY TYPE  (choose exactly one — pick the most specific match)
  world            entire fictional world, planet, or named cosmos
  region           realm, kingdom, territory, country, continent, named wilderness expanse
  island           island, peninsula, or isolated landmass (even if sparsely populated)
  district         named neighborhood, quarter, ward, or borough inside a settlement
  settlement       town, village, city, hamlet, colony — any inhabited populated place
  building         manor, house, inn, shop, castle, palace, abbey — the whole named structure
  hall             great hall, throne room, assembly chamber — enclosed named civic interior
  room             room, chamber, cabin, cell, alcove, garret — named interior subdivision
  grounds          garden, courtyard, yard, square, plaza, training ground — open managed outdoor space
  landmark         statue, monument, bridge, fountain, ruin — singular named structure without interior
  terrain_feature  mountain, hill, cliff, forest, grove, field, bog, moor — natural landform or vegetation
  body_of_water    river, lake, sea, ocean, bay, harbor, brook, pond
  vessel           ship, boat, carriage, wagon, airship — any conveyance used as a named place
  tunnel           tunnel, mine shaft, underground passage bored through earth
  passage          corridor, hallway, alleyway, road, staircase — connector between places
  portal           door, gate, arch, threshold — an opening rather than a path or enclosure
  site             battlefield, excavation, named clearing, or ruin without surviving structure
  court            enclosed formal court (legal, royal); use 'grounds' for open courtyards
  barrier          named wall, fence, or fortification treated as a location"""

_KIND_DESCRIPTOR_BLOCK = """\
KIND DESCRIPTOR  (drives 3-D geometry in the world atlas — choose the single best match)
  tower      named towers, spires, keeps, minarets, belfries, watchtowers
  hall       great halls, throne rooms, assembly chambers, named enclosed civic interiors
  settlement towns, villages, cities, districts, colonies — inhabited populated places
  region     realms, kingdoms, territories, continents, worlds, broad uninhabited wilderness
  forest     forests, woods, groves, jungles — named arboreal or dense-vegetation areas
  water      lakes, rivers, seas, bays, harbors, bogs — any body of water
  portal     doors, gates, arches, thresholds — openings rather than enclosures or paths
  mountain   mountains, peaks, hills, ridges, cliffs — elevated rocky natural landforms
  vessel     ships, boats, carriages, airships — conveyances treated as places
  dungeon    prisons, dungeons, vaults, holding cells — places of confinement
  room       rooms, chambers, cabins, alcoves — interior subdivisions of a structure
  landmark   statues, monuments, bridges, fountains, named ruins — singular structures
  grounds    gardens, courtyards, squares, yards, plazas — open managed outdoor areas
  building   manors, houses, inns, shops, palaces, castles — whole named structures
  route      roads, paths, tunnels, corridors, passages, staircases — traversal connectors

  Disambiguation notes:
  - A "gate" is a portal. The "gate district" is a settlement. The "gatehouse" is a building.
  - Forests and mountains are terrain; the house *in* the forest is a building.
  - A bridge is a landmark (structure); the road *over* the bridge is a route.
  - An island is usually region or settlement depending on whether it hosts a population.
  - A staircase or corridor is a route; a landing or gallery is a room."""

_TIER_BLOCK = """\
TIER  (vertical elevation in the world — completely separate from spatial_level)
  peak         mountain summits, treetop platforms, tower tops, anything explicitly the highest point
  elevated     upper floors, ramparts, hilltop structures, clifftop buildings — above ground but not a peak
  surface      ground-level default: streets, most rooms when floor unspecified, courtyards, ground floors
  underground  cellars, caves, mine tunnels, sewers — explicitly below ground
  deep         deep mines, underworlds, sub-basement levels — described at great depth underground

  Assignment rules:
  - When tier is ambiguous → surface
  - Vertical connectors (stairs, shafts, tunnels between levels) → tier of their LOWER end
  - "Upper floor", "above stairs", "attic" → elevated
  - "Cellar", "beneath the house", "underground passage" → underground
  - "Top of the tower", "summit" → peak"""

_SPATIAL_LEVEL_BLOCK = """\
SPATIAL LEVEL  (geographic scale hierarchy — NOT elevation; integer 0-3)
  0  realm     entire world, continent, or named cosmic expanse
  1  territory kingdom, country, named wilderness region, large island
  2  place     town, building, lake, forest, mountain, ship (most places are level 2)
  3  feature   room, door, fountain, staircase, specific tree, named corner of a room"""


# ---------------------------------------------------------------------------
# CATALOG PASS — system prompt
# ---------------------------------------------------------------------------

CATALOG_SYSTEM_PROMPT = f"""\
You are a cartographic intelligence extracting every distinct named place from a passage of literary fiction, for inclusion in a world atlas.

TASK
Read the passage and identify every PLACE — any named location, space, or geographic feature where events occur or which characters reference spatially. Include places that are described but not visited, places mentioned in dialogue, and background geography.

DO NOT include:
  - People, characters, animals, or organizations
  - Abstract concepts, time periods, events, or emotions
  - Objects that are not themselves places (a key is not a portal; a named gate IS a place)
  - Bare possessives with no following place noun: "Van Tassel's" alone is not a place;
    "Van Tassel's barn" IS a place (the barn belongs to Van Tassel)

OUTPUT FORMAT — respond with exactly this JSON structure, no other keys:
{{
  "places": [
    {{
      "name":            "<canonical place name as written in the text>",
      "type":            "<entity type — from list below>",
      "kind_descriptor": "<atlas geometry kind — from list below>",
      "tier":            "<vertical elevation — from list below>",
      "spatial_level":   <integer 0-3>,
      "aliases":         ["<alternate name used for this place in THIS section>"],
      "is_new":          true,
      "confidence":      0.85,
      "excerpt":         "<shortest verbatim quote that names or describes this place>"
    }}
  ]
}}

  name:            Use the most complete, canonical form used in the text.
  aliases:         Other names the text uses for the SAME place in this section. Empty list [] if none.
  is_new:          true if this place is NOT already in the known_places list.
                   false if it appears there (still emit it so aliases are captured).
  confidence:      Your certainty 0.0–1.0 that this is a real place in the story world.
  excerpt:         Copy the SHORTEST quote that introduces or names the place.

{_ENTITY_TYPE_BLOCK}

{_KIND_DESCRIPTOR_BLOCK}

{_TIER_BLOCK}

{_SPATIAL_LEVEL_BLOCK}

WORKED EXAMPLES

  "The old colonial mansion" (The Yellow Wallpaper)
    → type: building  kind_descriptor: building  tier: surface   spatial_level: 2

  "The nursery at the top of the house" (The Yellow Wallpaper)
    → type: room      kind_descriptor: room       tier: elevated  spatial_level: 3

  "The barred windows" (The Yellow Wallpaper)
    → type: portal    kind_descriptor: portal     tier: elevated  spatial_level: 3

  "The garden" with its hedge-lined walks (The Yellow Wallpaper)
    → type: grounds   kind_descriptor: grounds    tier: surface   spatial_level: 3

  "Sleepy Hollow" (The Legend of Sleepy Hollow)
    → type: region    kind_descriptor: region     tier: surface   spatial_level: 1

  "The old Dutch church" (The Legend of Sleepy Hollow)
    → type: building  kind_descriptor: building   tier: surface   spatial_level: 2

  "The old Dutch burying-ground" (The Legend of Sleepy Hollow)
    → type: grounds   kind_descriptor: grounds    tier: surface   spatial_level: 2

  "The wooden bridge" (The Legend of Sleepy Hollow)
    → type: landmark  kind_descriptor: landmark   tier: surface   spatial_level: 3

  "The Catskill Mountains" (The Legend of Sleepy Hollow)
    → type: terrain_feature  kind_descriptor: mountain  tier: peak  spatial_level: 1

  "The Hudson River" (The Legend of Sleepy Hollow)
    → type: body_of_water  kind_descriptor: water  tier: surface  spatial_level: 1\
"""

# ---------------------------------------------------------------------------
# CATALOG PASS — user template
# ---------------------------------------------------------------------------

CATALOG_USER_TEMPLATE = """\
KNOWN PLACES (already in the atlas — set is_new: false for any of these; \
still emit them if they appear under a new alias in this section):
{known_names_json}

SECTION {section_order} — {title}

{text}
"""

# ---------------------------------------------------------------------------
# CATALOG GAP PASS — finds places missed in the first catalog read
# ---------------------------------------------------------------------------

CATALOG_GAP_SYSTEM_PROMPT = f"""\
You are reviewing a passage of literary fiction to find any named places that were MISSED in the first catalog pass.

A first read already identified the places in the already_found list. Your job is to find what was overlooked:
  - Generic references that are distinct places ("the room upstairs", "the hall below")
  - Places implied by movement events but never directly named
  - Background geography mentioned in passing or in dialogue
  - Nested sub-locations inside already-cataloged places
  - Places mentioned only once in a subordinate clause

OUTPUT FORMAT — identical to the catalog pass:
{{
  "places": [
    {{
      "name":            "<place name>",
      "type":            "<entity type>",
      "kind_descriptor": "<atlas geometry kind>",
      "tier":            "<vertical elevation>",
      "spatial_level":   <integer 0-3>,
      "aliases":         [],
      "is_new":          true,
      "confidence":      0.75,
      "excerpt":         "<supporting quote>"
    }}
  ]
}}

Only emit places NOT in the already_found list.
Return {{"places": []}} if nothing was missed.

{_ENTITY_TYPE_BLOCK}

{_KIND_DESCRIPTOR_BLOCK}

{_TIER_BLOCK}

{_SPATIAL_LEVEL_BLOCK}\
"""

CATALOG_GAP_USER_TEMPLATE = """\
ALREADY FOUND in this section (do not re-emit these):
{already_found_json}

SECTION {section_order} — {title}

{text}
"""

# ---------------------------------------------------------------------------
# EVIDENCE PASS — shared user templates
# ---------------------------------------------------------------------------

# Used by sub-passes A–E (text + catalog)
EVIDENCE_SUBPASS_USER_TEMPLATE = """\
WORLD ATLAS CATALOG (all known places in this book — use exact names as subject/object):
{place_catalog_json}

SECTION {section_order} — {title}

{text}
"""

# Used by sub-passes F–G (catalog-only, no section text)
CATALOG_ONLY_USER_TEMPLATE = """\
WORLD ATLAS CATALOG (complete place catalog for this book):
{place_catalog_json}
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

Also emit one scene_anchor per section for the primary setting place (where most action occurs).

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
        "place":      "<exact catalog name>",
        "scene_role": "primary"
      },
      "status":     "explicit",
      "confidence": 0.90,
      "excerpt":    "<quote>",
      "rationale":  "Primary setting for this section"
    }
  ]
}

PREDICATES  (use exact uppercase strings)

CONTAINMENT — highest priority; extract every instance
  CONTAINS          subject physically encloses object             (house CONTAINS room)
  LOCATED_IN        object is the broader container                (room LOCATED_IN house)
  PART_OF           object is a structural component of subject    (tower PART_OF castle)
  SURROUNDED_BY     subject is enclosed on all sides by object

CONNECTIONS — highest priority; these form traversal edges in the atlas
  LEADS_TO          subject connects to or opens into object       (path LEADS_TO bridge)
  PORTAL_TO         subject is a door/gate/arch giving access      (gate PORTAL_TO courtyard)
  DESCENDS_TO       subject leads downward to object               (staircase DESCENDS_TO cellar)
  ENDS_AT           subject terminates at object                   (road ENDS_AT village)
  OPENS_TOWARD      subject has an opening facing object           (window OPENS_TOWARD garden)
  HAS_OPENING       subject has an aperture leading to object
  BLOCKS_ACCESS_TO  subject prevents passage to object             (gate BLOCKS_ACCESS_TO manor)

RELATIVE POSITION
  ADJACENT_TO       directly beside, sharing a wall or edge
  NEAR              in the vicinity, a short walk or ride
  ABOVE             directly above                                  (balcony ABOVE courtyard)
  UNDER             directly below                                  (cellar UNDER house)
  IN_OR_ADJACENT_TO inside or immediately beside — use ONLY when genuinely ambiguous
  VISIBLE_FROM      can be seen from subject                       (tower VISIBLE_FROM road)
  ON_BANK_OF        subject is on the shore or bank of object      (town ON_BANK_OF river)
  FLOWS_THROUGH     subject flows through or traverses object      (river FLOWS_THROUGH valley)
  BORDERS           shares a boundary with                         (forest BORDERS road)

COMPASS  — only when the text EXPLICITLY states a cardinal direction
  NORTH_OF  SOUTH_OF  EAST_OF  WEST_OF
  NORTHEAST_OF  NORTHWEST_OF  SOUTHEAST_OF  SOUTHWEST_OF

TRAVEL
  REACHED_FROM      subject is accessed starting from object

IDENTITY — dedup only; use sparingly
  SAME_AS           subject and object are the same place under different names

EXTRACTION PRIORITY
  1. CONTAINS / LOCATED_IN — hull edges; extract every one
  2. LEADS_TO / PORTAL_TO / DESCENDS_TO — traversal edges; extract every one
  3. PART_OF / SURROUNDED_BY / ENDS_AT
  4. Relative position predicates
  5. SAME_AS last — only for confirmed aliases, confidence ≥ 0.80

RULES
  - subject must not equal object
  - Prefer explicit over inferred; mark inferred with confidence < 0.70
  - One claim per directional relationship (A LEADS_TO B and B LEADS_TO A are two separate claims)
  - Compass directions only when the source text uses "north", "south", etc. — never infer from map logic
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
        "section_title": "<chapter or section heading if present, else empty string>"
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
# EVIDENCE PASS D — Movement Events
# ---------------------------------------------------------------------------

MOVEMENT_SYSTEM_PROMPT = """\
You are extracting character movement events between named places in a passage of literary fiction.

TASK
For each instance where a named character physically moves from one catalog place to another, emit one movement candidate.

OUTPUT FORMAT:
{
  "candidates": [
    {
      "kind":       "movement",
      "payload":    {
        "from_place":     "<catalog place name, or null if the origin is unknown>",
        "to_place":       "<catalog place name>",
        "character":      "<character name, or 'narrator' for first-person narrators>",
        "direction":      "approach | depart | traverse | ascend | descend | enter | exit",
        "transport_mode": "on foot | on horseback | by boat | by carriage | by air | unspecified",
        "notes":          "<any qualitative detail about the journey>"
      },
      "status":     "explicit" | "inferred",
      "confidence": 0.85,
      "excerpt":    "<supporting quote>",
      "rationale":  "<one sentence>"
    }
  ]
}

Rules:
  - Only emit when the text describes an ACTUAL traversal event — a character physically moves
  - Do NOT emit when a place is merely mentioned, observed from a distance, or discussed in dialogue
  - Both from_place and to_place (when known) must be exact catalog names
  - A journey A → B → C produces TWO movement candidates: A→B and B→C
  - "narrator" is the character name for first-person "I" narrators
  - ascend/descend for vertical movement between tiers; enter/exit for crossing a threshold
  - Use direction "traverse" when a character passes through without stopping

Return {"candidates": []} if no movement events appear in this section.
"""

# ---------------------------------------------------------------------------
# EVIDENCE PASS E — Access Rules
# ---------------------------------------------------------------------------

ACCESS_SYSTEM_PROMPT = """\
You are extracting access rules — who may or may not enter a place, and under what conditions — from a passage of literary fiction.

TASK
For each stated or clearly implied restriction governing who may enter a catalog place, emit one access candidate.

OUTPUT FORMAT:
{
  "candidates": [
    {
      "kind":       "access",
      "payload":    {
        "place_name":  "<exact catalog place name>",
        "access_type": "permitted | prohibited | conditional",
        "who":         "<which characters or character class; use 'all' if universal>",
        "conditions":  "<what must be true for the rule to apply; empty string if unconditional>",
        "notes":       "<additional context>"
      },
      "status":     "explicit" | "inferred",
      "confidence": 0.80,
      "excerpt":    "<supporting quote>",
      "rationale":  "<one sentence>"
    }
  ]
}

access_type:
  permitted    — explicitly allowed, welcomed, or open to the specified who
  prohibited   — explicitly forbidden, locked against, or blocked
  conditional  — allowed only under specific conditions (time, identity, ritual, key, escort)

Rules:
  - place_name must be an exact catalog name or alias
  - Only emit when the text actually states or strongly implies an access restriction
  - Do not emit access candidates for ordinary movement without restriction — those go in pass D
  - Restrictions that apply only to one named character are still worth capturing

Return {"candidates": []} if no access rules appear in this section.
"""

# ---------------------------------------------------------------------------
# EVIDENCE PASS F — Containment Sweep (catalog-only)
# ---------------------------------------------------------------------------

CONTAINMENT_SWEEP_SYSTEM_PROMPT = """\
You are reviewing a complete world atlas catalog to find containment relationships that may have been missed during per-section extraction.

TASK
Examine every place in the catalog. For each place that is clearly contained inside another catalog place — based on names, types, and spatial_levels — emit a CONTAINS claim.

Only use what is evident from the catalog data itself. Do not invent relationships.

OUTPUT FORMAT:
{
  "candidates": [
    {
      "kind":       "claim",
      "payload":    {
        "subject":   "<container place name>",
        "predicate": "CONTAINS",
        "object":    "<contained place name>"
      },
      "status":     "inferred",
      "confidence": 0.80,
      "excerpt":    "",
      "rationale":  "<one sentence explaining why the subject contains the object>"
    }
  ]
}

Rules:
  - subject and object must be exact catalog names
  - spatial_level of object must be >= spatial_level of subject (a feature lives inside a place)
  - Focus on cases where the name reveals containment ("the nursery of the mansion", "the cellar")
    rather than cases already obvious from type alone
  - Prefer fewer high-confidence claims over many speculative ones
  - Do not emit CONTAINS between places where the relationship is ambiguous from names alone

Return {"candidates": []} if no missed containment is evident.
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
  - Common patterns: formal name vs. colloquial name, full name vs. shortened form,
    English name vs. translated name, building name vs. owner-possessive reference

Return {"candidates": []} if no duplicates are evident.
"""


# ---------------------------------------------------------------------------
# Legacy stubs — preserved so imports from older code don't break
# The extract() single-pass method is superseded by extract_two_pass().
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = CATALOG_SYSTEM_PROMPT
USER_TEMPLATE = CATALOG_USER_TEMPLATE
EVIDENCE_SYSTEM_PROMPT = SPATIAL_CLAIMS_SYSTEM_PROMPT
EVIDENCE_USER_TEMPLATE = EVIDENCE_SUBPASS_USER_TEMPLATE
