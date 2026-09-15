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
  getBezierPath,
} from '@xyflow/react'
import type { Node as RFNode, Edge as RFEdge, NodeProps, EdgeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { fetchAtlas, fetchEntityMentions } from './atlasApi'
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
import { computeLayout } from './atlasLayout'
import type { ContainmentMap } from './atlasLayout'

// ── Node dimensions ───────────────────────────────────────────────────────────

const NODE_W = { hub: 140, normal: 116, inferred: 110 }
const NODE_H = { hub: 108, normal: 92,  inferred: 86  }

function nodeSize(role: string): { w: number; h: number } {
  if (role === 'hub')      return { w: NODE_W.hub,      h: NODE_H.hub }
  if (role === 'inferred') return { w: NODE_W.inferred, h: NODE_H.inferred }
  return                          { w: NODE_W.normal,   h: NODE_H.normal }
}

// ── Containment hull node ─────────────────────────────────────────────────────

interface HullData {
  label: string
  depth: number
}

function HullNode({ data }: NodeProps) {
  const { label, depth } = data as HullData
  const opacity = Math.max(0.07, 0.14 - depth * 0.04)
  const strokeOpacity = Math.max(0.22, 0.35 - depth * 0.06)

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        borderRadius: '14px',
        border: `1.5px dashed rgba(201,168,76,${strokeOpacity})`,
        background: `rgba(201,168,76,${opacity})`,
        pointerEvents: 'none',
        position: 'relative',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: '0.5rem',
          left: '0.85rem',
          fontSize: '0.56rem',
          color: `rgba(107,87,68,${0.55 + depth * 0.1})`,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontStyle: 'italic',
          userSelect: 'none',
          pointerEvents: 'none',
          maxWidth: 'calc(100% - 1.7rem)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </div>
  )
}

// ── Schematic place node ──────────────────────────────────────────────────────

const CIRCLE_R: Record<string, number> = { hub: 28, normal: 20, origin: 20, inferred: 17 }

// Label is positioned to the right of the circle for all non-hub nodes
// to avoid vertical stacking and overlap with nearby nodes.
// Hub nodes are prominent enough that a below-label reads cleanly at larger size.

