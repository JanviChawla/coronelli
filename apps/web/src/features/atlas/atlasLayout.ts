/**
 * atlasLayout.ts
 *
 * Hierarchical force-directed layout for the cartographic schematic.
 *
 * Goals:
 *   1. Narrative x-axis   — places revealed earlier appear left
 *   2. Scene clustering   — places that appear in the same section stay close vertically
 *   3. Containment depth  — contained places drawn near their containers with higher attraction
 *   4. Hub prominence     — high-connectivity places repel more strongly so they sit in open space
 *   5. Label clearance    — collision radius large enough that labels don't overlap
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceX,
  forceY,
  forceCollide,
} from 'd3-force'
import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force'
import type { DiagramNode, DiagramEdge } from './atlasGraph'

// ── Public types ──────────────────────────────────────────────────────────────

export type LayoutPositions = Record<string, { x: number; y: number }>

/** container-id → direct-child ids */
export type ContainmentMap = Record<string, string[]>

// ── Simulation constants ──────────────────────────────────────────────────────

const SIM_W = 1300
const SIM_H = 800

// ── Internal simulation types ─────────────────────────────────────────────────

interface SimNode extends SimulationNodeDatum {
  id: string
  role: string
  narrativeOrder: number
  sectionId: string | null
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  edgeStyle: DiagramEdge['style']
}

// ── Force parameters ──────────────────────────────────────────────────────────

function linkDistance(style: DiagramEdge['style']): number {
  switch (style) {
    case 'containment': return 52   // kept short so children orbit containers
    case 'passage':     return 100
    case 'directed':    return 118
    case 'proximity':   return 82
    case 'compass':     return 130
    case 'movement':    return 138
    case 'uncertain':   return 108
  }
}

function linkStrength(style: DiagramEdge['style']): number {
  switch (style) {
    case 'containment': return 0.88 // strong — keeps containment hierarchy tight
    case 'directed':    return 0.55
    case 'passage':     return 0.50
    default:            return 0.40
  }
}

function chargeStrength(role: string): number {
  switch (role) {
    case 'hub':      return -580
    case 'origin':   return -420
    case 'inferred': return -160
    default:         return -230
  }
}

function collideRadius(role: string): number {
  // Sized so node box + label have clearance; hub label is wider
  return role === 'hub' ? 82 : 62
}

// ── Layout entry point ────────────────────────────────────────────────────────

