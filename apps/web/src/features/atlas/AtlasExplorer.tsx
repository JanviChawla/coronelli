import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import type { Node as RFNode, Edge as RFEdge, NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  forceSimulation, forceLink, forceManyBody, forceCenter,
  forceX, forceY, forceCollide,
} from 'd3-force'
import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force'

import { fetchAtlas } from './atlasApi'
import type { AtlasResponse, EntityMention } from './atlasApi'
import {
  buildDiagramViewModel,
  applyFilters,
  DEFAULT_FILTERS,
  PREDICATE_DESCRIPTIONS,
} from './atlasGraph'
import type {
  DiagramNode,
  DiagramEdge,
  DiagramViewModel,
  FilterState,
  InspectorTarget,
} from './atlasGraph'

// ── D3-force layout ───────────────────────────────────────────────────────────

// Node bounding-box dimensions for React Flow (circle + label)
const NODE_W = { hub: 130, normal: 110 }
const NODE_H = { hub: 100, normal: 84 }

function nodeSize(role: string): { w: number; h: number } {
  return role === 'hub'
    ? { w: NODE_W.hub, h: NODE_H.hub }
    : { w: NODE_W.normal, h: NODE_H.normal }
}

const SIM_W = 1000
const SIM_H = 700

interface SimNode extends SimulationNodeDatum {
  id: string
  role: string
  narrativeOrder: number
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  style: DiagramEdge['style']
}

function linkDistance(style: DiagramEdge['style']): number {
  switch (style) {
    case 'containment': return 60
    case 'passage':     return 90
    case 'directed':    return 110
    case 'proximity':   return 90
    case 'compass':     return 120
    case 'movement':    return 130
    case 'uncertain':   return 100
  }
}

function d3ForceLayout(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
): Record<string, { x: number; y: number }> {
  if (nodes.length === 0) return {}

  const maxOrder = Math.max(0, ...nodes.map(n => n.narrativeOrder))
  const xSpread  = SIM_W * 0.78
  const xOffset  = SIM_W * 0.11

  const targetX = (narrativeOrder: number) =>
    maxOrder > 0 ? xOffset + (narrativeOrder / maxOrder) * xSpread : SIM_W / 2

  // Deterministic vertical jitter so the force simulation can break symmetry
  const simNodes: SimNode[] = nodes.map((n, i) => ({
    id: n.id,
    role: n.role,
    narrativeOrder: n.narrativeOrder,
    x: targetX(n.narrativeOrder),
    y: SIM_H / 2 + ((i % 5) - 2) * (SIM_H / 6),
  }))

  const nodeSet = new Set(simNodes.map(n => n.id))
  const simLinks: SimLink[] = edges
    .filter(e => nodeSet.has(e.source) && nodeSet.has(e.target))
    .map(e => ({ source: e.source, target: e.target, style: e.style }))

  forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(simLinks)
        .id(d => d.id)
        .distance(d => linkDistance(d.style))
        .strength(0.7),
    )
    .force('charge', forceManyBody<SimNode>().strength(d => d.role === 'hub' ? -350 : -180))
    .force('center', forceCenter(SIM_W / 2, SIM_H / 2).strength(0.12))
    .force('x', forceX<SimNode>(d => targetX(d.narrativeOrder)).strength(maxOrder > 0 ? 0.15 : 0))
    .force('y', forceY<SimNode>(SIM_H / 2).strength(0.05))
    .force('collide', forceCollide<SimNode>(d => d.role === 'hub' ? 65 : 50).strength(0.85))
    .stop()
    .tick(400)

  const positions: Record<string, { x: number; y: number }> = {}
  for (const n of simNodes) {
    positions[n.id] = { x: n.x ?? SIM_W / 2, y: n.y ?? SIM_H / 2 }
  }
  return positions
}

// ── Schematic node ────────────────────────────────────────────────────────────

// Circle radii per role
const CIRCLE_R: Record<string, number> = { hub: 26, normal: 19, origin: 19, inferred: 19 }