function SchematicNode({ data, selected }: NodeProps) {
  const d     = data as DiagramNode
  const r     = CIRCLE_R[d.role] ?? 20
  const isHub      = d.role === 'hub'
  const isInferred = d.role === 'inferred'
  const isOrigin   = d.role === 'origin'

  const svgSize = r * 2 + 8
  const cx = svgSize / 2
  const cy = svgSize / 2

  const strokeColor = selected
    ? '#c9a84c'
    : isInferred ? '#b0a090' : '#3d2a50'
  const fillOpacity = selected ? 0.15 : 0.07
  const fill = `rgba(201,168,76,${fillOpacity})`

  // Label to the right for normal/origin/inferred; below for hub
  const labelRight = !isHub

  const labelStyle: React.CSSProperties = labelRight
    ? {
        position: 'absolute',
        left: svgSize + 6,
        top: '50%',
        transform: 'translateY(-50%)',
        fontSize: isInferred ? '0.65rem' : '0.70rem',
        fontWeight: isHub ? 700 : 500,
        color: isInferred ? '#9b8574' : '#2c1810',
        fontStyle: isInferred ? 'italic' : 'normal',
        letterSpacing: isHub ? '0.03em' : '0',
        whiteSpace: 'nowrap',
        maxWidth: '110px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        lineHeight: 1.25,
      }
    : {
        marginTop: '0.25rem',
        fontSize: '0.76rem',
        fontWeight: 700,
        color: '#2c1810',
        textAlign: 'center' as const,
        letterSpacing: '0.03em',
        maxWidth: `${NODE_W.hub}px`,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }

  const subStyle: React.CSSProperties = labelRight
    ? {
        position: 'absolute',
        left: svgSize + 6,
        top: `calc(50% + ${isInferred ? 10 : 11}px)`,
        fontSize: '0.54rem',
        color: '#9b8574',
        textTransform: 'lowercase' as const,
        letterSpacing: '0.04em',
        whiteSpace: 'nowrap',
      }
    : {
        fontSize: '0.58rem',
        color: '#9b8574',
        textAlign: 'center' as const,
        textTransform: 'lowercase' as const,
        letterSpacing: '0.04em',
        marginTop: '0.05rem',
      }

  const wrapStyle: React.CSSProperties = labelRight
    ? {
        display: 'flex',
        alignItems: 'center',
        cursor: 'pointer',
        userSelect: 'none',
        position: 'relative',
        width: `${NODE_W.normal}px`,
        height: `${svgSize}px`,
      }
    : {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        cursor: 'pointer',
        userSelect: 'none',
      }

  return (
    <div style={wrapStyle}>
      <Handle type="target" position={Position.Left}  style={{ opacity: 0, width: 1, height: 1 }} />

      <svg
        width={svgSize}
        height={svgSize}
        style={{ overflow: 'visible', display: 'block', flexShrink: 0 }}
      >
        {/* Selection glow */}
        {selected && (
          <circle cx={cx} cy={cy} r={r + 5}
            fill="none" stroke="#c9a84c" strokeWidth={1.2} opacity={0.35} />
        )}

        {/* Main circle */}
        <circle
          cx={cx} cy={cy} r={r}
          stroke={strokeColor}
          strokeWidth={selected ? 2.2 : isHub ? 1.8 : 1.5}
          strokeDasharray={isInferred ? '4 3' : undefined}
          fill={fill}
        />

        {/* Hub concentric ring */}
        {isHub && (
          <circle cx={cx} cy={cy} r={r - 7}
            fill="none" stroke={strokeColor} strokeWidth={0.8} opacity={0.45} />
        )}

        {/* Center dot */}
        <circle cx={cx} cy={cy}
          r={isHub ? 4.5 : 3}
          fill={isInferred ? '#b0a090' : strokeColor}
        />

        {/* Origin return-loop mark */}
        {isOrigin && (
          <text x={cx + r - 2} y={cy - r + 10}
            fontSize="9" fill={strokeColor}
            textAnchor="middle" dominantBaseline="middle"
            style={{ fontFamily: 'sans-serif' }}>↺</text>
        )}

        {/* Inferred uncertainty mark */}
        {isInferred && (
          <text x={cx + r - 1} y={cy - r + 10}
            fontSize="9" fill="#b0a090"
            textAnchor="middle" dominantBaseline="middle">?</text>
        )}
      </svg>

      {/* Place label */}
      <div style={labelStyle}>{d.label}</div>

      {/* Place kind sub-label */}
      {d.placeKind && (
        <div style={subStyle}>{d.placeKind}</div>
      )}

      <Handle type="source" position={Position.Right} style={{ opacity: 0, width: 1, height: 1 }} />
    </div>
  )
}

// ── Passage edge — custom bezier with animated dash ───────────────────────────
// Route treatment: passages are prominent gold curves (slightly arcing) to read
// as physical routes distinct from relational arrows.

