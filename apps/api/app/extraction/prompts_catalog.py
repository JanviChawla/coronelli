"""
Catalog-pass prompts — identifies narratively significant places in a section of text.

Covers:
  - CATALOG PASS  (per section): finds every named place with full atlas metadata
  - CATALOG GAP PASS (per section): second read to catch places the first pass missed
"""

from app.extraction.prompts_taxonomy import (
    _ENTITY_TYPE_BLOCK,
    _KIND_DESCRIPTOR_BLOCK,
    _TIER_BLOCK,
    _SPATIAL_LEVEL_BLOCK,
)

GLOBAL_CATALOG_VERSION     = "5.0-catalog"
GLOBAL_CATALOG_GAP_VERSION = "5.0-catalog-gap"


# ---------------------------------------------------------------------------
# CATALOG PASS — system prompt
# ---------------------------------------------------------------------------

CATALOG_SYSTEM_PROMPT = f"""\
You are a cartographic intelligence extracting the narratively significant places from a passage of literary fiction, for inclusion in a world atlas.

TASK
Read the passage and identify every PLACE that holds meaningful weight in the narrative — locations where events unfold, characters are present, or the story's world takes shape. The atlas should capture places that matter, not every geographic name that appears.

SIGNIFICANCE — apply this test before including any place:

  scene        Characters are physically present; action, dialogue, or events occur here.
               Always include. This is the strongest signal.

  recurring    Referenced multiple times in meaningful context — anchors the world's geography or
               serves as a destination, origin, or goal that shapes the story. Include.

  passing      Mentioned once in background, dialogue, or as geographic flavor, with no character
               presence and no story consequence. DO NOT include.

INCLUDE:
  - Places where scenes actually happen (characters present, events occur, dialogue takes place)
  - Named locations referenced multiple times that anchor the book's geography
  - Named fictional places that are destinations, origins, or goals driving the narrative
  - Sub-locations inside main settings where distinct story events take place
    ("the dormitory where Harry sleeps", "the Great Hall where the feast occurs")
  - Unnamed generic interior spaces ONLY when a scene explicitly happens there
    ("the cellar where they hide" — include; "the cellar" mentioned in passing — skip)

DO NOT include:
  - Places mentioned once in passing with no scene, character presence, or narrative consequence
    → "the snake is from Brazil" — skip Brazil (passing real-world origin reference)
    → "other cities in England" — skip (vague background geography)
    → "he'd always wanted to visit Paris" — skip Paris (aspirational, no action)
  - Real-world place names used purely as geographic flavor, origin stories, or offhand comparisons
  - Vague directional references ("somewhere in the north", "down south", "across the sea")
  - Places that exist only in a character's memory, dream, or hypothetical with no story action
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
      "significance":    "scene" | "recurring" | "passing",
      "parent_context":  "<name of the enclosing place the narrative was in when this place was mentioned, or null>",
      "note":            "<one sentence: what this place is and why it matters to the narrative>",
      "aliases":         ["<alternate name used for this place in THIS section>"],
      "is_new":          true,
      "confidence":      0.85,
      "excerpt":         "<shortest verbatim quote that names or describes this place>"
    }}
  ]
}}

  significance:    The narrative weight of this place in the passage.
                   "scene"     — characters are present; action, dialogue, or events occur here
                   "recurring" — referenced 2+ times as a meaningful anchor of the story's world
                   "passing"   — mentioned once as geographic flavor with no story consequence
                   The pipeline automatically discards "passing" entries. When uncertain between
                   "recurring" and "passing", ask: would a reader of this book recognise this as
                   part of the story's world, or is it just background color?
  name:            Use the most complete, canonical form used in the text. When a place has no
                   proper name but is exclusively and distinctly associated with a named character,
                   incorporate the character's name so the place is uniquely identifiable on a map:
                     "the mushroom" (where only the Caterpillar sits) → "Caterpillar's Mushroom"
                     "a bough of a tree" (where the Cheshire Cat always perches) → "Cheshire Cat's Tree"
                     "the hut" (Baba Yaga's hut, nowhere else) → "Baba Yaga's Hut"
                   Apply this only when the association is clear and consistent — not for incidental mentions.
  parent_context:  The name of the enclosing or surrounding place whose scene the narrative was in when
                   this place was mentioned. Use this to disambiguate generic names ("a hall", "a room",
                   "a tree", "a door") that might appear in multiple locations across the book.
                   Set to null for top-level places (regions, worlds) or when no clear enclosing context exists.
                   Examples: "March Hare's house", "Royal Palace", "the rabbit hole", "Thornfield Hall"
  note:            A one-sentence description capturing what this place IS and why it matters to the
                   narrative. Focus on: what it looks like, what happens there, what role it plays.
                   Never null — even for well-known proper-named places, state their role concisely.
                   Examples: "The enchanted school castle that is Harry's home and the series' central setting."
                             "A long low hall with many locked doors and a tiny golden key on a glass table."
                             "Grand assembly hall where the Queen holds court for the croquet game."
                             "The great beech tree where the Cheshire Cat first appears, sitting on a bough."
  aliases:         Other names the text uses for the SAME place in this section. Empty list [] if none.
  is_new:          true if this place is NOT already in the known_places list.
                   false if it appears there (still emit it so aliases are captured).
  confidence:      Your certainty 0.0–1.0 that this place belongs in a meaningful atlas of this book.
                   0.85–1.0  Scene happens here, or clearly central to this book's world.
                   0.60–0.84 Recurring reference; contributes to world-building without a full scene.
                   < 0.60    Ambiguous; only emit if you lean toward inclusion. Never emit passing mentions.
  excerpt:         Copy the SHORTEST quote that introduces or names the place.

{_ENTITY_TYPE_BLOCK}

{_KIND_DESCRIPTOR_BLOCK}

{_TIER_BLOCK}

{_SPATIAL_LEVEL_BLOCK}

WORKED EXAMPLES — INCLUDE

  "The old colonial mansion" where the narrator spends the summer (The Yellow Wallpaper)
    → significance: scene  type: building  kind_descriptor: building  tier: surface   spatial_level: 2
    note: "The rented colonial estate where the narrator is brought to rest and where her confinement unfolds."

  "The nursery at the top of the house" where she is confined (The Yellow Wallpaper)
    → significance: scene  type: room  kind_descriptor: room  tier: elevated  spatial_level: 3
    note: "The barred upper room where the narrator is locked, dominated by the yellow wallpaper she obsesses over."

  "Sleepy Hollow" — the entire story takes place in and around it (The Legend of Sleepy Hollow)
    → significance: scene  type: region  kind_descriptor: region  tier: surface  spatial_level: 1
    note: "The drowsy, legend-haunted valley that gives the tale its name and atmosphere."

  "The old Dutch church" — recurring landmark; the burying-ground beside it anchors the chase
    → significance: recurring  type: building  kind_descriptor: building  tier: surface  spatial_level: 2
    note: "The ancient Dutch church whose burying-ground is associated with the Headless Horseman."

  "The wooden bridge" — Ichabod must reach it; the chase climax occurs here
    → significance: scene  type: landmark  kind_descriptor: landmark  tier: surface  spatial_level: 3
    note: "The bridge over the stream that Ichabod believes will break the Horseman's power if crossed."

  "The staircase" or "the stairs" connecting floors, where a confrontation occurs (any text)
    → significance: scene  type: passage  kind_descriptor: route  tier: surface  spatial_level: 3
    (stairs are connectors — never type: room; only include if events happen there)

  "Caterpillar's Mushroom" — scene takes place on it (Alice in Wonderland)
    → significance: scene  type: landmark  kind_descriptor: landmark  tier: elevated  spatial_level: 3
    note: "The giant mushroom where the hookah-smoking Caterpillar sits and interrogates Alice."

WORKED EXAMPLES — DO NOT INCLUDE

  "Brazil" — mentioned only because the boa constrictor came from there; no scene, no visit
    → skip  (passing real-world origin reference — significance: passing)

  "other towns in England" — vague background geography, no story relevance
    → skip  (passing geographic flavor)

  "Paris" — a character says they've always wanted to go; no scene, no action
    → skip  (passing aspirational reference)

  "a staircase" that a character merely passes through on the way somewhere else
    → skip  (transit-only connector; no scene on the stairs themselves)\
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
You are reviewing a passage of literary fiction to find any narratively significant places that were MISSED in the first catalog pass. Respond with a JSON object.

A first read already identified the places in the already_found list. Your job is to find significant places the first pass overlooked — not to achieve exhaustive geographic coverage.

SIGNIFICANCE FIRST — only emit a place if it clears this bar:
  A missed place is worth capturing if characters are physically present, events occur there, or it
  recurs as a meaningful anchor of the book's world. Do NOT emit places that are mentioned in passing,
  referenced as background geography, or appear only once in a subordinate clause with no story consequence.
  The first pass may have correctly skipped low-significance mentions — do not second-guess those omissions.

Focus on:
  - Named locations where scenes happen that the first pass missed
  - Interior sub-spaces the first pass overlooked where story events actually occur:
    "the cellar where they hid", "the dining room where the argument broke out", "the attic where she found it"
  - Outdoor sub-locations that serve as scene anchors: "the wharf where they met", "the orchard where it happened"
  - Named places strongly implied by movement events ("fled down to the cellar", "waited at the bridge")

Do NOT emit:
  - Background geography and origin references ("from Brazil", "across the channel", "other towns nearby")
  - Places mentioned once in a subordinate clause with no character presence or story consequence
  - Vague directional references or passing geographic color
  - Anything the first pass would have correctly skipped as significance: passing

OUTPUT FORMAT — identical to the catalog pass:
{{
  "places": [
    {{
      "name":            "<place name>",
      "type":            "<entity type>",
      "kind_descriptor": "<atlas geometry kind>",
      "tier":            "<vertical elevation>",
      "spatial_level":   <integer 0-3>,
      "significance":    "scene" | "recurring" | "passing",
      "parent_context":  "<name of the enclosing place the narrative was in when this place appeared, or null>",
      "note":            "<one sentence: what this place is and why it matters to the narrative>",
      "aliases":         [],
      "is_new":          true,
      "confidence":      0.75,
      "excerpt":         "<supporting quote>"
    }}
  ]
}}

Only emit places NOT in the already_found list.
Return {{"places": []}} if nothing significant was missed.

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
