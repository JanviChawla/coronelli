import { describe, it, expect } from 'vitest'
import { buildDiagramViewModel, applyFilters, DEFAULT_FILTERS } from './atlasGraph'
import type { AtlasResponse } from './atlasApi'

// ── Alice fixture ─────────────────────────────────────────────────────────────

const HALL_ID      = 'ent-hall'
const DOOR_ID      = 'ent-door'
const PASSAGE_ID   = 'ent-passage'
const GARDEN_ID    = 'ent-garden'
const TREE_DOOR_ID = 'ent-tree-door'

const CLAIM_DOOR_LEADS_PASSAGE   = 'claim-001'
const CLAIM_TREE_LEADS_HALL      = 'claim-002'
const CLAIM_HALL_CONTAINS_DOOR   = 'claim-003'
const CLAIM_VISUAL               = 'claim-004'
const CLAIM_SAME_AS              = 'claim-005'
const CLAIM_UNKNOWN_OBJECT       = 'claim-006'

function makeAtlas(overrides?: Partial<AtlasResponse>): AtlasResponse {
  return {
    document_id: 'doc-alice',
    entity_count: 5,
    claim_count: 4,
    travel_rule_count: 1,
    travel_rules: [
      {
        id: 'route-001',
        traveler: 'Alice',
        route: 'Riverbank → Rabbit Hole → Long Low Hall',
        can_traverse: true,
        condition: null,
        payload: { from: 'Riverbank', to: 'Long Low Hall', via: 'Rabbit Hole', traveler: 'Alice', can_traverse: true, condition: null },
      },
    ],
    entities: [
      {
        id: HALL_ID,
        name: 'Long Low Hall',
        place_kind: 'hall',
        aliases: [],
        state: 'active',
        status: 'explicit',
        provenance_section_id: 'sec-ch1',
        payload: { name: 'Long Low Hall', type: 'hall' },
        claims: [
          {
            id: CLAIM_HALL_CONTAINS_DOOR,
            claim_type: 'spatial',
            predicate: 'CONTAINS',
            subject_ref: HALL_ID,
            object_refs: [DOOR_ID],
            payload: { subject: 'Long Low Hall', predicate: 'CONTAINS', object: 'Little Door' },
            confidence: null,
            excerpt: 'a little door about fifteen inches high',
            status: 'explicit',
          },
          {
            id: CLAIM_VISUAL,
            claim_type: 'visual',
            predicate: null,
            subject_ref: HALL_ID,
            object_refs: null,
            payload: { subject: 'Long Low Hall', visual_property: 'lighting', value: 'row of lamps hanging from the roof' },
            confidence: null,
            excerpt: 'row of lamps hanging from the roof',
            status: 'explicit',
          },
        ],
      },
      {
        id: DOOR_ID,
        name: 'Little Door',
        place_kind: 'door',
        aliases: [],
        state: 'active',
        status: 'explicit',
        provenance_section_id: 'sec-ch1',
        payload: { name: 'Little Door', type: 'door' },
        claims: [
          {
            id: CLAIM_DOOR_LEADS_PASSAGE,
            claim_type: 'spatial',
            predicate: 'LEADS_TO',
            subject_ref: DOOR_ID,
            object_refs: [PASSAGE_ID],
            payload: { subject: 'Little Door', predicate: 'LEADS_TO', object: 'Small Passage' },
            confidence: null,
            excerpt: 'leading to a small passage',
            status: 'explicit',
          },
          {
            id: CLAIM_SAME_AS,
            claim_type: 'spatial',
            predicate: 'SAME_AS',
            subject_ref: DOOR_ID,
            object_refs: [DOOR_ID],
            payload: { subject: 'Little Door', predicate: 'SAME_AS', object: 'Little Door' },
            confidence: null,
            excerpt: null,
            status: 'inferred',
          },
          {
            id: CLAIM_UNKNOWN_OBJECT,
            claim_type: 'spatial',
            predicate: 'LEADS_TO',
            subject_ref: DOOR_ID,
            object_refs: ['ent-nonexistent'],
            payload: { subject: 'Little Door', predicate: 'LEADS_TO', object: 'Unknown Place' },
            confidence: null,
            excerpt: null,
            status: 'inferred',
          },
        ],
      },
      {
        id: PASSAGE_ID,
        name: 'Small Passage',
        place_kind: 'passage',
        aliases: [],
        state: 'active',
        status: 'explicit',
        provenance_section_id: null,
        payload: { name: 'Small Passage', type: 'passage' },
        claims: [],
      },
      {
        id: GARDEN_ID,
        name: 'Garden',
        place_kind: 'exterior',
        aliases: ['The Lovely Garden'],
        state: 'active',
        status: 'inferred',
        provenance_section_id: null,
        payload: { name: 'Garden', type: 'exterior' },
        claims: [],
      },
      {
        id: TREE_DOOR_ID,
        name: 'Tree Door',
        place_kind: 'door',
        aliases: [],
        state: 'active',
        status: 'inferred',
        provenance_section_id: null,
        payload: { name: 'Tree Door', type: 'door' },
        claims: [
          {
            id: CLAIM_TREE_LEADS_HALL,
            claim_type: 'spatial',
            predicate: 'LEADS_TO',
            subject_ref: TREE_DOOR_ID,
            object_refs: [HALL_ID],
            payload: { subject: 'Tree Door', predicate: 'LEADS_TO', object: 'Long Low Hall' },
            confidence: null,
            excerpt: 'the door led back into the long hall',
            status: 'inferred',
          },
        ],
      },
    ],
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildDiagramViewModel', () => {
  it('produces a node for each expected Alice place', () => {
    const vm = buildDiagramViewModel(makeAtlas())
    const ids = vm.nodes.map(n => n.id)
    expect(ids).toContain(HALL_ID)
    expect(ids).toContain(DOOR_ID)
    expect(ids).toContain(PASSAGE_ID)
    expect(ids).toContain(GARDEN_ID)
  })

  it('classifies door and passage as transition nodes, hall as place node', () => {
    const vm = buildDiagramViewModel(makeAtlas())
    const byId = Object.fromEntries(vm.nodes.map(n => [n.id, n]))
    expect(byId[HALL_ID].kind).toBe('place')
    expect(byId[DOOR_ID].kind).toBe('transition')
    expect(byId[PASSAGE_ID].kind).toBe('transition')
    expect(byId[GARDEN_ID].kind).toBe('place')
  })

  it('Little Door → Small Passage is a directional edge', () => {
    const vm = buildDiagramViewModel(makeAtlas())
    const edge = vm.edges.find(e => e.id === CLAIM_DOOR_LEADS_PASSAGE)
    expect(edge).toBeDefined()
    expect(edge!.source).toBe(DOOR_ID)
    expect(edge!.target).toBe(PASSAGE_ID)
    expect(edge!.style).toBe('directional')
    expect(edge!.predicate).toBe('LEADS_TO')
  })

  it('Tree Door → Long Low Hall is a directional edge when approved', () => {
    const vm = buildDiagramViewModel(makeAtlas())
    const edge = vm.edges.find(e => e.id === CLAIM_TREE_LEADS_HALL)
    expect(edge).toBeDefined()
    expect(edge!.source).toBe(TREE_DOOR_ID)
    expect(edge!.target).toBe(HALL_ID)
    expect(edge!.style).toBe('directional')
  })

  it('CONTAINS maps to containment style, LEADS_TO maps to directional style', () => {
    const vm = buildDiagramViewModel(makeAtlas())
    const containsEdge = vm.edges.find(e => e.id === CLAIM_HALL_CONTAINS_DOOR)
    const leadsEdge = vm.edges.find(e => e.id === CLAIM_DOOR_LEADS_PASSAGE)
    expect(containsEdge!.style).toBe('containment')
    expect(leadsEdge!.style).toBe('directional')
  })

  it('SAME_AS claims do not produce edges', () => {
    const vm = buildDiagramViewModel(makeAtlas())
    expect(vm.edges.find(e => e.id === CLAIM_SAME_AS)).toBeUndefined()
  })

  it('visual claims do not produce edges', () => {
    const vm = buildDiagramViewModel(makeAtlas())
    expect(vm.edges.find(e => e.id === CLAIM_VISUAL)).toBeUndefined()
  })

  it('claims with unknown object_refs are silently skipped', () => {
    const vm = buildDiagramViewModel(makeAtlas())
    expect(vm.edges.find(e => e.id === CLAIM_UNKNOWN_OBJECT)).toBeUndefined()
  })

  it('produces identical output for identical input (determinism)', () => {
    const a = buildDiagramViewModel(makeAtlas())
    const b = buildDiagramViewModel(makeAtlas())
    expect(a.nodes.map(n => n.id)).toEqual(b.nodes.map(n => n.id))
    expect(a.edges.map(e => e.id)).toEqual(b.edges.map(e => e.id))
  })

  it('isEmpty is true when atlas has no entities', () => {
    const vm = buildDiagramViewModel({ ...makeAtlas(), entities: [], entity_count: 0 })
    expect(vm.isEmpty).toBe(true)
  })

  it('no node label contains geographic or metric language', () => {
    const vm = buildDiagramViewModel(makeAtlas())
    const GEO_PATTERN = /\b(north|south|east|west|km|miles?|coordinates?|latitude|longitude)\b/i
    for (const node of vm.nodes) {
      expect(node.label).not.toMatch(GEO_PATTERN)
    }
  })

  it('routes are preserved separately and not rendered as edges', () => {
    const vm = buildDiagramViewModel(makeAtlas())
    expect(vm.routes).toHaveLength(1)
    expect(vm.routes[0].id).toBe('route-001')
    // route waypoints must not appear as diagram edges
    expect(vm.edges.find(e => e.id === 'route-001')).toBeUndefined()
  })
})

describe('applyFilters', () => {
  it('hides transition nodes when transitions filter is off', () => {
    const vm = buildDiagramViewModel(makeAtlas())
    const { nodes } = applyFilters(vm, { ...DEFAULT_FILTERS, transitions: false })
    expect(nodes.every(n => n.kind === 'place')).toBe(true)
  })

  it('removes edges whose endpoints are filtered out', () => {
    const vm = buildDiagramViewModel(makeAtlas())
    // With transitions off, DOOR_ID and PASSAGE_ID and TREE_DOOR_ID are hidden
    const { edges } = applyFilters(vm, { ...DEFAULT_FILTERS, transitions: false })
    // No edges should involve transition node IDs
    const transitionIds = new Set([DOOR_ID, PASSAGE_ID, TREE_DOOR_ID])
    for (const edge of edges) {
      expect(transitionIds.has(edge.source)).toBe(false)
      expect(transitionIds.has(edge.target)).toBe(false)
    }
  })

  it('hides containment edges when containment filter is off', () => {
    const vm = buildDiagramViewModel(makeAtlas())
    const { edges } = applyFilters(vm, { ...DEFAULT_FILTERS, containment: false })
    expect(edges.every(e => e.style !== 'containment')).toBe(true)
  })
})