function PassageEdge({
  sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, markerEnd, data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    curvature: 0.3,
  })
  const edgeLabel = (data as DiagramEdge | undefined)?.edgeLabel

  return (
    <>
      {/* Wider faint underline for road feel */}
      <path
        d={edgePath}
        stroke="#c9a84c"
        strokeWidth={5}
        fill="none"
        opacity={0.08}
      />
      {/* Animated dash */}
      <path
        d={edgePath}
        stroke="#c9a84c"
        strokeWidth={1.8}
        strokeDasharray="7 5"
        fill="none"
        markerEnd={markerEnd}
        className="atlas-passage-edge"
      />
      {edgeLabel && (
        <foreignObject
          x={labelX - 38}
          y={labelY - 10}
          width={76}
          height={20}
          style={{ pointerEvents: 'none' }}
        >
          <div style={{
            fontSize: '0.55rem',
            color: '#9b8574',
            background: 'rgba(245,237,224,0.92)',
            border: '1px solid rgba(201,168,76,0.3)',
            borderRadius: '3px',
            padding: '0.05rem 0.35rem',
            whiteSpace: 'nowrap',
            textAlign: 'center',
            letterSpacing: '0.05em',
            fontStyle: 'italic',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {edgeLabel}
          </div>
        </foreignObject>
      )}
    </>
  )
}

const nodeTypes = { place: SchematicNode, hull: HullNode }
const edgeTypes = { passage: PassageEdge }

// ── Edge styling (non-passage) ────────────────────────────────────────────────

type EdgePropsReturn = {
  type: 'smoothstep' | 'straight' | 'default' | 'passage'
  style: React.CSSProperties
  markerEnd?: { type: string; color: string; width: number; height: number }
}

function edgeStyleProps(style: DiagramEdge['style']): EdgePropsReturn {
  switch (style) {
    case 'containment':
      return { type: 'smoothstep', style: { stroke: '#c0ad94', strokeWidth: 1, strokeDasharray: '5 5', opacity: 0.6 } }
    case 'directed':
      return {
        type: 'smoothstep', style: { stroke: '#3d2a50', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#3d2a50', width: 11, height: 11 },
      }
    case 'passage':
      return { type: 'passage', style: {} }
    case 'proximity':
      return { type: 'straight', style: { stroke: '#c9a84c', strokeWidth: 0.9, strokeDasharray: '2 8', opacity: 0.45 } }
    case 'compass':
      return {
        type: 'straight', style: { stroke: '#7a9ab5', strokeWidth: 1, strokeDasharray: '4 4' },
        markerEnd: { type: MarkerType.Arrow, color: '#7a9ab5', width: 10, height: 10 },
      }
    case 'movement':
      return {
        type: 'smoothstep', style: { stroke: '#9b8574', strokeWidth: 1.2, strokeDasharray: '8 5' },
        markerEnd: { type: MarkerType.Arrow, color: '#9b8574', width: 10, height: 10 },
      }
    case 'uncertain':
      return { type: 'smoothstep', style: { stroke: '#d4bc8a', strokeWidth: 0.9, strokeDasharray: '3 8', opacity: 0.30 } }
  }
}

// ── Inner diagram ─────────────────────────────────────────────────────────────

interface InnerProps {
  vm: DiagramViewModel
  positions: Record<string, { x: number; y: number }> | null
  containmentMap: ContainmentMap
  filters: FilterState
  cursor: number
  sectionOrder: Map<string, number>
  onSelect: (t: InspectorTarget) => void
  allEntities: Map<string, { visualClaims: unknown[] }>
}

function InnerDiagram({
  vm, positions, containmentMap, filters, cursor, sectionOrder, onSelect, allEntities,
}: InnerProps) {
  const { fitView } = useReactFlow()
  const [rfNodes, setRfNodes] = useState<RFNode[]>([])
  const [rfEdges, setRfEdges] = useState<RFEdge[]>([])

  // Rebuild RF graph whenever layout positions or cursor/filters change
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

    // ── Hull nodes (containment background shapes) ─────────────────────────
    const hullNodes: RFNode[] = []
    if (filters.containment) {
      for (const [containerId, childIds] of Object.entries(containmentMap)) {
        // Only draw hull if container itself is visible
        if (!visibleNodeIds.has(containerId)) continue
        const visibleChildren = childIds.filter(id => visibleNodeIds.has(id))
        if (visibleChildren.length === 0) continue

        const members = [containerId, ...visibleChildren]
        const pad = 44
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const id of members) {
          const pos = positions[id]
          if (!pos) continue
          const role = vm.nodes.find(n => n.id === id)?.role ?? 'normal'
          const { w, h } = nodeSize(role)
          minX = Math.min(minX, pos.x - pad)
          minY = Math.min(minY, pos.y - pad)
          maxX = Math.max(maxX, pos.x + w + pad)
          maxY = Math.max(maxY, pos.y + h + pad)
        }
        if (!isFinite(minX)) continue

        const containerNode = vm.nodes.find(n => n.id === containerId)
        hullNodes.push({
          id: `hull-${containerId}`,
          type: 'hull',
          position: { x: minX, y: minY },
          style: { width: maxX - minX, height: maxY - minY },
          data: { label: containerNode?.label ?? '', depth: 0 },
          selectable: false,
          focusable: false,
          draggable: false,
          zIndex: -2,
        })
      }
    }

    // ── Place nodes ────────────────────────────────────────────────────────
    const placeNodes: RFNode[] = vm.nodes.map(n => {
      const { w, h } = nodeSize(n.role)
      return {
        id: n.id,
        type: 'place',
        position: positions[n.id] ?? { x: 0, y: 0 },
        data: n,
        hidden: !visibleNodeIds.has(n.id),
        style: { width: w, height: h },
        zIndex: 1,
      }
    })

    setRfNodes([...hullNodes, ...placeNodes])

    // ── Edges ──────────────────────────────────────────────────────────────
    setRfEdges(vm.edges.map(e => {
      const ep = edgeStyleProps(e.style)
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: ep.type,
        style: ep.style,
        markerEnd: ep.markerEnd,
        label: undefined,          // passage labels rendered inside custom edge
        data: e,
        hidden: !filteredEdgeIds.has(e.id)
          || !visibleNodeIds.has(e.source)
          || !visibleNodeIds.has(e.target),
        zIndex: 0,
      }
    }))

    setTimeout(() => fitView({ padding: 0.14, duration: 350 }), 60)
  }, [positions, vm, filters, cursor, sectionOrder, containmentMap, fitView])

  const onNodeClick = useCallback((_: unknown, node: RFNode) => {
    if (node.type === 'hull') return
    const diagNode = node.data as DiagramNode
    const entity = allEntities.get(diagNode.id)
    onSelect({
      kind: 'node', node: diagNode,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      visualClaims: (entity?.visualClaims ?? []) as any,
    })
  }, [allEntities, onSelect])

  const onEdgeClick = useCallback((_: unknown, edge: RFEdge) => {
    onSelect({ kind: 'edge', edge: edge.data as DiagramEdge })
  }, [onSelect])

  const onPaneClick = useCallback(() => { onSelect(null) }, [onSelect])

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
      edgeTypes={edgeTypes}
      onNodeClick={onNodeClick}
      onEdgeClick={onEdgeClick}
      onPaneClick={onPaneClick}
      fitView
      fitViewOptions={{ padding: 0.14 }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#d4bc8a" gap={28} size={0.7} style={{ opacity: 0.14 }} />
      <Controls
        style={{ background: 'var(--parchment-alt)', border: '1px solid var(--border-warm)' }}
      />
      <MiniMap
        style={{ background: 'var(--parchment-alt)', border: '1px solid var(--border-warm)' }}
        nodeColor={n => {
          if (n.type === 'hull') return 'transparent'
          const d = n.data as DiagramNode
          return d?.role === 'hub' ? '#3d2a50'
            : d?.role === 'origin' ? '#c9a84c'
            : d?.role === 'inferred' ? '#c0b5a8'
            : '#9b8574'
        }}
        maskColor="rgba(245,237,224,0.72)"
      />
    </ReactFlow>
  )
}

