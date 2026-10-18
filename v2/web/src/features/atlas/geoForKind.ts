import * as THREE from 'three'

/**
 * Returns a Three.js BufferGeometry appropriate for the given place kind descriptor.
 * Matches the 8-tier taxonomy from the Coronelli spec.
 */
export function geoForKind(k: string): THREE.BufferGeometry {
  const kl = k.toLowerCase()

  // Tier I — Enclosed Spaces
  if (/bedroom|nursery|study|kitchen|sitting.room|drawing.room/.test(kl))
    return new THREE.BoxGeometry(1, 0.8, 1)
  if (/great.hall|chamber|gallery|antechamber/.test(kl))
    return new THREE.CylinderGeometry(1.4, 1.1, 0.28, 8)
  if (/common.room|parlour|library|schoolroom/.test(kl))
    return new THREE.BoxGeometry(1.2, 0.7, 1.2)
  if (/cave|cavern/.test(kl))
    return new THREE.OctahedronGeometry(0.9)
  if (/vault|dungeon|cellar|basement/.test(kl))
    return new THREE.OctahedronGeometry(0.85)
  if (/pit|shaft/.test(kl))
    return new THREE.CylinderGeometry(0.3, 0.3, 1.8, 6)

  // Tier II — Structures
  if (/^tower|turret|battlement/.test(kl))
    return new THREE.BoxGeometry(0.55, 2.4, 0.55)
  if (/castle|keep|fortress|citadel|stronghold/.test(kl))
    return new THREE.BoxGeometry(1.4, 1.6, 1.4)
  if (/palace|manor|mansion|ancestral/.test(kl))
    return new THREE.BoxGeometry(1.8, 1.0, 1.4)
  if (/house|cottage|farmhouse|lodge|burrow|bag.end/.test(kl))
    return new THREE.BoxGeometry(1, 0.9, 1)
  if (/inn|tavern|pub|hotel/.test(kl))
    return new THREE.BoxGeometry(1.2, 0.85, 1)
  if (/church|chapel|cathedral|temple|shrine/.test(kl))
    return new THREE.TetrahedronGeometry(1)
  if (/stable|barn|forge|smithy|mill|workshed/.test(kl))
    return new THREE.BoxGeometry(1.3, 0.6, 0.9)

  // Tier III — Exterior Attached Spaces
  if (/garden|grounds|orchard|arbor|lawn/.test(kl))
    return new THREE.DodecahedronGeometry(0.85)
  if (/courtyard|yard|stable.yard/.test(kl))
    return new THREE.TorusGeometry(0.7, 0.18, 6, 10)
  if (/terrace|balcony|piazza|veranda|porch/.test(kl))
    return new THREE.BoxGeometry(1.4, 0.2, 0.7)

  // Tier IV — Gates & Crossings (high-narrative only; edges already filtered)
  if (/gate|gatehouse/.test(kl))
    return new THREE.BoxGeometry(0.5, 1.4, 0.3)
  if (/bridge|ford/.test(kl))
    return new THREE.BoxGeometry(1.6, 0.2, 0.4)

  // Tier V — Water Features
  if (/river|stream|brook|waterfall|rapids/.test(kl))
    return new THREE.TorusGeometry(0.8, 0.18, 6, 16)
  if (/lake|pond|pool|bay|inlet|lagoon/.test(kl))
    return new THREE.TorusGeometry(1.1, 0.28, 6, 12)
  if (/marsh|swamp|bog|fen|hollow/.test(kl))
    return new THREE.TorusGeometry(0.9, 0.38, 5, 10)
  if (/harbor|port|wharf|shore|beach/.test(kl))
    return new THREE.CylinderGeometry(1.2, 1.5, 0.2, 10)

  // Tier VI — Terrain & Landscape
  if (/^mountain|^peak|^summit/.test(kl))
    return new THREE.ConeGeometry(0.8, 2.2, 4)
  if (/^pass|^ridge|^crest/.test(kl))
    return new THREE.ConeGeometry(0.9, 1.2, 4)
  if (/^hill|^knoll|^mound/.test(kl))
    return new THREE.ConeGeometry(1.1, 1.0, 6)
  if (/valley|dale|glen|gorge|ravine|hollow/.test(kl))
    return new THREE.ConeGeometry(1.0, 0.8, 6)
  if (/forest|wood|grove|thicket|copse/.test(kl))
    return new THREE.ConeGeometry(0.9, 1.8, 6)
  if (/plain|meadow|field|heath|moor|clearing|glade/.test(kl))
    return new THREE.DodecahedronGeometry(1.0)
  if (/desert|wasteland/.test(kl))
    return new THREE.IcosahedronGeometry(0.9, 0)

  // Tier VII — Settlements & Territories
  if (/^hamlet|^village|^town/.test(kl))
    return new THREE.CylinderGeometry(1.0, 0.85, 0.55, 6)
  if (/^city|^metropolis/.test(kl))
    return new THREE.CylinderGeometry(1.4, 1.1, 0.65, 8)
  if (/district|quarter|neighborhood|alley/.test(kl))
    return new THREE.DodecahedronGeometry(0.75)
  if (/country|land|kingdom|realm|territory|region|province|the.shire/i.test(kl))
    return new THREE.IcosahedronGeometry(1.1, 1)

  // Tier VIII — Fantastical
  if (/moving.castle|enchanted/.test(kl))
    return new THREE.BoxGeometry(1.4, 1.8, 1.4)
  if (/rabbit.hole|burrow|underground.home|hollow.tree/.test(kl))
    return new THREE.OctahedronGeometry(0.7)
  if (/wonderland|neverland|oz|prythian|ingary|middle.earth/i.test(kl))
    return new THREE.IcosahedronGeometry(1.3, 2)

  // Fallback
  return new THREE.IcosahedronGeometry(0.9, 0)
}

export function tierY(tier: string | undefined): number {
  switch (tier) {
    case 'peak':        return 4
    case 'elevated':    return 2
    case 'surface':     return 0
    case 'underground': return -2
    case 'deep':        return -4
    default:            return 0
  }
}

export function defaultColorForTier(tier: string | undefined): string {
  switch (tier) {
    case 'peak':        return '#8AABCA'
    case 'elevated':    return '#C4884A'
    case 'surface':     return '#4A7A4A'
    case 'underground': return '#6A5A7A'
    case 'deep':        return '#3A1A2A'
    default:            return '#5A6070'
  }
}
