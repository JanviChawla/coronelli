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
// @ts-ignore — elk.bundled.js has no separate type entry; elkjs types cover the API
import ELK from 'elkjs/lib/elk.bundled.js'

import { fetchAtlas } from './atlasApi'
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

// ── ELK layout ────────────────────────────────────────────────────────────────

const elk = new ELK()

const NODE_W: Record<string, number> = { place: 180, transition: 130 }
const NODE_H: Record<string, number> = { place: 52, transition: 38 }

async function elkLayout(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
): Promise<Record<string, { x: number; y: number }>> {
  if (nodes.length === 0) return {}
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '48',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    },
    children: nodes.map(n => ({
      id: n.id,
      width: NODE_W[n.kind],
      height: NODE_H[n.kind],
    })),
    edges: edges.map(e => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  }

  const laid = await elk.layout(graph)
  const positions: Record<string, { x: number; y: number }> = {}
  for (const child of laid.children ?? []) {
    positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 }
  }
  return positions
}

// ── Custom nodes ──────────────────────────────────────────────────────────────

function PlaceNode({ data, selected }: NodeProps) {
  const d = data as DiagramNode
  return (
    <div style={{
      width: NODE_W.place,
      padding: '0.35rem 0.65rem',
      background: selected ? '#e8dcc8' : '#f5ede0',
      border: `1.5px solid ${selected ? '#c9a84c' : '#d4bc8a'}`,
      borderRadius: '4px',
      fontSize: '0.72rem',
      color: '#2c1810',
      textAlign: 'center',
      cursor: 'pointer',
      boxShadow: selected ? '0 0 0 2px rgba(201,168,76,0.35)' : '0 1px 3px rgba(0,0,0,0.08)',
    }}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {d.label}
      </div>
      {d.placeKind && (
        <div style={{ fontSize: '0.58rem', color: '#9b8574', marginTop: '0.05rem' }}>
          {d.placeKind}
        </div>
      )}
      {d.nestedCount > 0 && (
        <div style={{ fontSize: '0.56rem', color: '#c9a84c', marginTop: '0.05rem' }}>
          {d.nestedCount} nested
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  )
}

function TransitionNode({ data, selected }: NodeProps) {
  const d = data as DiagramNode
  return (
    <div style={{
      width: NODE_W.transition,
      padding: '0.3rem 0.55rem',
      background: selected ? '#3d2d50' : '#2d1b3d',
      border: `1.5px solid ${selected ? '#c9a84c' : '#5d4d70'}`,
      borderRadius: '3px',
      fontSize: '0.66rem',
      color: '#e8dcc8',
      textAlign: 'center',
      cursor: 'pointer',
      boxShadow: selected ? '0 0 0 2px rgba(201,168,76,0.35)' : '0 1px 3px rgba(0,0,0,0.12)',
    }}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {d.label}
      </div>
      {d.placeKind && (
        <div style={{ fontSize: '0.56rem', color: '#a090b8', marginTop: '0.04rem' }}>
          {d.placeKind}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  )
}

const nodeTypes = { place: PlaceNode, transition: TransitionNode }

// ── Edge styling ──────────────────────────────────────────────────────────────

function edgeProps(style: DiagramEdge['style']) {
  switch (style) {
    case 'containment':
      return {
        type: 'smoothstep' as const,
        style: { stroke: '#b8a898', strokeWidth: 1.5, strokeDasharray: '5 3' },
        markerEnd: undefined as undefined,
      }
    case 'directional':
      return {
        type: 'smoothstep' as const,
        style: { stroke: '#2d1b3d', strokeWidth: 1.8 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#2d1b3d', width: 14, height: 14 },
      }
    case 'proximity':
      return {
        type: 'straight' as const,
        style: { stroke: '#c9a84c', strokeWidth: 1, strokeDasharray: '2 5', opacity: 0.55 },
        markerEnd: undefined as undefined,
      }
    case 'movement':
      return {
        type: 'smoothstep' as const,
        style: { stroke: '#6b5744', strokeWidth: 1.2, strokeDasharray: '6 4' },
        markerEnd: { type: MarkerType.Arrow, color: '#6b5744', width: 12, height: 12 },
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
  const [laying, setLaying] = useState(true)

  // Phase 1: run ELK once on the full graph for stable positions
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setLaying(true)
    elkLayout(vm.nodes, vm.edges).then(pos => {
      setPositions(pos)
      setLaying(false)
      setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50)
    })
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
      // Null revealSectionId → treat as revealed at section 0 (show from start)
      const revealIdx = n.revealSectionId !== null
        ? (sectionOrder.get(n.revealSectionId) ?? 0)
        : 0
      if (revealIdx <= cursor) visibleNodeIds.add(n.id)
    }

    setRfNodes(vm.nodes.map(n => ({
      id: n.id,
      type: n.kind,
      position: positions[n.id] ?? { x: 0, y: 0 },
      data: n,
      hidden: !visibleNodeIds.has(n.id),
    })))

    setRfEdges(vm.edges.map(e => {
      const ep = edgeProps(e.style)
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.predicate,
        labelStyle: { fontSize: '0.6rem', fill: '#9b8574' },
        labelShowBg: true,
        labelBgStyle: { fill: '#f5ede0', fillOpacity: 0.85 },
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

  if (laying) {
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
      fitViewOptions={{ padding: 0.15 }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#d4bc8a" gap={20} size={1} style={{ opacity: 0.25 }} />
      <Controls style={{ background: 'var(--parchment-alt)', border: '1px solid var(--border-warm)' }} />
      <MiniMap
        style={{ background: 'var(--parchment-alt)', border: '1px solid var(--border-warm)' }}
        nodeColor={n => (n.type === 'transition' ? '#2d1b3d' : '#d4bc8a')}
        maskColor="rgba(245,237,224,0.65)"
      />
    </ReactFlow>
  )
}

// ── Filter bar ────────────────────────────────────────────────────────────────

const FILTER_LABELS: (keyof FilterState)[] = ['places', 'transitions', 'containment', 'relationships']

function FilterBar({ filters, onChange }: { filters: FilterState; onChange: (f: FilterState) => void }) {
  return (
    <div style={{
      position: 'absolute', top: '0.75rem', left: '50%', transform: 'translateX(-50%)',
      zIndex: 10, display: 'flex', gap: '0.5rem', background: 'var(--parchment)',
      border: '1px solid var(--border-warm)', borderRadius: '4px', padding: '0.3rem 0.65rem',
      fontSize: '0.68rem', color: 'var(--ink-muted)', boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
    }}>
      {FILTER_LABELS.map(key => (
        <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={filters[key]}
            onChange={e => onChange({ ...filters, [key]: e.target.checked })}
            style={{ accentColor: '#c9a84c' }}
          />
          {key.charAt(0).toUpperCase() + key.slice(1)}
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
      >
        ‹
      </button>
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
      >
        ›
      </button>
    </div>
  )
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div style={{
      position: 'absolute', bottom: '2.5rem', left: '0.75rem', zIndex: 10,
      background: 'var(--parchment)', border: '1px solid var(--border-warm)',
      borderRadius: '4px', padding: '0.5rem 0.75rem', fontSize: '0.62rem',
      color: 'var(--ink-muted)', lineHeight: 1.7,
    }}>
      <div style={{ fontWeight: 600, marginBottom: '0.25rem', color: 'var(--ink)', fontSize: '0.65rem', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Legend</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <div style={{ width: 14, height: 10, background: 'var(--parchment-card)', border: '1px solid #d4bc8a', borderRadius: 2 }} />
        Place
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <div style={{ width: 14, height: 10, background: '#2d1b3d', borderRadius: 2 }} />
        Transition
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <div style={{ width: 20, height: 1, background: '#2d1b3d', borderTop: '2px solid #2d1b3d' }} />
        Leads to / opens
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <div style={{ width: 20, height: 0, borderTop: '1.5px dashed #b8a898' }} />
        Contains
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <div style={{ width: 20, height: 0, borderTop: '1px dotted #c9a84c' }} />
        Adjacent / near
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <div style={{ width: 20, height: 0, borderTop: '1px dashed #6b5744' }} />
        Reached from
      </div>
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
      Topological composition of approved spatial relationships. Distance and orientation are not implied.
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  documentId: string
  sections: Array<{ id: string; title: string }>
  onSelect: (t: InspectorTarget) => void
  onAtlasLoaded: (entityCount: number) => void
}

export function AtlasExplorer({ documentId, sections, onSelect, onAtlasLoaded }: Props) {
  const [vm, setVm] = useState<DiagramViewModel | null>(null)
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS)
  const [allEntities, setAllEntities] = useState<Map<string, { visualClaims: unknown[] }>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)

  // Map from section id → index in the sections array (= narrative order)
  const sectionOrder = useMemo(() => {
    const map = new Map<string, number>()
    sections.forEach((s, i) => map.set(s.id, i))
    return map
  }, [sections])

  useEffect(() => {
    setLoading(true)
    setError(null)
    setCursor(0)
    onSelect(null)
    fetchAtlas(documentId)
      .then(atlas => {
        onAtlasLoaded(atlas.entity_count)
        setVm(buildDiagramViewModel(atlas))
        const map = new Map<string, { visualClaims: unknown[] }>()
        for (const e of atlas.entities) {
          map.set(e.id, { visualClaims: e.claims.filter(c => c.claim_type === 'visual') })
        }
        setAllEntities(map)
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load atlas'))
      .finally(() => setLoading(false))
  }, [documentId])

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
        <p style={{ fontSize: '0.78rem' }}>Review and approve synthesis items in the workflow to build the atlas.</p>
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

// ── Inspector renderer (used by SourceLibrary) ────────────────────────────────

export function InspectorContent({
  target,
  sectionTitles,
}: {
  target: InspectorTarget
  sectionTitles: Map<string, string>
}) {
  if (!target) {
    return (
      <div style={{ textAlign: 'center', paddingTop: '2rem', color: 'var(--ink-faint)' }}>
        <div style={{ fontSize: '2.25rem', marginBottom: '0.85rem', opacity: 0.25 }}>⊙</div>
        <p style={{ fontSize: '0.8rem', lineHeight: 1.55 }}>
          Select a place, route, or source detail to inspect it.
        </p>
      </div>
    )
  }

  if (target.kind === 'node') {
    const { node, visualClaims } = target
    const sectionTitle = node.revealSectionId
      ? (sectionTitles.get(node.revealSectionId) ?? node.revealSectionId)
      : null

    return (
      <div style={{ fontSize: '0.8rem', lineHeight: 1.6 }}>
        <div style={{
          fontSize: '0.55rem', color: 'var(--ink-faint)',
          letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '0.25rem',
        }}>
          {node.kind === 'transition' ? 'Transition feature' : 'Place'}
        </div>
        <h4 style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--ink)', marginBottom: '0.1rem' }}>
          {node.label}
        </h4>
        {node.placeKind && (
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

        <Row label="Status" value={node.status} />
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
        Spatial relationship
      </div>
      <h4 style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--ink)', marginBottom: '0.5rem', fontFamily: 'monospace' }}>
        {edge.predicate}
      </h4>
      {desc && <p style={{ color: 'var(--ink-muted)', marginBottom: '0.65rem', fontSize: '0.77rem' }}>{desc}</p>}

      <Row label="Subject" value={edge.sourceName} />
      <Row label="Object" value={edge.targetName} />

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
