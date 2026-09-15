import type { AtlasClaim, AtlasResponse, AtlasTravelRule } from './atlasApi'

// ── Types ─────────────────────────────────────────────────────────────────────

export type NodeKind = 'place' | 'transition'

export type EdgeStyle = 'containment' | 'directional' | 'proximity' | 'movement'

export interface DiagramNode {
  id: string
  label: string
  kind: NodeKind
  placeKind: string | null
  nestedCount: number
  // Inspector payload
  aliases: string[]
  status: string
  revealSectionId: string | null
  claimCount: number
}

export interface DiagramEdge {
  id: string
  source: string
  target: string
  sourceName: string
  targetName: string
  predicate: string
  style: EdgeStyle
  // Inspector payload
  excerpt: string | null
  claimId: string
}

export interface DiagramViewModel {
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  routes: AtlasTravelRule[]
  isEmpty: boolean
}

export type InspectorTarget =
  | { kind: 'node'; node: DiagramNode; visualClaims: AtlasClaim[] }
  | { kind: 'edge'; edge: DiagramEdge }
  | null

export interface FilterState {
  places: boolean
  transitions: boolean
  containment: boolean
  relationships: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_FILTERS: FilterState = {
  places: true,
  transitions: true,
  containment: true,
  relationships: true,
}

const TRANSITION_PLACE_KINDS = new Set([
  'door', 'passage', 'portal', 'tunnel', 'shaft',
])

const PREDICATE_STYLE: Record<string, EdgeStyle> = {
  CONTAINS:          'containment',
  LOCATED_IN:        'containment',
  SURROUNDED_BY:     'containment',
  IN_OR_ADJACENT_TO: 'containment',
  LEADS_TO:          'directional',
  OPENS_TOWARD:      'directional',
  DESCENDS_TO:       'directional',
  ENDS_AT:           'directional',
  HAS_OPENING:       'directional',
  BLOCKS_ACCESS_TO:  'directional',
  ADJACENT_TO:       'proximity',
  NEAR:              'proximity',
  NORTH_OF:          'proximity',
  SOUTH_OF:          'proximity',
  EAST_OF:           'proximity',
  WEST_OF:           'proximity',
  NORTHEAST_OF:      'proximity',
  NORTHWEST_OF:      'proximity',
  SOUTHEAST_OF:      'proximity',
  SOUTHWEST_OF:      'proximity',
  REACHED_FROM:      'movement',
}

export const PREDICATE_DESCRIPTIONS: Record<string, string> = {
  CONTAINS:          'One place contains or encloses another.',
  LOCATED_IN:        'A place or feature is located within another.',
  SURROUNDED_BY:     'A place is fully encircled by the surrounding area.',
  IN_OR_ADJACENT_TO: 'A place is inside or immediately beside another.',
  LEADS_TO:          'A physical transition leads directly to a destination.',
  OPENS_TOWARD:      'An opening faces or approaches a destination.',
  DESCENDS_TO:       'A descending route or feature reaches a lower destination.',
  ENDS_AT:           'A route, shaft, or passage terminates at a location.',
  HAS_OPENING:       'A place has a window, door, chimney, or other opening.',
  BLOCKS_ACCESS_TO:  'A barrier or condition-bearing feature restricts access.',
  ADJACENT_TO:       'Two places are directly side by side.',
  NEAR:              'Two places are in proximity (no direct connection implied).',
  REACHED_FROM:      'Movement was narrated but intermediate geography is unknown.',
  NORTH_OF:          'Absolute compass placement stated explicitly in source text.',
  SOUTH_OF:          'Absolute compass placement stated explicitly in source text.',
  EAST_OF:           'Absolute compass placement stated explicitly in source text.',
  WEST_OF:           'Absolute compass placement stated explicitly in source text.',
  NORTHEAST_OF:      'Absolute compass placement stated explicitly in source text.',
  NORTHWEST_OF:      'Absolute compass placement stated explicitly in source text.',
  SOUTHEAST_OF:      'Absolute compass placement stated explicitly in source text.',
  SOUTHWEST_OF:      'Absolute compass placement stated explicitly in source text.',
}

// ── Builder ───────────────────────────────────────────────────────────────────

export function buildDiagramViewModel(atlas: AtlasResponse): DiagramViewModel {
  const entityIds = new Set(atlas.entities.map(e => e.id))
  const entityNames = new Map(atlas.entities.map(e => [e.id, e.name]))

  const nestedCounts: Record<string, number> = {}
  const edges: DiagramEdge[] = []

  for (const entity of atlas.entities) {
    for (const claim of entity.claims) {
      if (claim.claim_type !== 'spatial') continue
      if (!claim.predicate || claim.predicate === 'SAME_AS') continue

      const style = PREDICATE_STYLE[claim.predicate]
      if (!style) continue

      const targetId = claim.object_refs?.[0]
      if (!targetId || !entityIds.has(targetId)) continue

      if (claim.predicate === 'CONTAINS') {
        nestedCounts[entity.id] = (nestedCounts[entity.id] ?? 0) + 1
      }

      edges.push({
        id: claim.id,
        source: entity.id,
        target: targetId,
        sourceName: entity.name,
        targetName: entityNames.get(targetId) ?? targetId,
        predicate: claim.predicate,
        style,
        excerpt: claim.excerpt ?? null,
        claimId: claim.id,
      })
    }
  }

  const nodes: DiagramNode[] = atlas.entities.map(entity => ({
    id: entity.id,
    label: entity.name,
    kind: TRANSITION_PLACE_KINDS.has(entity.place_kind ?? '') ? 'transition' : 'place',
    placeKind: entity.place_kind,
    nestedCount: nestedCounts[entity.id] ?? 0,
    aliases: entity.aliases ?? [],
    status: entity.status ?? 'explicit',
    revealSectionId: entity.provenance_section_id,
    claimCount: entity.claims.filter(c => c.claim_type === 'spatial').length,
  }))

  // Deterministic order
  nodes.sort((a, b) => a.id.localeCompare(b.id))
  edges.sort((a, b) => a.id.localeCompare(b.id))

  return {
    nodes,
    edges,
    routes: atlas.travel_rules,
    isEmpty: nodes.length === 0,
  }
}

// ── Filter helpers ────────────────────────────────────────────────────────────

export function applyFilters(
  vm: DiagramViewModel,
  filters: FilterState,
): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const visibleNodes = vm.nodes.filter(n => {
    if (n.kind === 'place' && !filters.places) return false
    if (n.kind === 'transition' && !filters.transitions) return false
    return true
  })

  const visibleIds = new Set(visibleNodes.map(n => n.id))

  const visibleEdges = vm.edges.filter(e => {
    if (!visibleIds.has(e.source) || !visibleIds.has(e.target)) return false
    if (e.style === 'containment' && !filters.containment) return false
    if (e.style !== 'containment' && !filters.relationships) return false
    return true
  })

  return { nodes: visibleNodes, edges: visibleEdges }
}
