import type { AtlasResponse, AtlasTravelRule, AtlasEntity } from './atlasApi'

// ── Types ─────────────────────────────────────────────────────────────────────

export type NodeRole = 'origin' | 'hub' | 'normal' | 'inferred'

// 0 = world/region, 1 = settlement/area, 2 = building/feature, 3 = room/interior
export type SpatialLevel = 0 | 1 | 2 | 3

export function spatialLevel(placeKind: string | null): SpatialLevel {
  switch (placeKind?.toLowerCase()) {
    case 'world': case 'region': case 'island': return 0
    case 'settlement': case 'site': case 'exterior': return 1
    case 'building': case 'court': case 'landmark':
    case 'body_of_water': case 'terrain_feature': case 'barrier': return 2
    case 'room': case 'hall': return 3
    default: return 2
  }
}

export type EdgeStyle =
  | 'containment'  // dashed grey – CONTAINS, LOCATED_IN
  | 'directed'     // solid dark + arrow – LEADS_TO, DESCENDS_TO, etc.
  | 'passage'      // labeled gold dashed – dissolved transition node
  | 'proximity'    // light dotted – ADJACENT_TO, NEAR
  | 'compass'      // blue-grey arrow – NORTH_OF, EAST_OF, etc.
  | 'movement'     // brown dashed – REACHED_FROM (geography unknown)
  | 'uncertain'    // very faint – low confidence / inferred connection

export interface DiagramNode {
  id: string
  label: string
  kind: 'place'
  placeKind: string | null
  role: NodeRole
  nestedCount: number
  narrativeOrder: number
  aliases: string[]
  status: string
  revealSectionId: string | null
  claimCount: number
  isInferred: boolean
  spatialLevel: SpatialLevel
}