function SchematicNode({ data, selected }: NodeProps) {
  const d = data as DiagramNode
  const r = CIRCLE_R[d.role] ?? 19
  const svgSize = r * 2 + 6
  const cx = svgSize / 2
  const cy = svgSize / 2

  const isInferred = d.role === 'inferred'
  const isHub     = d.role === 'hub'
  const isOrigin  = d.role === 'origin'

  const stroke     = selected ? '#c9a84c' : isInferred ? '#b8a898' : '#3d2a50'
  const fillOpacity = selected ? 0.12 : 0.06
  const fill       = `rgba(201,168,76,${fillOpacity})`

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      cursor: 'pointer', userSelect: 'none',
    }}>
      <Handle type="target" position={Position.Left}
        style={{ opacity: 0, width: 1, height: 1 }} />
      <svg
        width={svgSize} height={svgSize}
        style={{ overflow: 'visible', display: 'block' }}
      >
        {/* Outer glow when selected */}
        {selected && (
          <circle cx={cx} cy={cy} r={r + 4}
            fill="none" stroke="#c9a84c" strokeWidth={1} opacity={0.3} />
        )}
        {/* Main circle */}
        <circle
          cx={cx} cy={cy} r={r}
          stroke={stroke} strokeWidth={selected ? 2 : 1.5}
          strokeDasharray={isInferred ? '4 3' : undefined}
          fill={fill}
        />
        {/* Concentric ring for hub places */}
        {isHub && (
          <circle cx={cx} cy={cy} r={r - 6}
            fill="none" stroke={stroke} strokeWidth={0.75} opacity={0.5} />
        )}
        {/* Inner dot */}
        <circle cx={cx} cy={cy} r={isHub ? 4 : 3}
          fill={isInferred ? '#b8a898' : stroke}
        />
        {/* Origin return-loop indicator */}
        {isOrigin && (
          <text x={cx + r - 3} y={cy - r + 9}
            fontSize="9" fill={stroke} textAnchor="middle" dominantBaseline="middle"
            style={{ fontFamily: 'sans-serif' }}>
            ↺
          </text>
        )}
        {/* Inferred placement mark */}
        {isInferred && (
          <text x={cx + r - 1} y={cy - r + 10}
            fontSize="9" fill="#b8a898" textAnchor="middle" dominantBaseline="middle">
            ?
          </text>
        )}
      </svg>
      {/* Label */}
      <div style={{
        marginTop: '0.3rem',
        fontSize: isHub ? '0.74rem' : '0.68rem',
        fontWeight: isHub ? 600 : 500,
        color: isInferred ? '#9b8574' : '#2c1810',
        textAlign: 'center',
        maxWidth: isHub ? '130px' : '110px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontStyle: isInferred ? 'italic' : 'normal',
        letterSpacing: isHub ? '0.02em' : '0',
      }}>
        {d.label}
      </div>
      {d.placeKind && (
        <div style={{
          fontSize: '0.55rem',
          color: '#9b8574',
          textAlign: 'center',
          maxWidth: '110px',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          letterSpacing: '0.05em',
          textTransform: 'lowercase',
          marginTop: '0.05rem',
        }}>
          {d.placeKind}
        </div>
      )}
      <Handle type="source" position={Position.Right}
        style={{ opacity: 0, width: 1, height: 1 }} />
    </div>
  )
}

const nodeTypes = { place: SchematicNode }

// ── Edge styling ──────────────────────────────────────────────────────────────

type EdgePropsReturn = {
  type: 'smoothstep' | 'straight' | 'default'
  style: React.CSSProperties
  markerEnd?: { type: string; color: string; width: number; height: number }
  animated?: boolean
}