// ── Filter bar ────────────────────────────────────────────────────────────────

const FILTER_LABELS: Array<[keyof FilterState, string]> = [
  ['places',        'Places'],
  ['passages',      'Passages'],
  ['containment',   'Containment'],
  ['relationships', 'Relations'],
]

function FilterBar({ filters, onChange }: { filters: FilterState; onChange: (f: FilterState) => void }) {
  return (
    <div className="atlas-overlay atlas-filter-bar" role="toolbar" aria-label="Filter atlas elements">
      {FILTER_LABELS.map(([key, label]) => (
        <label key={key} className="atlas-filter-item">
          <input
            type="checkbox"
            checked={filters[key]}
            onChange={e => onChange({ ...filters, [key]: e.target.checked })}
            className="atlas-filter-check"
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
  )
}

// ── Narrative scrubber ────────────────────────────────────────────────────────

function NarrativeScrubber({
  sections, cursor, onChange,
}: {
  sections: Array<{ id: string; title: string }>
  cursor: number
  onChange: (n: number) => void
}) {
  const total = sections.length
  if (total === 0) return null
  const section = sections[cursor]

  return (
    <div className="atlas-overlay atlas-scrubber" role="navigation" aria-label="Narrative scrubber">
      <button
        onClick={() => onChange(Math.max(0, cursor - 1))}
        disabled={cursor === 0}
        aria-label="Previous section"
        className="atlas-scrubber-btn"
      >‹</button>
      <span className="atlas-scrubber-label">
        <span className="atlas-scrubber-ordinal">§ {cursor + 1} / {total}</span>
        <span className="atlas-scrubber-title">{section?.title ?? ''}</span>
      </span>
      <button
        onClick={() => onChange(Math.min(total - 1, cursor + 1))}
        disabled={cursor === total - 1}
        aria-label="Next section"
        className="atlas-scrubber-btn"
      >›</button>
    </div>
  )
}

// ── Legend ────────────────────────────────────────────────────────────────────
// All symbols hand-authored as inline SVG — no generated art.

function LegendDot({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <svg width={14} height={14} aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx={7} cy={7} r={5.5}
        stroke={color} strokeWidth={1.3}
        strokeDasharray={dashed ? '3 2' : undefined}
        fill="rgba(245,237,224,0.5)"
      />
      <circle cx={7} cy={7} r={2} fill={color} />
    </svg>
  )
}

function LegendLine({ color, dash, arrow }: { color: string; dash?: string; arrow?: boolean }) {
  return (
    <svg width={22} height={10} aria-hidden="true" style={{ flexShrink: 0 }}>
      <line x1={1} y1={5} x2={arrow ? 15 : 21} y2={5}
        stroke={color} strokeWidth={1.5} strokeDasharray={dash} />
      {arrow && <polygon points="15,2 21,5 15,8" fill={color} />}
    </svg>
  )
}

function LegendOrigin() {
  return (
    <svg width={14} height={14} aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx={7} cy={7} r={5.5} stroke="#c9a84c" strokeWidth={1.3} fill="rgba(201,168,76,0.1)" />
      <circle cx={7} cy={7} r={2} fill="#c9a84c" />
      <text x={12} y={4} fontSize="7" fill="#c9a84c" style={{ fontFamily: 'sans-serif' }}>↺</text>
    </svg>
  )
}

function LegendHull() {
  return (
    <svg width={22} height={14} aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x={1} y={1} width={20} height={12} rx={3}
        stroke="rgba(201,168,76,0.45)" strokeWidth={1.2} strokeDasharray="4 3"
        fill="rgba(201,168,76,0.12)"
      />
    </svg>
  )
}

const LEGEND_ROWS: Array<{ icon: React.ReactNode; label: string }> = [
  { icon: <LegendDot color="#3d2a50" />,           label: 'Place' },
  { icon: <LegendOrigin />,                         label: 'Story origin' },
  { icon: <LegendDot color="#b0a090" dashed />,    label: 'Inferred / uncertain' },
  { icon: <LegendHull />,                           label: 'Contains (group)' },
  { icon: <LegendLine color="#c9a84c" dash="7 5" arrow />, label: 'Passage / portal' },
  { icon: <LegendLine color="#3d2a50" arrow />,    label: 'Leads to' },
  { icon: <LegendLine color="#c0ad94" dash="5 5" />, label: 'Contains / located in' },
  { icon: <LegendLine color="#c9a84c" dash="2 8" />, label: 'Adjacent / near' },
  { icon: <LegendLine color="#7a9ab5" dash="4 4" arrow />, label: 'Compass bearing' },
  { icon: <LegendLine color="#9b8574" dash="8 5" arrow />, label: 'Reached from' },
  { icon: <LegendLine color="#d4bc8a" dash="3 8" />, label: 'Uncertain' },
]

function Legend() {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className="atlas-overlay atlas-legend" role="complementary" aria-label="Map legend">
      <button
        className="atlas-legend-toggle"
        onClick={() => setCollapsed(c => !c)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand legend' : 'Collapse legend'}
      >
        <span className="atlas-legend-title">Legend</span>
        <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <ul className="atlas-legend-list" role="list">
          {LEGEND_ROWS.map(({ icon, label }) => (
            <li key={label} className="atlas-legend-row">
              {icon}
              <span>{label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Disclaimer ────────────────────────────────────────────────────────────────

function Disclaimer() {
  return (
    <p className="atlas-disclaimer" aria-hidden="true">
      Topological schematic · edges communicate relationships, not distance, scale, or literal terrain
    </p>
  )
}

// ── Inspector overlay ─────────────────────────────────────────────────────────

function InspectorOverlay({
  target, sectionTitles, cursor, entityMentions, sectionOrder, onClose,
}: {
  target: InspectorTarget
  sectionTitles: Map<string, string>
  cursor: number
  entityMentions: EntityMention[]
  sectionOrder: Map<string, number>
  onClose: () => void
}) {
  if (!target) return null

  return (
    <div className="atlas-overlay atlas-inspector" role="complementary" aria-label="Place inspector">
      <div className="atlas-inspector-header">
        <span className="atlas-inspector-title">Inspector</span>
        <button
          onClick={onClose}
          aria-label="Close inspector"
          className="atlas-inspector-close"
        >×</button>
      </div>
      <div className="atlas-inspector-body">
        <InspectorContent
          target={target}
          sectionTitles={sectionTitles}
          cursor={cursor}
          entityMentions={entityMentions}
          sectionOrder={sectionOrder}
        />
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  documentId: string
  sections: Array<{ id: string; title: string }>
  onAtlasLoaded: (entityCount: number) => void
}

export function AtlasExplorer({ documentId, sections, onAtlasLoaded }: Props) {
  const [atlasData, setAtlasData] = useState<AtlasResponse | null>(null)
  const [vm, setVm] = useState<DiagramViewModel | null>(null)
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS)
  const [allEntities, setAllEntities] = useState<Map<string, { visualClaims: unknown[] }>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState(() => Math.max(0, sections.length - 1))
  const [inspectorTarget, setInspectorTarget] = useState<InspectorTarget>(null)
  const [entityMentions, setEntityMentions] = useState<EntityMention[]>([])

  // Layout state — computed from vm once and reused (positions don't change with filters/cursor)
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }> | null>(null)
  const [containmentMap, setContainmentMap] = useState<ContainmentMap>({})

  const sectionOrder = useMemo(() => {
    const map = new Map<string, number>()
    sections.forEach((s, i) => map.set(s.id, i))
    return map
  }, [sections])

  const sectionTitles = useMemo(() => {
    const map = new Map<string, string>()
    sections.forEach(s => map.set(s.id, s.title))
    return map
  }, [sections])

  // Load atlas data
  useEffect(() => {
    setLoading(true)
    setError(null)
    setCursor(sections.length > 0 ? sections.length - 1 : 0)
    setInspectorTarget(null)
    setEntityMentions([])
    setPositions(null)
    setContainmentMap({})

    Promise.all([
      fetchAtlas(documentId),
      fetchEntityMentions(documentId).catch(() => [] as EntityMention[]),
    ])
      .then(([atlas, mentions]) => {
        onAtlasLoaded(atlas.entity_count)
        setAtlasData(atlas)
        setEntityMentions(mentions)
        const map = new Map<string, { visualClaims: unknown[] }>()
        for (const e of atlas.entities) {
          map.set(e.id, { visualClaims: e.claims.filter(c => c.claim_type === 'visual') })
        }
        setAllEntities(map)
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load atlas'))
      .finally(() => setLoading(false))
  }, [documentId])

  // Build view-model and run layout whenever atlas data or section order changes
  useEffect(() => {
    if (!atlasData) return
    const newVm = buildDiagramViewModel(atlasData, sectionOrder)
    setVm(newVm)
    // Run layout synchronously — computeLayout is CPU-only (no async)
    const { positions: pos, containmentMap: cmap } = computeLayout(newVm.nodes, newVm.edges)
    setPositions(pos)
    setContainmentMap(cmap)
  }, [atlasData, sectionOrder])

  // Arrow key navigation
  useEffect(() => {
    if (!sections.length) return
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
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
      <div className="atlas-state-message">
        Loading atlas…
      </div>
    )
  }

  if (error) {
    return (
      <div className="atlas-state-message atlas-state-error">
        {error}
      </div>
    )
  }

  if (!vm || vm.isEmpty) {
    return (
      <div className="atlas-state-message atlas-state-empty">
        <div className="atlas-empty-glyph" aria-hidden="true">⊙</div>
        <p>No places in the atlas yet.</p>
        <p>Complete synthesis in the workflow to build the atlas.</p>
      </div>
    )
  }

  return (
    <div className="atlas-canvas-root" role="main" aria-label="Atlas Explorer">
      <FilterBar filters={filters} onChange={setFilters} />
      <ReactFlowProvider>
        <InnerDiagram
          vm={vm}
          positions={positions}
          containmentMap={containmentMap}
          filters={filters}
          cursor={cursor}
          sectionOrder={sectionOrder}
          onSelect={setInspectorTarget}
          allEntities={allEntities}
        />
      </ReactFlowProvider>
      <Legend />
      <NarrativeScrubber sections={sections} cursor={cursor} onChange={setCursor} />
      <Disclaimer />
      <InspectorOverlay
        target={inspectorTarget}
        sectionTitles={sectionTitles}
        cursor={cursor}
        entityMentions={entityMentions}
        sectionOrder={sectionOrder}
        onClose={() => setInspectorTarget(null)}
      />
    </div>
  )
}

// ── Narrative thread ──────────────────────────────────────────────────────────

function NarrativeThread({
  entityId, cursor, entityMentions, sectionOrder, sectionTitles,
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
    <div className="inspector-thread">
      <div className="inspector-thread-label">Narrative thread</div>
      {visible.map(m => {
        const idx   = sectionOrder.get(m.section_id) ?? 0
        const title = sectionTitles.get(m.section_id) ?? m.section_id
        return (
          <div key={m.id} className="inspector-thread-row">
            <span className="inspector-thread-ordinal">§{idx + 1}</span>
            <span className="inspector-thread-title">{title}</span>
            <span className={`inspector-thread-kind${m.mention_kind === 'origin' ? ' origin' : ''}`}>
              {m.mention_kind === 'origin' ? 'introduced' : 'referenced'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Inspector content ─────────────────────────────────────────────────────────

export function InspectorContent({
  target, sectionTitles, cursor = 0, entityMentions = [], sectionOrder = new Map(),
}: {
  target: InspectorTarget
  sectionTitles: Map<string, string>
  cursor?: number
  entityMentions?: EntityMention[]
  sectionOrder?: Map<string, number>
}) {
  if (!target) {
    return (
      <div className="inspector-empty">
        <div className="inspector-empty-glyph" aria-hidden="true">⊙</div>
        <p>Select a place or passage<br />to inspect it.</p>
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
      <div className="inspector-node">
        <div className="inspector-role">{roleLabel}</div>
        <h4 className="inspector-name">{node.label}</h4>
        {node.placeKind && node.role !== 'inferred' && (
          <span className="inspector-kind-badge">{node.placeKind}</span>
        )}
        {node.aliases.length > 0 && (
          <p className="inspector-aliases">Also: {node.aliases.join(', ')}</p>
        )}
        <InspectorRow label="Status"        value={node.status} />
        {sectionTitle && <InspectorRow label="First revealed" value={sectionTitle} />}
        <InspectorRow label="Relationships" value={String(node.claimCount)} />
        {(visualClaims as { payload: Record<string, unknown> }[]).length > 0 && (
          <div className="inspector-visual-claims">
            <div className="inspector-section-label">Visual properties</div>
            {(visualClaims as { id: string; payload: Record<string, unknown> }[]).map(c => (
              <div key={c.id} className="inspector-claim-row">
                <span className="inspector-claim-prop">{String(c.payload.visual_property ?? '')}:</span>{' '}
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

  const { edge } = target
  const desc = PREDICATE_DESCRIPTIONS[edge.predicate]
  return (
    <div className="inspector-edge">
      <div className="inspector-role">
        {edge.style === 'passage' ? 'Passage' : 'Spatial relationship'}
      </div>
      <h4 className="inspector-name">{edge.edgeLabel ?? edge.predicate}</h4>
      {edge.edgeLabel && (
        <div className="inspector-predicate-code">{edge.predicate}</div>
      )}
      {desc && <p className="inspector-desc">{desc}</p>}
      <InspectorRow label="From" value={edge.sourceName} />
      <InspectorRow label="To"   value={edge.targetName} />
      {edge.excerpt && (
        <blockquote className="inspector-excerpt">"{edge.excerpt}"</blockquote>
      )}
    </div>
  )
}

function InspectorRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="inspector-row">
      <span className="inspector-row-label">{label}</span>
      <span className="inspector-row-value">{value}</span>
    </div>
  )
}