export interface DiagramEdge {
  id: string
  source: string
  target: string
  sourceName: string
  targetName: string
  predicate: string
  style: EdgeStyle
  edgeLabel: string | null
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
  | { kind: 'node'; node: DiagramNode; entity: AtlasEntity | null; travelRules: AtlasTravelRule[] }
  | { kind: 'edge'; edge: DiagramEdge }
  | null

export interface FilterState {
  places: boolean
  passages: boolean
  containment: boolean
  relationships: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_FILTERS: FilterState = {
  places: true,
  passages: true,
  containment: true,
  relationships: true,
}

const TRANSITION_PLACE_KINDS = new Set([
  'door', 'doorway', 'passage', 'passageway', 'portal', 'gate', 'gateway',
  'tunnel', 'shaft', 'corridor', 'stairs', 'staircase', 'ladder',
  'entrance', 'opening', 'archway', 'window', 'hatch', 'trapdoor',
  'hole', 'rabbit-hole', 'rabbit hole',
])

const CONTAINMENT_PREDICATES = new Set([
  'CONTAINS', 'LOCATED_IN', 'SURROUNDED_BY',
  // IN_OR_ADJACENT_TO is ambiguous — proximity, not a hull/containment signal
])

const DIRECTIONAL_PREDICATES = new Set([
  'LEADS_TO', 'OPENS_TOWARD', 'DESCENDS_TO', 'ENDS_AT',
  'HAS_OPENING', 'BLOCKS_ACCESS_TO', 'CONNECTS_TO',
])

const PROXIMITY_PREDICATES = new Set([
  'ADJACENT_TO', 'NEAR', 'IN_OR_ADJACENT_TO', 'ON_BANK_OF',
  'BORDERS', 'VISIBLE_FROM',
])

const COMPASS_PREDICATES = new Set([
  'NORTH_OF', 'SOUTH_OF', 'EAST_OF', 'WEST_OF',
  'NORTHEAST_OF', 'NORTHWEST_OF', 'SOUTHEAST_OF', 'SOUTHWEST_OF',
])

function predicateToStyle(predicate: string, confidence: number | null): EdgeStyle {
  if (CONTAINMENT_PREDICATES.has(predicate)) return 'containment'
  if (DIRECTIONAL_PREDICATES.has(predicate)) {
    return (confidence !== null && confidence < 0.5) ? 'uncertain' : 'directed'
  }
  if (PROXIMITY_PREDICATES.has(predicate)) return 'proximity'
  if (COMPASS_PREDICATES.has(predicate)) return 'compass'
  if (predicate === 'REACHED_FROM') return 'movement'
  return 'uncertain'
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
  BLOCKS_ACCESS_TO:  'A barrier or condition restricts access.',
  CONNECTS_TO:       'Two places are directly connected.',
  ADJACENT_TO:       'Two places are directly side by side.',
  NEAR:              'Two places are in proximity (no direct connection implied).',
  ON_BANK_OF:        'A land place sits on the bank or shore of a body of water.',
  BORDERS:           'Two territories share a boundary.',
  VISIBLE_FROM:      'A place is explicitly described as visible from another.',
  REACHED_FROM:      'Movement was narrated but intermediate geography is unknown.',
  NORTH_OF:          'Compass placement stated explicitly in source text.',
  SOUTH_OF:          'Compass placement stated explicitly in source text.',
  EAST_OF:           'Compass placement stated explicitly in source text.',
  WEST_OF:           'Compass placement stated explicitly in source text.',
  NORTHEAST_OF:      'Compass placement stated explicitly in source text.',
  NORTHWEST_OF:      'Compass placement stated explicitly in source text.',
  SOUTHEAST_OF:      'Compass placement stated explicitly in source text.',
  SOUTHWEST_OF:      'Compass placement stated explicitly in source text.',
  PASSAGE:           'Physical passage connecting two places (door, corridor, portal, etc.).',
}

// ── Builder ───────────────────────────────────────────────────────────────────

export function buildDiagramViewModel(
  atlas: AtlasResponse,
  sectionOrder?: Map<string, number>,
): DiagramViewModel {
  const entityIds = new Set(atlas.entities.map(e => e.id))
  const entityById = new Map(atlas.entities.map(e => [e.id, e]))
  const entityNames = new Map(atlas.entities.map(e => [e.id, e.name]))

  // Alias→entityId index for resolving travel rule place names to IDs
  const aliasToId = new Map<string, string>()
  for (const entity of atlas.entities) {
    aliasToId.set(entity.name.toLowerCase(), entity.id)
    for (const alias of (entity.aliases ?? [])) {
      if (alias) aliasToId.set(alias.toLowerCase(), entity.id)
    }
  }

  const transitionIds = new Set(
    atlas.entities
      .filter(e => TRANSITION_PLACE_KINDS.has((e.place_kind ?? '').toLowerCase()))
      .map(e => e.id),
  )

  const narrativeOrderOf = (sectionId: string | null): number => {
    if (!sectionId || !sectionOrder) return 0
    return sectionOrder.get(sectionId) ?? 0
  }

  // ── Build all raw edges from spatial claims ────────────────────────────────

  type RawEdge = {
    id: string
    source: string
    target: string
    sourceName: string
    targetName: string
    predicate: string
    style: EdgeStyle
    confidence: number | null
    excerpt: string | null
  }

  const nestedCounts: Record<string, number> = {}
  const rawEdges: RawEdge[] = []

  for (const entity of atlas.entities) {
    for (const claim of entity.claims) {
      if (claim.claim_type !== 'spatial') continue
      if (!claim.predicate || claim.predicate === 'SAME_AS') continue
      const targetId = claim.object_refs?.[0]
      if (!targetId || !entityIds.has(targetId)) continue
      if (CONTAINMENT_PREDICATES.has(claim.predicate)) {
        nestedCounts[entity.id] = (nestedCounts[entity.id] ?? 0) + 1
      }
      rawEdges.push({
        id: claim.id,
        source: entity.id,
        target: targetId,
        sourceName: entity.name,
        targetName: entityNames.get(targetId) ?? targetId,
        predicate: claim.predicate,
        style: predicateToStyle(claim.predicate, claim.confidence ?? null),
        confidence: claim.confidence ?? null,
        excerpt: claim.excerpt ?? null,
      })
    }
  }

  // ── Dissolve transition nodes into passage edges ───────────────────────────

  const dissolvableIds = new Set<string>()
  const dissolvedEdgeIds = new Set<string>()
  const passageEdges: DiagramEdge[] = []

  for (const tid of transitionIds) {
    const transition = entityById.get(tid)
    if (!transition) continue

    // Edges going from a non-transition place INTO this transition
    const intoEdges = rawEdges.filter(
      e => e.target === tid && !transitionIds.has(e.source),
    )
    // Edges going OUT of this transition to a non-transition place
    const outEdges = rawEdges.filter(
      e => e.source === tid && !transitionIds.has(e.target),
    )
    // Containment: another place CONTAINS this transition (gives us the "from" side)
    const containedByEdge = rawEdges.find(
      e => e.target === tid && CONTAINMENT_PREDICATES.has(e.predicate),
    )

    // Collect all "from" sides: explicit directional in-edges, then containment parent
    const fromSides: Array<{ id: string; name: string }> =
      intoEdges.length > 0
        ? intoEdges.map(e => ({ id: e.source, name: e.sourceName }))
        : containedByEdge
          ? [{ id: containedByEdge.source, name: containedByEdge.sourceName }]
          : []

    // Collect all "to" sides
    const toSides: Array<{ id: string; name: string }> =
      outEdges.map(e => ({ id: e.target, name: e.targetName }))

    if (fromSides.length > 0 && toSides.length > 0) {
      // Create a passage edge for every (from, to) pair — preserves all connections
      const seenPairs = new Set<string>()
      for (const from of fromSides) {
        for (const to of toSides) {
          if (from.id === to.id) continue
          const pairKey = `${from.id}:${to.id}`
          if (seenPairs.has(pairKey)) continue
          seenPairs.add(pairKey)
          passageEdges.push({
            id: `passage-${tid}-${from.id.slice(-6)}-${to.id.slice(-6)}`,
            source: from.id,
            target: to.id,
            sourceName: from.name,
            targetName: to.name,
            predicate: 'PASSAGE',
            style: 'passage',
            edgeLabel: transition.name,
            excerpt: null,
            claimId: tid,
          })
        }
      }
      dissolvableIds.add(tid)
      intoEdges.forEach(e => dissolvedEdgeIds.add(e.id))
      outEdges.forEach(e => dissolvedEdgeIds.add(e.id))
      if (containedByEdge) dissolvedEdgeIds.add(containedByEdge.id)
    } else if (outEdges.length >= 2) {
      // Bidirectional portal: no "from" side — connect each pair of targets
      const seenPairs = new Set<string>()
      for (let i = 0; i < outEdges.length; i++) {
        for (let j = i + 1; j < outEdges.length; j++) {
          const a = outEdges[i], b = outEdges[j]
          const pairKey = `${a.target}:${b.target}`
          if (seenPairs.has(pairKey)) continue
          seenPairs.add(pairKey)
          passageEdges.push({
            id: `passage-${tid}-${a.target.slice(-6)}-${b.target.slice(-6)}`,
            source: a.target,
            target: b.target,
            sourceName: a.targetName,
            targetName: b.targetName,
            predicate: 'PASSAGE',
            style: 'passage',
            edgeLabel: transition.name,
            excerpt: null,
            claimId: tid,
          })
        }
      }
      dissolvableIds.add(tid)
      outEdges.forEach(e => dissolvedEdgeIds.add(e.id))
      if (containedByEdge) dissolvedEdgeIds.add(containedByEdge.id)
    }
    // Otherwise: can't dissolve — keep as a regular place node
  }

  const remainingEdges: DiagramEdge[] = rawEdges
    .filter(e => !dissolvedEdgeIds.has(e.id))
    .filter(e => !dissolvableIds.has(e.source) && !dissolvableIds.has(e.target))
    .map(e => ({ ...e, edgeLabel: null, claimId: e.id }))

  // Convert travel rules to route edges where both endpoints resolve to entities
  const seenEdgePairs = new Set<string>()
  for (const e of [...remainingEdges, ...passageEdges]) {
    seenEdgePairs.add(`${e.source}:${e.target}`)
    seenEdgePairs.add(`${e.target}:${e.source}`)
  }
  const routeEdges: DiagramEdge[] = []
  for (const rule of atlas.travel_rules) {
    const payload = rule.payload as Record<string, unknown>
    const fromName = String(payload.from ?? '').toLowerCase().trim()
    const toName   = String(payload.to   ?? '').toLowerCase().trim()
    if (!fromName || !toName) continue
    const sourceId = aliasToId.get(fromName)
    const targetId = aliasToId.get(toName)
    if (!sourceId || !targetId) continue
    if (!entityIds.has(sourceId) || !entityIds.has(targetId)) continue
    if (sourceId === targetId) continue
    if (dissolvableIds.has(sourceId) || dissolvableIds.has(targetId)) continue
    if (seenEdgePairs.has(`${sourceId}:${targetId}`) || seenEdgePairs.has(`${targetId}:${sourceId}`)) continue
    seenEdgePairs.add(`${sourceId}:${targetId}`)
    seenEdgePairs.add(`${targetId}:${sourceId}`)
    const via = payload.via ? String(payload.via) : null
    routeEdges.push({
      id: `route-${rule.id}`,
      source: sourceId,
      target: targetId,
      sourceName: entityNames.get(sourceId) ?? String(payload.from ?? ''),
      targetName: entityNames.get(targetId) ?? String(payload.to   ?? ''),
      predicate: 'REACHED_FROM',
      style: 'movement',
      edgeLabel: via,
      excerpt: null,
      claimId: rule.id,
    })
  }

  const edges = [...remainingEdges, ...passageEdges, ...routeEdges]

  // ── Assign node roles ─────────────────────────────────────────────────────

  const regularEntities = atlas.entities.filter(e => !dissolvableIds.has(e.id))
  const hasSectionData = (sectionOrder?.size ?? 0) > 0

  const sectionOrders = regularEntities
    .filter(e => e.provenance_section_id && sectionOrder?.has(e.provenance_section_id))
    .map(e => sectionOrder!.get(e.provenance_section_id!)!)

  const minNarrativeOrder = sectionOrders.length > 0 ? Math.min(...sectionOrders) : Infinity

  const claimCounts = regularEntities.map(
    e => e.claims.filter(c => c.claim_type === 'spatial').length,
  )
  const maxClaims = Math.max(0, ...claimCounts)
  const hubThreshold = Math.max(3, Math.floor(maxClaims * 0.6))

  const nodeRole = (entity: typeof atlas.entities[0]): NodeRole => {
    if (entity.status === 'inferred') return 'inferred'
    if (hasSectionData && minNarrativeOrder !== Infinity && entity.provenance_section_id) {
      const order = sectionOrder!.get(entity.provenance_section_id)
      if (order === minNarrativeOrder) return 'origin'
    }
    const claimCount = entity.claims.filter(c => c.claim_type === 'spatial').length
    if (claimCount >= hubThreshold) return 'hub'
    return 'normal'
  }

  // ── Build nodes ───────────────────────────────────────────────────────────

  const nodes: DiagramNode[] = regularEntities.map(entity => ({
    id: entity.id,
    label: entity.name,
    kind: 'place' as const,
    placeKind: entity.place_kind,
    role: nodeRole(entity),
    nestedCount: nestedCounts[entity.id] ?? 0,
    narrativeOrder: narrativeOrderOf(entity.provenance_section_id),
    aliases: entity.aliases ?? [],
    status: entity.status ?? 'explicit',
    revealSectionId: entity.provenance_section_id,
    claimCount: entity.claims.filter(c => c.claim_type === 'spatial').length,
    isInferred: entity.status === 'inferred',
    spatialLevel: spatialLevel(entity.place_kind),
  }))

  nodes.sort((a, b) => a.narrativeOrder - b.narrativeOrder || a.id.localeCompare(b.id))
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
  const visibleNodes = filters.places ? vm.nodes : []
  const visibleIds = new Set(visibleNodes.map(n => n.id))

  const visibleEdges = vm.edges.filter(e => {
    if (!visibleIds.has(e.source) || !visibleIds.has(e.target)) return false
    if (e.style === 'containment' && !filters.containment) return false
    if (e.style === 'passage' && !filters.passages) return false
    if (!['containment', 'passage'].includes(e.style) && !filters.relationships) return false
    return true
  })

  return { nodes: visibleNodes, edges: visibleEdges }
}