function edgeStyleProps(style: DiagramEdge['style']): EdgePropsReturn {
  switch (style) {
    case 'containment':
      return {
        type: 'smoothstep',
        style: { stroke: '#c0ad94', strokeWidth: 1.2, strokeDasharray: '6 4' },
      }
    case 'directed':
      return {
        type: 'smoothstep',
        style: { stroke: '#3d2a50', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#3d2a50', width: 11, height: 11 },
      }
    case 'passage':
      return {
        type: 'smoothstep',
        style: { stroke: '#c9a84c', strokeWidth: 1.5, strokeDasharray: '5 3' },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#c9a84c', width: 10, height: 10 },
      }
    case 'proximity':
      return {
        type: 'straight',
        style: { stroke: '#c9a84c', strokeWidth: 0.9, strokeDasharray: '2 6', opacity: 0.5 },
      }
    case 'compass':
      return {
        type: 'straight',
        style: { stroke: '#7a9ab5', strokeWidth: 1, strokeDasharray: '4 4' },
        markerEnd: { type: MarkerType.Arrow, color: '#7a9ab5', width: 10, height: 10 },
      }
    case 'movement':
      return {
        type: 'smoothstep',
        style: { stroke: '#9b8574', strokeWidth: 1.2, strokeDasharray: '8 5' },
        markerEnd: { type: MarkerType.Arrow, color: '#9b8574', width: 10, height: 10 },
      }
    case 'uncertain':
      return {
        type: 'smoothstep',
        style: { stroke: '#d4bc8a', strokeWidth: 0.9, strokeDasharray: '3 7', opacity: 0.35 },
      }
  }
}

// ── Inner diagram (needs ReactFlowProvider above it) ─────────────────────────

interface InnerProps {
  vm: DiagramViewModel
  filters: FilterState
  cursor: number
  sectionOrder: Map<string, number>
  onSelect: (t: InspectorTarget) => void
  allEntities: Map<string, { visualClaims: unknown[] }>
}

function InnerDiagram({ vm, filters, cursor, sectionOrder, onSelect, allEntities }: InnerProps) {
  const { fitView } = useReactFlow()
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }> | null>(null)
  const [rfNodes, setRfNodes] = useState<RFNode[]>([])
  const [rfEdges, setRfEdges] = useState<RFEdge[]>([])

  // Phase 1: run D3-force synchronously on the full graph for stable positions
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setPositions(null)
    const pos = d3ForceLayout(vm.nodes, vm.edges)
    setPositions(pos)
    setTimeout(() => fitView({ padding: 0.18, duration: 350 }), 50)
  }, [vm])

  // Phase 2: apply filter + cursor visibility without re-running ELK
  useEffect(() => {
    if (!positions) return

    const { nodes: filteredNodes, edges: filteredEdges } = applyFilters(vm, filters)
    const filteredNodeIds = new Set(filteredNodes.map(n => n.id))
    const filteredEdgeIds = new Set(filteredEdges.map(e => e.id))

    const visibleNodeIds = new Set<string>()
    for (const n of vm.nodes) {
      if (!filteredNodeIds.has(n.id)) continue
      const revealIdx = n.revealSectionId !== null
        ? (sectionOrder.get(n.revealSectionId) ?? 0)
        : 0
      if (revealIdx <= cursor) visibleNodeIds.add(n.id)
    }

    setRfNodes(vm.nodes.map(n => {
      const { w, h } = nodeSize(n.role)
      return {
        id: n.id,
        type: 'place',
        position: positions[n.id] ?? { x: 0, y: 0 },
        data: n,
        hidden: !visibleNodeIds.has(n.id),
        style: { width: w, height: h },
      }
    }))

    setRfEdges(vm.edges.map(e => {
      const ep = edgeStyleProps(e.style)
      const label = e.style === 'passage' && e.edgeLabel ? e.edgeLabel : undefined
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label,
        labelStyle: { fontSize: '0.58rem', fill: '#9b8574', fontFamily: 'NSimSun, monospace' },
        labelShowBg: !!label,
        labelBgStyle: { fill: '#f5ede0', fillOpacity: 0.9 },
        labelBgPadding: [3, 5] as [number, number],
        data: e,
        hidden: !filteredEdgeIds.has(e.id)
          || !visibleNodeIds.has(e.source)
          || !visibleNodeIds.has(e.target),
        ...ep,
      }
    }))
  }, [positions, vm, filters, cursor, sectionOrder])

  const onNodeClick = useCallback((_: unknown, node: RFNode) => {
    const diagNode = node.data as DiagramNode
    const entity = allEntities.get(diagNode.id)
    onSelect({
      kind: 'node',
      node: diagNode,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      visualClaims: (entity?.visualClaims ?? []) as any,
    })
  }, [allEntities, onSelect])

  const onEdgeClick = useCallback((_: unknown, edge: RFEdge) => {
    onSelect({ kind: 'edge', edge: edge.data as DiagramEdge })
  }, [onSelect])

  if (!positions) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-faint)', fontSize: '0.82rem' }}>
        Computing layout…
      </div>
    )
  }

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      onEdgeClick={onEdgeClick}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#d4bc8a" gap={24} size={0.8} style={{ opacity: 0.18 }} />
      <Controls style={{ background: 'var(--parchment-alt)', border: '1px solid var(--border-warm)' }} />
      <MiniMap
        style={{ background: 'var(--parchment-alt)', border: '1px solid var(--border-warm)' }}
        nodeColor={n => {
          const d = n.data as DiagramNode
          return d?.role === 'hub' ? '#3d2a50' : d?.role === 'origin' ? '#c9a84c' : '#b8a898'
        }}
        maskColor="rgba(245,237,224,0.65)"
      />
    </ReactFlow>
  )
}

