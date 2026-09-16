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

import { fetchAtlas, fetchEntityMentions, mergeEntities } from './atlasApi'
import type { AtlasResponse, EntityMention, AtlasEntity, AtlasTravelRule, AtlasClaim } from './atlasApi'
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
  SpatialLevel,
} from './atlasGraph'
import { computeLayout } from './atlasLayout'
import type { ContainmentMap } from './atlasLayout'

// ── Node dimensions ───────────────────────────────────────────────────────────
// Base radius per spatial level; hub adds 7, inferred subtracts 3
const SHAPE_R: Record<SpatialLevel, number> = { 0: 26, 1: 22, 2: 18, 3: 13 }

function nodeR(level: SpatialLevel, role: string): number {
  const base = SHAPE_R[level]
  if (role === 'hub') return base + 7
  if (role === 'inferred') return Math.max(base - 3, 9)
  return base
}

function nodeSize(role: string, level: SpatialLevel = 2): { w: number; h: number } {
  const r = nodeR(level, role)
  const svgW = r * 2 + 8
  // Hub: label below → square-ish container. Others: label right → wide container.
  if (role === 'hub') return { w: svgW + 44, h: svgW + 44 }
  return { w: svgW + 84, h: svgW + 12 }
}

// SVG shape helper — renders the correct shape for each spatial level
function NodeShape({
  level, cx, cy, r, strokeColor, fillColor, strokeWidth, strokeDasharray,
}: {
  level: SpatialLevel; cx: number; cy: number; r: number
  strokeColor: string; fillColor: string; strokeWidth: number; strokeDasharray?: string
}) {
  const p = { stroke: strokeColor, strokeWidth, strokeDasharray, fill: fillColor }

  if (level === 0) {
    // Hexagon (pointy-top)
    const pts = Array.from({ length: 6 }, (_, k) => {
      const a = -Math.PI / 2 + (k * Math.PI) / 3
      return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`
    }).join(' ')
    return <polygon points={pts} {...p} />
  }
  if (level === 1) {
    // Rounded square
    const s = r * 1.05
    return <rect x={(cx - s).toFixed(1)} y={(cy - s).toFixed(1)}
      width={(s * 2).toFixed(1)} height={(s * 2).toFixed(1)} rx={4} {...p} />
  }
  if (level === 3) {
    // Diamond
    const d = r * 1.2
    return <polygon
      points={`${cx},${(cy - d).toFixed(1)} ${(cx + d * 0.72).toFixed(1)},${cy} ${cx},${(cy + d).toFixed(1)} ${(cx - d * 0.72).toFixed(1)},${cy}`}
      {...p} />
  }
  // level 2: circle
  return <circle cx={cx} cy={cy} r={r} {...p} />
}

// ── Containment hull node ─────────────────────────────────────────────────────

interface HullData {
  label: string
  depth: number
}

function HullNode({ data }: NodeProps) {
  const { label, depth } = data as HullData
  const opacity = Math.max(0.06, 0.13 - depth * 0.03)
  const strokeOpacity = Math.max(0.20, 0.32 - depth * 0.05)

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        borderRadius: '14px',
        border: `1.5px dashed rgba(201,168,76,${strokeOpacity})`,
        background: `rgba(201,168,76,${opacity})`,
        // No pointer-events: none — the wrapper div captures clicks for hull inspection
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
          whiteSpace: 'normal',
          wordBreak: 'break-word' as const,
        }}
      >
        {label}
      </span>
    </div>
  )
}

// ── Schematic place node ──────────────────────────────────────────────────────

// (radius is now computed from spatialLevel + role via nodeR())


// Label is positioned to the right of the circle for all non-hub nodes
// to avoid vertical stacking and overlap with nearby nodes.
// Hub nodes are prominent enough that a below-label reads cleanly at larger size.

function SchematicNode({ data, selected }: NodeProps) {
  const d        = data as DiagramNode
  const level    = d.spatialLevel
  const r        = nodeR(level, d.role)
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

  // Label to the right for non-hub nodes; below for hub
  const labelRight = !isHub
  const { w: containerW } = nodeSize(d.role, level)

  const labelStyle: React.CSSProperties = labelRight
    ? {
        position: 'absolute',
        left: svgSize + 6,
        top: '50%',
        transform: 'translateY(-50%)',
        fontSize: isInferred ? '0.65rem' : '0.70rem',
        fontWeight: 500,
        color: isInferred ? '#9b8574' : '#2c1810',
        fontStyle: isInferred ? 'italic' : 'normal',
        whiteSpace: 'nowrap',
        lineHeight: 1.25,
      }
    : {
        marginTop: '0.25rem',
        fontSize: '0.76rem',
        fontWeight: 700,
        color: '#2c1810',
        textAlign: 'center' as const,
        letterSpacing: '0.03em',
        maxWidth: `${containerW}px`,
        whiteSpace: 'normal',
        wordBreak: 'break-word' as const,
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
        width: `${containerW}px`,
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
        {/* Selection glow — always a circle halo regardless of shape */}
        {selected && (
          <circle cx={cx} cy={cy} r={r + 6}
            fill="none" stroke="#c9a84c" strokeWidth={1.2} opacity={0.35} />
        )}

        {/* Main shape — varies by spatial level */}
        <NodeShape
          level={level} cx={cx} cy={cy} r={r}
          strokeColor={strokeColor}
          fillColor={fill}
          strokeWidth={selected ? 2.2 : isHub ? 1.8 : 1.5}
          strokeDasharray={isInferred ? '4 3' : undefined}
        />

        {/* Hub inner ring (always circle — subtle accent) */}
        {isHub && (
          <circle cx={cx} cy={cy} r={r - 7}
            fill="none" stroke={strokeColor} strokeWidth={0.8} opacity={0.45} />
        )}

        {/* Center dot */}
        <circle cx={cx} cy={cy}
          r={isHub ? 4.5 : 3}
          fill={isInferred ? '#b0a090' : strokeColor}
        />

        {/* Origin mark */}
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

        {/* Place-kind glyph (suppressed — shape already communicates category) */}
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
  type: 'default' | 'passage'
  style: React.CSSProperties
  markerEnd?: { type: string; color: string; width: number; height: number }
}

function edgeStyleProps(style: DiagramEdge['style']): EdgePropsReturn {
  switch (style) {
    case 'containment':
      return { type: 'default', style: { stroke: '#c0ad94', strokeWidth: 1, strokeDasharray: '5 5', opacity: 0.6 } }
    case 'directed':
      return {
        type: 'default', style: { stroke: '#3d2a50', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#3d2a50', width: 11, height: 11 },
      }
    case 'passage':
      return { type: 'passage', style: {} }
    case 'proximity':
      return { type: 'default', style: { stroke: '#c9a84c', strokeWidth: 0.9, strokeDasharray: '2 8', opacity: 0.45 } }
    case 'compass':
      return {
        type: 'default', style: { stroke: '#7a9ab5', strokeWidth: 1, strokeDasharray: '4 4' },
        markerEnd: { type: MarkerType.Arrow, color: '#7a9ab5', width: 10, height: 10 },
      }
    case 'movement':
      return {
        type: 'default', style: { stroke: '#9b8574', strokeWidth: 1.2, strokeDasharray: '8 5' },
        markerEnd: { type: MarkerType.Arrow, color: '#9b8574', width: 10, height: 10 },
      }
    case 'uncertain':
      return { type: 'default', style: { stroke: '#d4bc8a', strokeWidth: 0.9, strokeDasharray: '3 8', opacity: 0.30 } }
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
  allEntities: Map<string, AtlasEntity>
  travelRules: AtlasTravelRule[]
  mergeSourceId?: string | null
  onMergeTargetSelect?: (id: string, name: string) => void
  hiddenEntityIds?: Set<string>
}

function InnerDiagram({
  vm, positions, containmentMap, filters, cursor, sectionOrder, onSelect, allEntities, travelRules,
  mergeSourceId, onMergeTargetSelect, hiddenEntityIds,
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
    // Compute reverse containment map to determine nesting depth of each container.
    // containerParentOf[childId] = parentId — only for nodes that are THEMSELVES containers.
    const containerParentOf: Record<string, string> = {}
    for (const [parentId, children] of Object.entries(containmentMap)) {
      for (const childId of children) {
        if (containmentMap[childId]) containerParentOf[childId] = parentId
      }
    }
    const getContainerDepth = (id: string): number => {
      let depth = 0; let current = id; const visited = new Set<string>()
      while (containerParentOf[current] && !visited.has(current)) {
        visited.add(current); depth++; current = containerParentOf[current]
      }
      return depth
    }

    // Track which container entities have a hull rendered — these hide their own place-node.
    const containersWithHull = new Set<string>()

    const hullNodes: RFNode[] = []
    if (filters.containment) {
      for (const [containerId, childIds] of Object.entries(containmentMap)) {
        // Only draw hull if container itself is visible and not hidden by user
        if (!visibleNodeIds.has(containerId)) continue
        if (hiddenEntityIds?.has(containerId)) continue
        const visibleChildren = childIds.filter(id => visibleNodeIds.has(id) && !hiddenEntityIds?.has(id))
        if (visibleChildren.length === 0) continue

        const members = [containerId, ...visibleChildren]
        const pad = 44
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const id of members) {
          const pos = positions[id]
          if (!pos) continue
          const memberNode = vm.nodes.find(n => n.id === id)
          const role = memberNode?.role ?? 'normal'
          const level = memberNode?.spatialLevel ?? 2
          const { w, h } = nodeSize(role, level)
          minX = Math.min(minX, pos.x - pad)
          minY = Math.min(minY, pos.y - pad)
          maxX = Math.max(maxX, pos.x + w + pad)
          maxY = Math.max(maxY, pos.y + h + pad)
        }
        if (!isFinite(minX)) continue

        containersWithHull.add(containerId)
        const containerNode = vm.nodes.find(n => n.id === containerId)
        const depth = getContainerDepth(containerId)
        hullNodes.push({
          id: `hull-${containerId}`,
          type: 'hull',
          position: { x: minX, y: minY },
          style: { width: maxX - minX, height: maxY - minY, cursor: 'pointer' },
          data: { label: containerNode?.label ?? '', depth },
          selectable: false,
          focusable: false,
          draggable: false,
          // Deeper nesting renders further back so outer hull is always visible
          zIndex: -(2 + depth),
        })
      }
    }

    // ── Place nodes ────────────────────────────────────────────────────────
    // Container entities with a hull are hidden — the hull IS their visual representation.
    const placeNodes: RFNode[] = vm.nodes.map(n => {
      const { w, h } = nodeSize(n.role, n.spatialLevel)
      return {
        id: n.id,
        type: 'place',
        position: positions[n.id] ?? { x: 0, y: 0 },
        data: n,
        hidden: !visibleNodeIds.has(n.id)
          || containersWithHull.has(n.id)
          || (hiddenEntityIds?.has(n.id) ?? false),
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
  }, [positions, vm, filters, cursor, sectionOrder, containmentMap, fitView, hiddenEntityIds])

  const onNodeClick = useCallback((_: unknown, node: RFNode) => {
    // Hull click → inspect the container entity (node.id = "hull-{entityId}")
    if (node.type === 'hull') {
      const containerId = node.id.startsWith('hull-') ? node.id.slice(5) : node.id
      const diagNode = vm.nodes.find(n => n.id === containerId)
      if (!diagNode) return
      const entity = allEntities.get(containerId) ?? null
      const entityName = entity?.name ?? diagNode.label
      const entityRules = travelRules.filter(r => {
        const p = r.payload as Record<string, unknown>
        return p.from === entityName || p.to === entityName || p.via === entityName
      })
      onSelect({ kind: 'node', node: diagNode, entity, travelRules: entityRules })
      return
    }
    const diagNode = node.data as DiagramNode
    // In merge-select mode: clicking any node other than the source selects it as merge target
    if (mergeSourceId && onMergeTargetSelect && diagNode.id !== mergeSourceId) {
      const entity = allEntities.get(diagNode.id)
      onMergeTargetSelect(diagNode.id, entity?.name ?? diagNode.label)
      return
    }
    const entity = allEntities.get(diagNode.id) ?? null
    const entityName = entity?.name ?? diagNode.label
    const entityRules = travelRules.filter(r => {
      const p = r.payload as Record<string, unknown>
      return p.from === entityName || p.to === entityName || p.via === entityName
    })
    onSelect({ kind: 'node', node: diagNode, entity, travelRules: entityRules })
  }, [vm, allEntities, travelRules, onSelect, mergeSourceId, onMergeTargetSelect])

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
      nodesDraggable={true}
      nodesConnectable={false}
      elementsSelectable
      proOptions={{ hideAttribution: true }}
      style={mergeSourceId ? { cursor: 'crosshair' } : undefined}
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

function LegendShape({ shape }: { shape: 'hex' | 'square' | 'circle' | 'diamond' }) {
  const cx = 10, cy = 10, r = 7
  const stroke = '#3d2a50', fill = 'rgba(201,168,76,0.10)'
  if (shape === 'hex') {
    const pts = Array.from({ length: 6 }, (_, k) => {
      const a = -Math.PI / 2 + (k * Math.PI) / 3
      return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`
    }).join(' ')
    return <svg width={20} height={20} aria-hidden="true" style={{ flexShrink: 0 }}><polygon points={pts} stroke={stroke} strokeWidth={1.3} fill={fill} /><circle cx={cx} cy={cy} r={2} fill={stroke} /></svg>
  }
  if (shape === 'square') {
    const s = r * 1.05
    return <svg width={20} height={20} aria-hidden="true" style={{ flexShrink: 0 }}><rect x={cx-s} y={cy-s} width={s*2} height={s*2} rx={2} stroke={stroke} strokeWidth={1.3} fill={fill} /><circle cx={cx} cy={cy} r={2} fill={stroke} /></svg>
  }
  if (shape === 'diamond') {
    const d = r * 1.2
    return <svg width={20} height={20} aria-hidden="true" style={{ flexShrink: 0 }}><polygon points={`${cx},${cy-d} ${cx+d*0.72},${cy} ${cx},${cy+d} ${cx-d*0.72},${cy}`} stroke={stroke} strokeWidth={1.3} fill={fill} /><circle cx={cx} cy={cy} r={2} fill={stroke} /></svg>
  }
  return <LegendDot color={stroke} />
}

