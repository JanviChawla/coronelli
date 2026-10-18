import * as THREE from 'three'

// ── Tier maps ─────────────────────────────────────────────────────────────────

export const TIER_Y: Record<string, number> = {
  peak: 4, elevated: 2, surface: 0, underground: -2, deep: -4,
}
export const TIER_LABEL: Record<string, string> = {
  peak: 'Peak', elevated: 'Elevated', surface: 'Surface', underground: 'Underground', deep: 'Deep',
}
export const TIER_BAR: Record<string, string> = {
  peak: '#8AABCA', elevated: '#C4884A', surface: '#4A7A4A', underground: '#6A5A7A', deep: '#3A1A2A',
}
// Brighter fills for 3D node geometry — TIER_BAR is too dark for mesh colour
export const TIER_NODE_HEX: Record<string, string> = {
  peak: '#8FBBDA', elevated: '#D4944A', surface: '#C8BC9E', underground: '#8A6AAA', deep: '#AA5A8A',
}

// ── Edge predicates ───────────────────────────────────────────────────────────

export const CONTAIN_RE = /LOCATED_IN|CONTAINS/  // CONTAINS kept for backward compat with existing DB data
export const TRAVEL_RE  = /LEADS_TO/

// ── Geometry per kind_descriptor ─────────────────────────────────────────────

export function geoForKind(kind: string): THREE.BufferGeometry {
  const k = (kind ?? '').toLowerCase()
  if (/^tower/.test(k))                                           return new THREE.BoxGeometry(.58, 2.2, .58)
  if (/^hall/.test(k))                                           return new THREE.CylinderGeometry(1.35, 1.05, .30, 8)
  if (/settlement/.test(k))                                      return new THREE.CylinderGeometry(1, .86, .54, 6)
  if (/^region/.test(k))                                         return new THREE.IcosahedronGeometry(1, 1)
  if (/forest|wood/.test(k))                                     return new THREE.ConeGeometry(.88, 1.75, 6)
  if (/water|lake|river|lagoon|pool|swamp|wetland|sea/.test(k))  return new THREE.TorusGeometry(.76, .22, 6, 14)
  if (/^portal|^threshold|^door/.test(k))                        return new THREE.TorusGeometry(.52, .13, 8, 16)
  if (/^mountain|^pass/.test(k))                                 return new THREE.ConeGeometry(.86, 2., 4)
  if (/^vessel/.test(k))                                         return new THREE.CylinderGeometry(.36, .68, 1.3, 8)
  if (/^dungeon/.test(k))                                        return new THREE.OctahedronGeometry(.95)
  if (/^room/.test(k))                                           return new THREE.BoxGeometry(1, 1, 1)
  if (/^landmark/.test(k))                                       return new THREE.TetrahedronGeometry(.95)
  if (/^grounds|^exterior|^terrain|^farm/.test(k))               return new THREE.DodecahedronGeometry(.9)
  if (/^building|^estate|^infrastructure|^barrier/.test(k))      return new THREE.BoxGeometry(1.05, 1.18, 1.05)
  if (/^route/.test(k))                                          return new THREE.IcosahedronGeometry(.7)
  return new THREE.IcosahedronGeometry(.95)
}

// Visual scale radius — small values matching artifact (camera closeness drives perceived size)
export function rForKind(kind: string): number {
  const k = (kind ?? '').toLowerCase()
  if (/^region/.test(k))                                         return 0.38
  if (/settlement/.test(k))                                      return 0.26
  if (/^estate/.test(k))                                         return 0.32
  if (/^grounds|^exterior|^terrain|^farm/.test(k))               return 0.22
  if (/forest|wood/.test(k))                                     return 0.26
  if (/water|lake|river|lagoon|pool|swamp|wetland|sea/.test(k))  return 0.30
  if (/^dungeon/.test(k))                                        return 0.22
  if (/^hall/.test(k))                                           return 0.22
  if (/^building|^infrastructure/.test(k))                       return 0.20
  if (/^room/.test(k))                                           return 0.16
  if (/^landmark/.test(k))                                       return 0.16
  if (/^mountain|^pass/.test(k))                                 return 0.20
  if (/^portal|^threshold|^door/.test(k))                        return 0.13
  if (/^barrier/.test(k))                                        return 0.14
  if (/^vessel/.test(k))                                         return 0.22
  if (/^route/.test(k))                                          return 0.16
  if (/^tower/.test(k))                                          return 0.18
  return 0.18
}

export function easeOutBack(x: number): number {
  const c1 = 1.70158, c3 = c1 + 1
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
}