// ── Filter bar ────────────────────────────────────────────────────────────────

const FILTER_LABELS: Array<[keyof FilterState, string]> = [
  ['places', 'Places'],
  ['passages', 'Passages'],
  ['containment', 'Containment'],
  ['relationships', 'Relationships'],
]

function FilterBar({ filters, onChange }: { filters: FilterState; onChange: (f: FilterState) => void }) {
  return (
    <div style={{
      position: 'absolute', top: '0.75rem', left: '50%', transform: 'translateX(-50%)',
      zIndex: 10, display: 'flex', gap: '0.5rem', background: 'var(--parchment)',
      border: '1px solid var(--border-warm)', borderRadius: '4px', padding: '0.3rem 0.65rem',
      fontSize: '0.68rem', color: 'var(--ink-muted)', boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
    }}>
      {FILTER_LABELS.map(([key, label]) => (
        <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={filters[key]}
            onChange={e => onChange({ ...filters, [key]: e.target.checked })}
            style={{ accentColor: '#c9a84c' }}
          />
          {label}
        </label>
      ))}
    </div>
  )
}

// ── Narrative scrubber ────────────────────────────────────────────────────────

function NarrativeScrubber({
  sections,
  cursor,
  onChange,
}: {
  sections: Array<{ id: string; title: string }>
  cursor: number
  onChange: (n: number) => void
}) {
  const total = sections.length
  if (total === 0) return null
  const section = sections[cursor]

  return (
    <div style={{
      position: 'absolute', bottom: '1.85rem', left: '50%', transform: 'translateX(-50%)',
      zIndex: 10, display: 'flex', alignItems: 'center', gap: '0.5rem',
      background: 'var(--parchment)', border: '1px solid var(--border-warm)',
      borderRadius: '4px', padding: '0.3rem 0.75rem',
      boxShadow: '0 1px 4px rgba(0,0,0,0.1)', userSelect: 'none',
    }}>
      <button
        onClick={() => onChange(Math.max(0, cursor - 1))}
        disabled={cursor === 0}
        aria-label="Previous section"
        style={{
          background: 'none', border: 'none', lineHeight: 1, padding: '0 0.15rem',
          fontSize: '1.1rem', cursor: cursor === 0 ? 'default' : 'pointer',
          color: cursor === 0 ? 'var(--ink-faint)' : 'var(--ink)',
        }}
      >‹</button>
      <span style={{ minWidth: '18rem', textAlign: 'center', fontSize: '0.68rem', color: 'var(--ink-muted)' }}>
        <span style={{ color: 'var(--gold)', marginRight: '0.45rem', fontSize: '0.62rem' }}>
          § {cursor + 1} / {total}
        </span>
        <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{section?.title ?? ''}</span>
      </span>
      <button
        onClick={() => onChange(Math.min(total - 1, cursor + 1))}
        disabled={cursor === total - 1}
        aria-label="Next section"
        style={{
          background: 'none', border: 'none', lineHeight: 1, padding: '0 0.15rem',
          fontSize: '1.1rem', cursor: cursor === total - 1 ? 'default' : 'pointer',
          color: cursor === total - 1 ? 'var(--ink-faint)' : 'var(--ink)',
        }}
      >›</button>
    </div>
  )
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend() {
  const dot = (color: string, dashed = false) => (
    <svg width={14} height={14} style={{ flexShrink: 0 }}>
      <circle cx={7} cy={7} r={6}
        stroke={color} strokeWidth={1.2}
        strokeDasharray={dashed ? '3 2' : undefined}
        fill="rgba(245,237,224,0.6)"
      />
      <circle cx={7} cy={7} r={2.5} fill={color} />
    </svg>
  )
  const line = (color: string, dash?: string, arrow = false) => (
    <svg width={22} height={10} style={{ flexShrink: 0 }}>
      <line x1={0} y1={5} x2={arrow ? 16 : 22} y2={5}
        stroke={color} strokeWidth={1.5}
        strokeDasharray={dash}
      />
      {arrow && <polygon points="16,2 22,5 16,8" fill={color} />}
    </svg>
  )

  return (
    <div style={{
      position: 'absolute', bottom: '2.5rem', left: '0.75rem', zIndex: 10,
      background: 'var(--parchment)', border: '1px solid var(--border-warm)',
      borderRadius: '4px', padding: '0.55rem 0.8rem', fontSize: '0.61rem',
      color: 'var(--ink-muted)', lineHeight: 2,
    }}>
      <div style={{ fontWeight: 600, marginBottom: '0.15rem', color: 'var(--ink)', fontSize: '0.63rem', letterSpacing: '0.07em', textTransform: 'uppercase' }}>Legend</div>
      {[
        [dot('#3d2a50'), 'Place'],
        [dot('#3d2a50', false), 'Hub (concentric ring + larger)'],
        [<svg key="o" width={14} height={14}><circle cx={7} cy={7} r={6} stroke="#c9a84c" strokeWidth={1.2} fill="rgba(201,168,76,0.1)"/><circle cx={7} cy={7} r={2.5} fill="#c9a84c"/><text x={12} y={4} fontSize="7" fill="#c9a84c">↺</text></svg>, 'Story origin'],
        [dot('#b8a898', true), 'Inferred / uncertain'],
        [line('#c9a84c', '5 3', true), 'Passage (door / portal)'],
        [line('#3d2a50', undefined, true), 'Leads to'],
        [line('#c0ad94', '6 4'), 'Contains / located in'],
        [line('#c9a84c', '2 6'), 'Adjacent / near'],
        [line('#7a9ab5', '4 4', true), 'Compass bearing'],
        [line('#9b8574', '8 5', true), 'Reached from'],
        [line('#d4bc8a', '3 7'), 'Uncertain connection'],
      ].map(([icon, label], i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
          {icon}
          <span>{label as string}</span>
        </div>
      ))}
    </div>
  )
}

// ── Disclaimer ────────────────────────────────────────────────────────────────

function Disclaimer() {
  return (
    <div style={{
      position: 'absolute', bottom: '0.3rem', left: '50%', transform: 'translateX(-50%)',
      zIndex: 10, fontSize: '0.58rem', color: 'var(--ink-faint)',
      letterSpacing: '0.04em', whiteSpace: 'nowrap', pointerEvents: 'none',
    }}>
      Topological schematic · curves communicate relationships, not distance, scale, or literal terrain
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  documentId: string
  sections: Array<{ id: string; title: string }>
  onSelect: (t: InspectorTarget) => void
  onAtlasLoaded: (entityCount: number) => void
  onCursorChange?: (cursor: number) => void
}

export function AtlasExplorer({ documentId, sections, onSelect, onAtlasLoaded, onCursorChange }: Props) {
  const [atlasData, setAtlasData] = useState<AtlasResponse | null>(null)
  const [vm, setVm] = useState<DiagramViewModel | null>(null)
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS)
  const [allEntities, setAllEntities] = useState<Map<string, { visualClaims: unknown[] }>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Start at the last section so all places are visible on open; scrubber lets you rewind
  const [cursor, setCursor] = useState(() => Math.max(0, sections.length - 1))

  const sectionOrder = useMemo(() => {
    const map = new Map<string, number>()
    sections.forEach((s, i) => map.set(s.id, i))
    return map
  }, [sections])

  // Load atlas data
  useEffect(() => {
    setLoading(true)
    setError(null)
    setCursor(sections.length > 0 ? sections.length - 1 : 0)
    onSelect(null)
    fetchAtlas(documentId)
      .then(atlas => {
        onAtlasLoaded(atlas.entity_count)
        setAtlasData(atlas)
        const map = new Map<string, { visualClaims: unknown[] }>()
        for (const e of atlas.entities) {
          map.set(e.id, { visualClaims: e.claims.filter(c => c.claim_type === 'visual') })
        }
        setAllEntities(map)
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load atlas'))
      .finally(() => setLoading(false))
  }, [documentId])

  // Rebuild diagram when atlas data or section order changes
  useEffect(() => {
    if (!atlasData) return
    setVm(buildDiagramViewModel(atlasData, sectionOrder))
  }, [atlasData, sectionOrder])

  // Arrow key navigation
  useEffect(() => {
    if (!sections.length) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        setCursor(c => Math.min(sections.length - 1, c + 1))
        e.preventDefault()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        setCursor(c => Math.max(0, c - 1))
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sections.length])

  // Propagate cursor to parent for inspector temporal state
  useEffect(() => {
    onCursorChange?.(cursor)
  }, [cursor, onCursorChange])

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-faint)', fontSize: '0.85rem' }}>
        Loading atlas…
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--error-text)', fontSize: '0.85rem' }}>
        {error}
      </div>
    )
  }

  if (!vm || vm.isEmpty) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-faint)', textAlign: 'center', gap: '0.5rem' }}>
        <div style={{ fontSize: '2rem', opacity: 0.2 }}>⊙</div>
        <p style={{ fontSize: '0.9rem' }}>No approved places yet.</p>
        <p style={{ fontSize: '0.78rem' }}>Complete synthesis in the workflow to build the atlas.</p>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <FilterBar filters={filters} onChange={setFilters} />
      <ReactFlowProvider>
        <InnerDiagram
          vm={vm}
          filters={filters}
          cursor={cursor}
          sectionOrder={sectionOrder}
          onSelect={onSelect}
          allEntities={allEntities}
        />
      </ReactFlowProvider>
      <Legend />
      <NarrativeScrubber sections={sections} cursor={cursor} onChange={setCursor} />
      <Disclaimer />
    </div>
  )
}