const LEGEND_ROWS: Array<{ icon: React.ReactNode; label: string }> = [
  { icon: <LegendShape shape="hex" />,              label: 'L0 — World / region' },
  { icon: <LegendShape shape="square" />,           label: 'L1 — Settlement / area' },
  { icon: <LegendShape shape="circle" />,           label: 'L2 — Building / feature' },
  { icon: <LegendShape shape="diamond" />,          label: 'L3 — Room / interior' },
  { icon: <LegendOrigin />,                         label: 'Story origin' },
  { icon: <LegendDot color="#b0a090" dashed />,    label: 'Inferred / uncertain' },
  { icon: <LegendHull />,                           label: 'Contains (group)' },
  { icon: <LegendLine color="#c9a84c" dash="7 5" arrow />, label: 'Passage / portal' },
  { icon: <LegendLine color="#3d2a50" arrow />,    label: 'Leads to' },
  { icon: <LegendLine color="#c0ad94" dash="5 5" />, label: 'Contains / located in' },
  { icon: <LegendLine color="#c9a84c" dash="2 8" />, label: 'Adjacent / near' },
  { icon: <LegendLine color="#7a9ab5" dash="4 4" arrow />, label: 'Compass bearing' },
  { icon: <LegendLine color="#9b8574" dash="8 5" arrow />, label: 'Route / reached from' },
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
  target, sectionTitles, cursor, entityMentions, sectionOrder, onClose, onStartMerge, onToggleHide, hiddenEntityIds,
}: {
  target: InspectorTarget
  sectionTitles: Map<string, string>
  cursor: number
  entityMentions: EntityMention[]
  sectionOrder: Map<string, number>
  onClose: () => void
  onStartMerge?: (entityId: string, entityName: string) => void
  onToggleHide?: (entityId: string) => void
  hiddenEntityIds?: Set<string>
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
          onStartMerge={onStartMerge}
          onToggleHide={onToggleHide}
          hiddenEntityIds={hiddenEntityIds}
        />
      </div>
    </div>
  )
}

