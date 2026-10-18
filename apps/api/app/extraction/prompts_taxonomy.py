"""
Shared taxonomy reference blocks — embedded into system prompts at module load time.

These describe the controlled vocabularies for entity_type, kind_descriptor, tier,
and spatial_level. Both the catalog and evidence passes import from here.
"""

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
  portal           door, gate, arch, window, threshold — an opening rather than a path or enclosure
  site             battlefield, excavation, named clearing, or ruin without surviving structure
  court            enclosed formal court (legal, royal); use 'grounds' for open courtyards
  barrier          named wall, fence, or fortification treated as a location

  COMMON MISCLASSIFICATIONS — avoid these:
  - A staircase, stairway, steps → passage  (NOT room; stairs are connectors, not enclosures)
  - A hallway, corridor, passage → passage  (NOT room, NOT hall)
  - "Hall" meaning a corridor or entrance hall → passage  (hall type is ONLY great halls / assembly chambers)
  - A window, doorway, archway, threshold, gate opening → portal  (NOT room)
  - A landing between stair flights → room  (it is a resting space, not a connector)"""

_KIND_DESCRIPTOR_BLOCK = """\
KIND DESCRIPTOR  (drives 3-D geometry in the world atlas — choose the single best match)

  IMPORTANT: kind_descriptor is the visual geometry class used to render this place in 3-D.
  It is NOT the entity type and does NOT share its vocabulary. Never copy an entity type value
  (terrain_feature, body_of_water, passage, portal, grounds, vessel, etc.) into kind_descriptor
  — the two fields are independent axes. Always choose from this list only:

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