// ── Narrative thread sub-component ───────────────────────────────────────────

function NarrativeThread({
  entityId,
  cursor,
  entityMentions,
  sectionOrder,
  sectionTitles,
}: {
  entityId: string
  cursor: number
  entityMentions: EntityMention[]
  sectionOrder: Map<string, number>
  sectionTitles: Map<string, string>
}) {
  const visible = entityMentions
    .filter(m => m.entity_id === entityId)
    .filter(m => (sectionOrder.get(m.section_id) ?? Infinity) <= cursor)
    .sort((a, b) => a.section_ordinal - b.section_ordinal)

  if (visible.length === 0) return null

  return (
    <div style={{ marginTop: '1rem' }}>
      <div style={{
        fontSize: '0.6rem', color: 'var(--ink-faint)',
        letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '0.4rem',
      }}>
        Narrative thread
      </div>
      {visible.map(m => {
        const sectionIdx = sectionOrder.get(m.section_id) ?? 0
        const title = sectionTitles.get(m.section_id) ?? m.section_id
        return (
          <div key={m.id} style={{
            display: 'flex', alignItems: 'baseline', gap: '0.4rem',
            marginBottom: '0.22rem', fontSize: '0.74rem',
          }}>
            <span style={{ color: 'var(--gold)', minWidth: '2rem', flexShrink: 0, fontSize: '0.62rem' }}>
              §{sectionIdx + 1}
            </span>
            <span style={{ color: 'var(--ink)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {title}
            </span>
            <span style={{
              color: m.mention_kind === 'origin' ? 'var(--gold)' : 'var(--ink-faint)',
              fontSize: '0.6rem', flexShrink: 0, fontStyle: 'italic',
            }}>
              {m.mention_kind === 'origin' ? 'introduced' : 'referenced'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Inspector renderer (used by SourceLibrary) ────────────────────────────────

export function InspectorContent({
  target,
  sectionTitles,
  cursor = 0,
  entityMentions = [],
  sectionOrder = new Map(),
}: {
  target: InspectorTarget
  sectionTitles: Map<string, string>
  cursor?: number
  entityMentions?: EntityMention[]
  sectionOrder?: Map<string, number>
}) {
  if (!target) {
    return (
      <div style={{ textAlign: 'center', paddingTop: '2rem', color: 'var(--ink-faint)' }}>
        <div style={{ fontSize: '2.25rem', marginBottom: '0.85rem', opacity: 0.25 }}>⊙</div>
        <p style={{ fontSize: '0.8rem', lineHeight: 1.55 }}>
          Select a place or passage to inspect it.
        </p>
      </div>
    )
  }

  if (target.kind === 'node') {
    const { node, visualClaims } = target
    const sectionTitle = node.revealSectionId
      ? (sectionTitles.get(node.revealSectionId) ?? node.revealSectionId)
      : null

    const roleLabel =
      node.role === 'hub'      ? 'Hub place' :
      node.role === 'origin'   ? 'Story origin' :
      node.role === 'inferred' ? 'Inferred place' :
      node.placeKind ?? 'Place'

    return (
      <div style={{ fontSize: '0.8rem', lineHeight: 1.6 }}>
        <div style={{
          fontSize: '0.55rem', color: 'var(--ink-faint)',
          letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '0.25rem',
        }}>
          {roleLabel}
        </div>
        <h4 style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--ink)', marginBottom: '0.1rem' }}>
          {node.label}
        </h4>
        {node.placeKind && node.role !== 'inferred' && (
          <div style={{
            display: 'inline-block', fontSize: '0.62rem', color: 'var(--ink-muted)',
            background: 'var(--parchment-card)', border: '1px solid var(--border-warm)',
            borderRadius: '3px', padding: '0.1rem 0.4rem', marginBottom: '0.65rem',
          }}>
            {node.placeKind}
          </div>
        )}

        {node.aliases.length > 0 && (
          <p style={{ color: 'var(--ink-muted)', fontStyle: 'italic', marginBottom: '0.4rem' }}>
            Also known as: {node.aliases.join(', ')}
          </p>
        )}

        <Row label="Status"       value={node.status} />
        {sectionTitle && <Row label="First revealed" value={sectionTitle} />}
        <Row label="Relationships" value={String(node.claimCount)} />

        {(visualClaims as { payload: Record<string, unknown> }[]).length > 0 && (
          <div style={{ marginTop: '0.75rem' }}>
            <div style={{ fontSize: '0.6rem', color: 'var(--ink-faint)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '0.35rem' }}>
              Visual properties
            </div>
            {(visualClaims as { id: string; payload: Record<string, unknown> }[]).map(c => (
              <div key={c.id} style={{ marginBottom: '0.25rem', color: 'var(--ink-muted)' }}>
                <span style={{ fontWeight: 500, color: 'var(--ink)' }}>
                  {String(c.payload.visual_property ?? '')}:
                </span>{' '}
                {String(c.payload.value ?? '')}
              </div>
            ))}
          </div>
        )}

        <NarrativeThread
          entityId={node.id}
          cursor={cursor}
          entityMentions={entityMentions}
          sectionOrder={sectionOrder}
          sectionTitles={sectionTitles}
        />
      </div>
    )
  }

  // Edge inspector
  const { edge } = target
  const desc = PREDICATE_DESCRIPTIONS[edge.predicate]
  return (
    <div style={{ fontSize: '0.8rem', lineHeight: 1.6 }}>
      <div style={{
        fontSize: '0.55rem', color: 'var(--ink-faint)',
        letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '0.25rem',
      }}>
        {edge.style === 'passage' ? 'Passage' : 'Spatial relationship'}
      </div>
      <h4 style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--ink)', marginBottom: '0.1rem' }}>
        {edge.edgeLabel ?? edge.predicate}
      </h4>
      {edge.edgeLabel && (
        <div style={{ fontSize: '0.62rem', color: 'var(--ink-faint)', fontFamily: 'monospace', marginBottom: '0.45rem' }}>
          {edge.predicate}
        </div>
      )}
      {desc && <p style={{ color: 'var(--ink-muted)', marginBottom: '0.65rem', fontSize: '0.77rem' }}>{desc}</p>}

      <Row label="From" value={edge.sourceName} />
      <Row label="To"   value={edge.targetName} />

      {edge.excerpt && (
        <blockquote style={{
          margin: '0.75rem 0 0',
          padding: '0.5rem 0.65rem',
          borderLeft: '2px solid var(--gold)',
          background: 'var(--parchment-card)',
          color: 'var(--ink-muted)',
          fontSize: '0.75rem',
          fontStyle: 'italic',
          borderRadius: '0 3px 3px 0',
        }}>
          "{edge.excerpt}"
        </blockquote>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.2rem' }}>
      <span style={{ color: 'var(--ink-faint)', minWidth: '6rem', fontSize: '0.72rem' }}>{label}</span>
      <span style={{ color: 'var(--ink)', fontSize: '0.78rem' }}>{value}</span>
    </div>
  )
}