// ── Merge UI ──────────────────────────────────────────────────────────────────

type MergeSide = 'a' | 'b'

interface MergeEntity { id: string; name: string }

function MergeSelectBanner({ sourceName, onCancel }: { sourceName: string; onCancel: () => void }) {
  return (
    <div style={{
      position: 'absolute', top: '3rem', left: '50%', transform: 'translateX(-50%)',
      zIndex: 30, background: 'var(--parchment-alt)', border: '1px solid var(--border-warm)',
      borderRadius: '6px', padding: '0.55rem 1rem', display: 'flex', alignItems: 'center',
      gap: '0.75rem', boxShadow: '0 2px 8px rgba(0,0,0,0.10)', fontSize: '0.78rem',
      color: 'var(--ink-body)', whiteSpace: 'nowrap',
    }}>
      <span>Click a place to merge with <strong>{sourceName}</strong></span>
      <button onClick={onCancel} style={{
        background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-faint)',
        fontSize: '0.78rem', padding: '0 0.2rem',
      }}>Cancel</button>
    </div>
  )
}

function MergeConfirmPanel({
  a, b, canonical, onSetCanonical, onConfirm, onCancel, merging,
}: {
  a: MergeEntity; b: MergeEntity
  canonical: MergeSide
  onSetCanonical: (s: MergeSide) => void
  onConfirm: () => void
  onCancel: () => void
  merging: boolean
}) {
  const primary = canonical === 'a' ? a : b
  const alias   = canonical === 'a' ? b : a
  return (
    <div className="atlas-overlay atlas-inspector" role="dialog" aria-label="Merge places" style={{ bottom: '3.5rem' }}>
      <div className="atlas-inspector-header">
        <span className="atlas-inspector-title">Merge places</span>
        <button onClick={onCancel} className="atlas-inspector-close" aria-label="Cancel merge">×</button>
      </div>
      <div className="atlas-inspector-body" style={{ padding: '0.75rem' }}>
        <p style={{ fontSize: '0.72rem', color: 'var(--ink-faint)', marginBottom: '0.75rem', lineHeight: 1.4 }}>
          Choose the primary name. The other becomes an alias.
        </p>
        {([['a', a], ['b', b]] as [MergeSide, MergeEntity][]).map(([side, ent]) => (
          <label key={side} style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.5rem',
            borderRadius: '4px', cursor: 'pointer', marginBottom: '0.3rem',
            background: canonical === side ? 'rgba(201,168,76,0.10)' : 'transparent',
            border: canonical === side ? '1px solid rgba(201,168,76,0.35)' : '1px solid transparent',
            fontSize: '0.78rem', fontWeight: canonical === side ? 600 : 400,
          }}>
            <input
              type="radio" name="merge-canonical" value={side}
              checked={canonical === side}
              onChange={() => onSetCanonical(side)}
              style={{ accentColor: '#c9a84c' }}
            />
            <span>{ent.name}</span>
            {canonical === side && (
              <span style={{ marginLeft: 'auto', fontSize: '0.6rem', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>primary</span>
            )}
          </label>
        ))}
        <p style={{ fontSize: '0.68rem', color: 'var(--ink-faint)', margin: '0.5rem 0 0.75rem' }}>
          <em>{alias.name}</em> becomes an alias of <em>{primary.name}</em>.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={merging} style={{
            background: 'none', border: '1px solid var(--border-warm)', borderRadius: '4px',
            padding: '0.3rem 0.75rem', cursor: 'pointer', fontSize: '0.75rem',
            color: 'var(--ink-faint)',
          }}>Cancel</button>
          <button onClick={onConfirm} disabled={merging} style={{
            background: 'var(--accent-warm, #c9a84c)', border: 'none', borderRadius: '4px',
            padding: '0.3rem 0.75rem', cursor: merging ? 'wait' : 'pointer', fontSize: '0.75rem',
            fontWeight: 600, color: '#fff', opacity: merging ? 0.7 : 1,
          }}>{merging ? 'Merging…' : 'Merge'}</button>
        </div>
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
  const [allEntities, setAllEntities] = useState<Map<string, AtlasEntity>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState(() => Math.max(0, sections.length - 1))
  const [inspectorTarget, setInspectorTarget] = useState<InspectorTarget>(null)
  const [entityMentions, setEntityMentions] = useState<EntityMention[]>([])

  // ── Edit state — entities the user hid from view (ephemeral, cleared on reload) ──
  const [hiddenEntityIds, setHiddenEntityIds] = useState<Set<string>>(new Set())

  const handleToggleHide = useCallback((entityId: string) => {
    setHiddenEntityIds(prev => {
      const next = new Set(prev)
      if (next.has(entityId)) next.delete(entityId)
      else next.add(entityId)
      return next
    })
  }, [])

  // ── Merge state ──────────────────────────────────────────────────────────────
  const [mergeSource, setMergeSource] = useState<MergeEntity | null>(null)
  const [mergeTarget, setMergeTarget] = useState<MergeEntity | null>(null)
  const [mergeCanonical, setMergeCanonical] = useState<MergeSide>('a')
  const [merging, setMerging] = useState(false)

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
  const loadAtlas = useCallback((resetCursor = false) => {
    setLoading(true)
    setError(null)
    if (resetCursor) setCursor(sections.length > 0 ? sections.length - 1 : 0)
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
        const map = new Map<string, AtlasEntity>()
        for (const e of atlas.entities) {
          map.set(e.id, e)
        }
        setAllEntities(map)
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load atlas'))
      .finally(() => setLoading(false))
  }, [documentId, sections.length, onAtlasLoaded])

  useEffect(() => { loadAtlas(true) }, [documentId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Merge handlers ───────────────────────────────────────────────────────────
  const handleStartMerge = useCallback((entityId: string, entityName: string) => {
    setMergeSource({ id: entityId, name: entityName })
    setMergeTarget(null)
    setMergeCanonical('a')
    setInspectorTarget(null)
  }, [])

  const handleMergeTargetSelect = useCallback((id: string, name: string) => {
    setMergeTarget({ id, name })
    setMergeCanonical('a')
  }, [])

  const handleMergeCancel = useCallback(() => {
    setMergeSource(null)
    setMergeTarget(null)
    setMerging(false)
  }, [])

  const handleMergeConfirm = useCallback(async () => {
    if (!mergeSource || !mergeTarget) return
    const keepId   = mergeCanonical === 'a' ? mergeSource.id : mergeTarget.id
    const dropId   = mergeCanonical === 'a' ? mergeTarget.id : mergeSource.id
    setMerging(true)
    try {
      await mergeEntities(keepId, dropId)
      setMergeSource(null)
      setMergeTarget(null)
      setMerging(false)
      loadAtlas(false)
    } catch {
      setMerging(false)
    }
  }, [mergeSource, mergeTarget, mergeCanonical, loadAtlas])

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
      {hiddenEntityIds.size > 0 && (
        <div style={{
          position: 'absolute', top: '3rem', left: '50%', transform: 'translateX(-50%)',
          zIndex: 30, background: 'var(--parchment-alt)', border: '1px solid rgba(180,120,20,0.35)',
          borderRadius: '6px', padding: '0.45rem 0.85rem', display: 'flex', alignItems: 'center',
          gap: '0.65rem', boxShadow: '0 2px 8px rgba(0,0,0,0.10)', fontSize: '0.75rem',
          color: 'var(--ink-muted)', whiteSpace: 'nowrap',
        }}>
          <span>{hiddenEntityIds.size} place{hiddenEntityIds.size !== 1 ? 's' : ''} hidden from view</span>
          <button
            onClick={() => setHiddenEntityIds(new Set())}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-faint)', fontSize: '0.75rem', padding: '0 0.2rem' }}
          >
            Restore all
          </button>
        </div>
      )}
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
          travelRules={atlasData?.travel_rules ?? []}
          mergeSourceId={mergeSource?.id}
          onMergeTargetSelect={handleMergeTargetSelect}
          hiddenEntityIds={hiddenEntityIds}
        />
      </ReactFlowProvider>
      <Legend />
      <NarrativeScrubber sections={sections} cursor={cursor} onChange={setCursor} />
      <Disclaimer />
      {mergeSource && !mergeTarget && (
        <MergeSelectBanner sourceName={mergeSource.name} onCancel={handleMergeCancel} />
      )}
      {mergeSource && mergeTarget && (
        <MergeConfirmPanel
          a={mergeSource}
          b={mergeTarget}
          canonical={mergeCanonical}
          onSetCanonical={setMergeCanonical}
          onConfirm={handleMergeConfirm}
          onCancel={handleMergeCancel}
          merging={merging}
        />
      )}
      {!mergeSource && (
        <InspectorOverlay
          target={inspectorTarget}
          sectionTitles={sectionTitles}
          cursor={cursor}
          entityMentions={entityMentions}
          sectionOrder={sectionOrder}
          onClose={() => setInspectorTarget(null)}
          onStartMerge={handleStartMerge}
          onToggleHide={handleToggleHide}
          hiddenEntityIds={hiddenEntityIds}
        />
      )}
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
  target, sectionTitles, cursor = 0, entityMentions = [], sectionOrder = new Map(), onStartMerge, onToggleHide, hiddenEntityIds,
}: {
  target: InspectorTarget
  sectionTitles: Map<string, string>
  cursor?: number
  entityMentions?: EntityMention[]
  sectionOrder?: Map<string, number>
  onStartMerge?: (entityId: string, entityName: string) => void
  onToggleHide?: (entityId: string) => void
  hiddenEntityIds?: Set<string>
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
    const { node, entity, travelRules } = target
    const sectionTitle = node.revealSectionId
      ? (sectionTitles.get(node.revealSectionId) ?? node.revealSectionId)
      : null

    const roleLabel =
      node.role === 'hub'      ? 'Hub place' :
      node.role === 'origin'   ? 'Story origin' :
      node.role === 'inferred' ? 'Inferred place' :
      node.placeKind ?? 'Place'

    const allClaims = entity?.claims ?? []
    const visualClaims = allClaims.filter(c => c.claim_type === 'visual')
    const spatialClaims = allClaims.filter(c => c.claim_type === 'spatial' && c.predicate && c.predicate !== 'SAME_AS')
    const accessClaims = allClaims.filter(c => c.claim_type === 'access')

    const observations: string[] = Array.isArray(entity?.payload?.observations)
      ? (entity!.payload.observations as string[])
      : []

    function humanizePredicate(pred: string): string {
      return pred.replace(/_/g, ' ').toLowerCase()
    }

    function getVisualCategory(c: AtlasClaim): string {
      return String(c.payload.category ?? c.payload.visual_property ?? '')
    }
    function getVisualObservation(c: AtlasClaim): string {
      return String(c.payload.observation ?? c.payload.value ?? '')
    }
    function getVisualSection(c: AtlasClaim): string {
      return String(c.payload.section_title ?? '')
    }

    const visualByCategory: Record<string, AtlasClaim[]> = {}
    for (const c of visualClaims) {
      const cat = getVisualCategory(c) || 'other'
      if (!visualByCategory[cat]) visualByCategory[cat] = []
      visualByCategory[cat].push(c)
    }

    return (
      <div className="inspector-node">
        <div className="inspector-role">{roleLabel}</div>
        <h4 className="inspector-name">{node.label}</h4>
        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.55rem' }}>
          {node.placeKind && node.role !== 'inferred' && (
            <span className="inspector-kind-badge">{node.placeKind}</span>
          )}
          <span className="inspector-kind-badge" style={{ color: node.status === 'explicit' ? 'var(--step-done)' : 'var(--ink-faint)' }}>
            {node.status}
          </span>
        </div>

        {node.aliases.length > 0 && (
          <p className="inspector-aliases">Also known as: {node.aliases.join(', ')}</p>
        )}

        {sectionTitle && (
          <InspectorRow label="First revealed" value={sectionTitle} />
        )}

        {observations.length > 0 && (
          <div className="inspector-section-block">
            <div className="inspector-section-label">Descriptions</div>
            {observations.map((obs, i) => (
              <blockquote key={i} className="inspector-observation">
                {obs}
              </blockquote>
            ))}
          </div>
        )}

        {Object.keys(visualByCategory).length > 0 && (
          <div className="inspector-section-block">
            <div className="inspector-section-label">Visual properties</div>
            {Object.entries(visualByCategory).map(([cat, claims]) => (
              <div key={cat} className="inspector-visual-category">
                <span className="inspector-visual-cat-badge">{cat}</span>
                {claims.map((c, i) => {
                  const obs = getVisualObservation(c)
                  const sec = getVisualSection(c)
                  return obs ? (
                    <div key={i} className="inspector-visual-obs">
                      {obs}
                      {sec && <span className="inspector-visual-sec"> — {sec}</span>}
                    </div>
                  ) : null
                })}
              </div>
            ))}
          </div>
        )}

        {spatialClaims.length > 0 && (
          <div className="inspector-section-block">
            <div className="inspector-section-label">Connections ({spatialClaims.length})</div>
            {spatialClaims.map(c => {
              const object = String(c.payload.object ?? '')
              return (
                <div key={c.id} className="inspector-connection-row">
                  <span className="inspector-connection-pred">{humanizePredicate(c.predicate ?? '')}</span>
                  {object && <span className="inspector-connection-target">{object}</span>}
                  {c.excerpt && (
                    <blockquote className="inspector-excerpt inspector-excerpt--sm">"{c.excerpt}"</blockquote>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {accessClaims.length > 0 && (
          <div className="inspector-section-block">
            <div className="inspector-section-label">Access</div>
            {accessClaims.map(c => {
              const accessType = String(c.payload.access_type ?? c.payload.predicate ?? '')
              const condition = String(c.payload.condition ?? '')
              const traveler = String(c.payload.traveler ?? '')
              return (
                <div key={c.id} className="inspector-connection-row">
                  <span className={`inspector-access-badge inspector-access-badge--${accessType}`}>
                    {accessType}
                  </span>
                  {traveler && <span className="inspector-connection-target">for: {traveler}</span>}
                  {condition && <div className="inspector-visual-obs">{condition}</div>}
                </div>
              )
            })}
          </div>
        )}

        {travelRules.length > 0 && (
          <div className="inspector-section-block">
            <div className="inspector-section-label">Routes</div>
            {travelRules.map(r => {
              const from = String(r.payload.from ?? '')
              const to = String(r.payload.to ?? '')
              const via = String(r.payload.via ?? '')
              const cond = r.condition
              const canTraverse = r.can_traverse
              return (
                <div key={r.id} className="inspector-connection-row">
                  <span className="inspector-connection-pred" style={{ color: canTraverse === false ? '#8b1a1a' : 'var(--step-done)' }}>
                    {canTraverse === false ? 'blocked' : 'route'}
                  </span>
                  <span className="inspector-connection-target">
                    {from} → {to}{via ? ` via ${via}` : ''}
                  </span>
                  {cond && <div className="inspector-visual-obs">{cond}</div>}
                </div>
              )
            })}
          </div>
        )}

        <NarrativeThread
          entityId={node.id}
          cursor={cursor}
          entityMentions={entityMentions}
          sectionOrder={sectionOrder}
          sectionTitles={sectionTitles}
        />

        {(onStartMerge || onToggleHide) && entity && (
          <div style={{ borderTop: '1px solid var(--border-warm)', marginTop: '0.75rem', paddingTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {onStartMerge && (
              <button
                onClick={() => onStartMerge(entity.id, entity.name)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  fontSize: '0.72rem', color: 'var(--ink-faint)',
                  display: 'flex', alignItems: 'center', gap: '0.3rem', textAlign: 'left',
                }}
              >
                Merge with another place →
              </button>
            )}
            {onToggleHide && (
              <button
                onClick={() => onToggleHide(entity.id)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  fontSize: '0.72rem', color: hiddenEntityIds?.has(entity.id) ? 'var(--step-done)' : 'var(--ink-faint)',
                  display: 'flex', alignItems: 'center', gap: '0.3rem', textAlign: 'left',
                }}
              >
                {hiddenEntityIds?.has(entity.id) ? 'Restore to atlas ↩' : 'Hide from atlas view ×'}
              </button>
            )}
          </div>
        )}
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