export function computeLayout(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
): { positions: LayoutPositions; containmentMap: ContainmentMap } {
  if (nodes.length === 0) return { positions: {}, containmentMap: {} }

  // ── x-axis: narrative order ────────────────────────────────────────────────
  const maxOrder = Math.max(0, ...nodes.map(n => n.narrativeOrder))
  const xSpread  = SIM_W * 0.80
  const xOffset  = SIM_W * 0.10

  const targetX = (order: number) =>
    maxOrder > 0 ? xOffset + (order / maxOrder) * xSpread : SIM_W / 2

  // ── y-axis: section lanes ──────────────────────────────────────────────────
  // Build an ordered list of unique section IDs
  const orderedSections = [...new Set(
    nodes
      .filter(n => n.revealSectionId)
      .sort((a, b) => a.narrativeOrder - b.narrativeOrder || a.id.localeCompare(b.id))
      .map(n => n.revealSectionId!),
  )]

  const sectionTargetY = (sectionId: string | null): number => {
    if (!sectionId || orderedSections.length === 0) return SIM_H / 2
    if (orderedSections.length === 1) return SIM_H / 2
    const idx    = orderedSections.indexOf(sectionId)
    const count  = orderedSections.length
    // Distribute sections evenly within 60% of the viewport height
    const band   = SIM_H * 0.60
    const step   = band / Math.max(count - 1, 1)
    return SIM_H * 0.20 + idx * step
  }

  // ── Containment map (parent → children) ───────────────────────────────────
  const containmentMap: ContainmentMap = {}
  for (const edge of edges) {
    if (edge.style !== 'containment') continue
    // CONTAINS: "A contains B" → parent=source, child=target
    // LOCATED_IN / SURROUNDED_BY / IN_OR_ADJACENT_TO: "A is in B" → parent=target, child=source
    const isChildEdge = ['LOCATED_IN', 'SURROUNDED_BY', 'IN_OR_ADJACENT_TO'].includes(edge.predicate)
    const parentId = isChildEdge ? edge.target : edge.source
    const childId  = isChildEdge ? edge.source : edge.target
    if (!containmentMap[parentId]) containmentMap[parentId] = []
    if (!containmentMap[parentId].includes(childId)) containmentMap[parentId].push(childId)
  }

  // Map child → parent for initial position seeding
  const parentOf: Record<string, string> = {}
  for (const [parentId, children] of Object.entries(containmentMap)) {
    for (const childId of children) parentOf[childId] = parentId
  }

  // ── Initial positions ──────────────────────────────────────────────────────
  const positionOf = new Map(nodes.map((n, i) => [n.id, i]))

  const simNodes: SimNode[] = nodes.map((n, i) => {
    const parentId   = parentOf[n.id]
    const parentNode = parentId ? nodes.find(x => x.id === parentId) : null
    // Seed contained nodes near their container
    const seedX = parentNode
      ? targetX(parentNode.narrativeOrder) + ((i % 5) - 2) * 55
      : targetX(n.narrativeOrder) + ((i % 7) - 3) * 20
    const seedY = sectionTargetY(n.revealSectionId) + ((positionOf.get(n.id)! * 41) % 100) - 50

    return {
      id: n.id,
      role: n.role,
      narrativeOrder: n.narrativeOrder,
      sectionId: n.revealSectionId,
      x: seedX,
      y: seedY,
    }
  })

  const nodeSet = new Set(simNodes.map(n => n.id))
  const simLinks: SimLink[] = edges
    .filter(e => nodeSet.has(e.source) && nodeSet.has(e.target))
    .map(e => ({ source: e.source, target: e.target, edgeStyle: e.style }))

  // ── Custom scene-cluster force ─────────────────────────────────────────────
  // Gently pulls nodes toward their section's y-lane, reinforcing the cluster force.
  let _simNodes: SimNode[] = []
  const sceneClusterForce = Object.assign(
    (alpha: number) => {
      for (const n of _simNodes) {
        const ty = sectionTargetY(n.sectionId)
        n.vy = (n.vy ?? 0) + (ty - (n.y ?? SIM_H / 2)) * 0.022 * alpha
      }
    },
    // D3 force initialize receives (nodes, random) — random ignored here
    { initialize: (ns: SimNode[], _random?: () => number) => { _simNodes = ns } },
  )

  // ── Run simulation ─────────────────────────────────────────────────────────
  forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(simLinks)
        .id(d => d.id)
        .distance(d => linkDistance(d.edgeStyle))
        .strength(d => linkStrength(d.edgeStyle)),
    )
    .force('charge',  forceManyBody<SimNode>().strength(d => chargeStrength(d.role)))
    .force('center',  forceCenter(SIM_W / 2, SIM_H / 2).strength(0.07))
    .force('x',       forceX<SimNode>(d => targetX(d.narrativeOrder)).strength(0.07))
    .force('y',       forceY<SimNode>(d => sectionTargetY(d.sectionId)).strength(0.04))
    .force('collide', forceCollide<SimNode>(d => collideRadius(d.role)).strength(0.92))
    .force('cluster', sceneClusterForce)
    .stop()
    .tick(500)

  // ── Extract positions ──────────────────────────────────────────────────────
  const positions: LayoutPositions = {}
  for (const n of simNodes) {
    positions[n.id] = { x: n.x ?? SIM_W / 2, y: n.y ?? SIM_H / 2 }
  }

  return { positions, containmentMap }
}
