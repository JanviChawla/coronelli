import type { MutableRefObject } from 'react'
import type { AtlasClaim, AtlasEntity } from './atlasApi'
import type { CatalogCandidate } from './AtlasEditor'

const ENTITY_TYPES = [
  'world', 'region', 'island', 'district', 'settlement',
  'building', 'hall', 'room', 'grounds', 'landmark',
  'terrain_feature', 'body_of_water', 'vessel',
  'tunnel', 'passage', 'portal',
  'site', 'court', 'barrier',
]

const TIERS = ['peak', 'elevated', 'surface', 'underground', 'deep']
const TIER_COLOR: Record<string, string> = {
  peak: '#8AABCA', elevated: '#C4884A', surface: '#4A7A4A', underground: '#6A5A7A', deep: '#3A1A2A',
}

const CATALOG_GROUPS = [
  { id: 0, label: 'Realms & Regions', color: '#C9A84C', test: (lvl: number | null | undefined) => lvl === 0 || lvl === 1 },
  { id: 1, label: 'Places & Structures', color: '#7A9BB5', test: (lvl: number | null | undefined) => lvl === 2 },
  { id: 2, label: 'Rooms & Features', color: '#8FAF8F', test: (lvl: number | null | undefined) => lvl === 3 || lvl == null },
]

interface Props {
  readOnly: boolean
  entities: AtlasEntity[]
  entityMap: Map<string, AtlasEntity>
  childrenOf: Map<string, string[]>
  rootIds: string[]
  depthOf: Map<string, number>
  parentClaimOf: Map<string, { claim: AtlasClaim; inverse: boolean }>
  dropTarget: string | null
  setDropTarget: (t: string | null) => void
  hoveredId: string | null
  setHoveredId: (id: string | null) => void
  collapsedIds: Set<string>
  collapsedCatalogGroups: Set<number>
  selectedIds: string[]
  saving: string | null
  editingNameId: string | null
  editingNameValue: string
  setEditingNameValue: (v: string) => void
  setEditingNameId: (id: string | null) => void
  editingTypeId: string | null
  setEditingTypeId: (id: string | null) => void
  editingTierId: string | null
  setEditingTierId: (id: string | null) => void
  editingLevelId: string | null
  setEditingLevelId: (id: string | null) => void
  arrangingHierarchy: boolean
  lastArrangeCount: number | null
  absorbMsg: string
  absorbing: boolean
  catalogCandidates: CatalogCandidate[]
  onToggleCatalogReject?: (id: string) => void
  setCatalogTooltip: (t: { id: string; x: number; y: number } | null) => void
  isReviewingCatalog: boolean
  onConfirmCatalog?: () => void
  confirmingCatalog: boolean
  confirmCatalogSlot?: React.ReactNode
  dragIdRef: MutableRefObject<string | null>
  onDrop: (targetId: string | 'root') => void
  onSelectNode: (id: string) => void
  onToggleCollapsed: (id: string) => void
  onToggleCatalogGroup: (groupId: number) => void
  onAutoArrange: () => void
  onAbsorb: () => void
  onClearSelection: () => void
  onPatchName: (entityId: string, newName: string) => void
  onPatchType: (entityId: string, placeKind: string) => void
  onPatchTier: (entityId: string, tier: string) => void
  onPatchLevel: (entityId: string, level: string) => void
  onDeleteEntity: (entityId: string) => void
}

export function AtlasHierarchyTree({
  readOnly, entities, entityMap, childrenOf, rootIds, depthOf,
  dropTarget, setDropTarget, hoveredId, setHoveredId,
  collapsedIds, collapsedCatalogGroups, selectedIds, saving,
  editingNameId, editingNameValue, setEditingNameValue, setEditingNameId,
  editingTypeId, setEditingTypeId, editingTierId, setEditingTierId,
  editingLevelId, setEditingLevelId,
  arrangingHierarchy, lastArrangeCount, absorbMsg, absorbing,
  catalogCandidates, onToggleCatalogReject, setCatalogTooltip, isReviewingCatalog,
  onConfirmCatalog, confirmingCatalog, confirmCatalogSlot,
  dragIdRef, onDrop, onSelectNode, onToggleCollapsed, onToggleCatalogGroup,
  onAutoArrange, onAbsorb, onClearSelection,
  onPatchName, onPatchType, onPatchTier, onPatchLevel, onDeleteEntity,
}: Props) {

  function renderNode(id: string, depth: number): React.ReactNode {
    const entity = entityMap.get(id)
    if (!entity) return null
    const children = (childrenOf.get(id) ?? [])
      .sort((a, b) => (entityMap.get(a)?.name ?? '').localeCompare(entityMap.get(b)?.name ?? ''))
    const isDropTarget = dropTarget === id
    const isSaving = saving === id
    const selIdx = selectedIds.indexOf(id)
    const isSelected = selIdx !== -1
    const isCollapsed = collapsedIds.has(id)

    return (
      <div key={id}>
        <div
          {...(!readOnly && {
            draggable: true,
            onClick: () => onSelectNode(id),
            onMouseEnter: () => setHoveredId(id),
            onMouseLeave: () => setHoveredId(prev => prev === id ? null : prev),
            onDragStart: (e: React.DragEvent) => { e.stopPropagation(); dragIdRef.current = id },
            onDragEnd: () => { dragIdRef.current = null; setDropTarget(null) },
            onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (dragIdRef.current && dragIdRef.current !== id) setDropTarget(id) },
            onDragLeave: (e: React.DragEvent) => { e.stopPropagation(); setDropTarget(prev => prev === id ? null : prev) },
            onDrop: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); onDrop(id) },
          })}
          style={{
            paddingLeft: `${depth * 1.25 + 0.5}rem`,
            paddingTop: '0.3rem', paddingBottom: '0.3rem', paddingRight: '0.5rem',
            display: 'flex', alignItems: 'center', gap: '0.45rem',
            cursor: readOnly ? 'default' : isSaving ? 'wait' : 'grab',
            borderRadius: '4px',
            background: !readOnly && isDropTarget
              ? 'rgba(212,188,138,0.2)'
              : !readOnly && isSelected
                ? 'rgba(212,188,138,0.13)'
                : 'transparent',
            border: !readOnly && isDropTarget
              ? '1px dashed var(--gold)'
              : !readOnly && isSelected
                ? '1px solid rgba(212,188,138,0.5)'
                : '1px solid transparent',
            opacity: isSaving ? 0.5 : 1,
            transition: 'background 0.1s, border-color 0.1s',
            userSelect: 'none',
          }}
        >
          {children.length > 0 ? (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onToggleCollapsed(id) }}
              style={{
                background: 'none', border: 'none', padding: '0 0.1rem',
                cursor: 'pointer', color: 'var(--ink-faint)',
                fontSize: '0.48rem', lineHeight: 1, flexShrink: 0,
                opacity: 0.7,
              }}
            >
              {isCollapsed ? '▶' : '▼'}
            </button>
          ) : (
            <span style={{ width: '0.8rem', flexShrink: 0 }} />
          )}
          {!readOnly && isSelected && (
            <span style={{ fontSize: '0.58rem', color: 'var(--gold)', flexShrink: 0, fontWeight: 700 }}>
              {selIdx + 1}
            </span>
          )}
          {!readOnly && !isSelected && (
            <span style={{ color: 'var(--gold)', fontSize: '0.55rem', flexShrink: 0, opacity: 0.55 }}>⠿</span>
          )}
          {!readOnly && editingNameId === id ? (
            <input
              autoFocus
              value={editingNameValue}
              onChange={e => setEditingNameValue(e.target.value)}
              onBlur={() => onPatchName(id, editingNameValue)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); onPatchName(id, editingNameValue) }
                if (e.key === 'Escape') setEditingNameId(null)
              }}
              onClick={e => e.stopPropagation()}
              style={{
                fontSize: '0.86rem', color: 'var(--ink)', flex: 1, minWidth: 0,
                background: 'rgba(212,188,138,0.1)', border: '1px solid var(--border-warm)',
                borderRadius: '3px', padding: '0.05rem 0.3rem', outline: 'none',
              }}
            />
          ) : (
            <span
              style={{ fontSize: '0.86rem', color: 'var(--ink)', flex: 1, cursor: readOnly ? 'default' : 'text' }}
              onDoubleClick={readOnly ? undefined : e => {
                e.stopPropagation()
                setEditingNameId(id)
                setEditingNameValue(entity.name)
              }}
              title={readOnly ? undefined : 'Double-click to rename'}
            >
              {entity.name}
            </span>
          )}
          {!readOnly && editingLevelId === id ? (
            <select
              autoFocus
              value={entity.payload.spatial_level != null ? String(entity.payload.spatial_level) : ''}
              onClick={e => e.stopPropagation()}
              onChange={e => onPatchLevel(id, e.target.value)}
              onBlur={() => setEditingLevelId(null)}
              style={{
                fontSize: '0.62rem', padding: '0.1rem 0.25rem',
                border: '1px solid var(--border-warm)', borderRadius: '3px',
                background: 'var(--parchment-alt)', color: 'var(--ink-muted)',
                flexShrink: 0, maxWidth: '72px',
              }}
            >
              <option value="">— (auto)</option>
              {[0, 1, 2, 3].map(l => <option key={l} value={String(l)}>L{l}</option>)}
            </select>
          ) : (
            <span
              onClick={readOnly ? undefined : (e => { e.stopPropagation(); setEditingLevelId(id) })}
              title={readOnly ? undefined : 'Click to set spatial level'}
              style={{
                fontSize: '0.55rem', fontFamily: "'Space Mono', monospace",
                color: 'var(--ink-faint)', flexShrink: 0, letterSpacing: '0.04em',
                opacity: 0.6,
                cursor: readOnly ? 'default' : 'pointer',
                borderBottom: readOnly ? 'none' : '1px dotted rgba(212,188,138,0.3)',
              }}
            >
              L{entity.payload.spatial_level != null ? (entity.payload.spatial_level as number) : depthOf.get(id)}
            </span>
          )}
          {!readOnly && editingTypeId === id ? (
            <select
              autoFocus
              value={entity.place_kind ?? ''}
              onClick={e => e.stopPropagation()}
              onChange={e => onPatchType(id, e.target.value)}
              onBlur={() => setEditingTypeId(null)}
              style={{
                fontSize: '0.62rem', padding: '0.1rem 0.25rem',
                border: '1px solid var(--border-warm)', borderRadius: '3px',
                background: 'var(--parchment-alt)', color: 'var(--ink-muted)',
                flexShrink: 0, maxWidth: '110px',
              }}
            >
              {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          ) : (
            <span
              onClick={readOnly ? undefined : (e => { e.stopPropagation(); setEditingTypeId(id) })}
              title={readOnly ? undefined : 'Click to change type'}
              style={{
                fontSize: '0.6rem', color: 'var(--ink-faint)', flexShrink: 0,
                cursor: readOnly ? 'default' : 'pointer',
                borderBottom: readOnly ? 'none' : '1px dotted rgba(212,188,138,0.4)',
              }}
            >
              {entity.place_kind ?? '—'}
            </span>
          )}
          {!readOnly && editingTierId === id ? (
            <select
              autoFocus
              value={(entity.payload.tier as string) ?? ''}
              onClick={e => e.stopPropagation()}
              onChange={e => onPatchTier(id, e.target.value)}
              onBlur={() => setEditingTierId(null)}
              style={{
                fontSize: '0.62rem', padding: '0.1rem 0.25rem',
                border: '1px solid var(--border-warm)', borderRadius: '3px',
                background: 'var(--parchment-alt)', color: 'var(--ink-muted)',
                flexShrink: 0, maxWidth: '100px',
              }}
            >
              <option value="">— (inherit)</option>
              {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          ) : (
            <span
              onClick={readOnly ? undefined : (e => { e.stopPropagation(); setEditingTierId(id) })}
              title={readOnly ? undefined : 'Click to set elevation tier'}
              style={{
                fontSize: '0.58rem', flexShrink: 0,
                cursor: readOnly ? 'default' : 'pointer',
                color: TIER_COLOR[(entity.payload.tier as string) ?? ''] ?? 'var(--ink-faint)',
                borderBottom: readOnly ? 'none' : '1px dotted rgba(212,188,138,0.3)',
                opacity: entity.payload.tier ? 1 : 0.45,
              }}
            >
              {(entity.payload.tier as string) ?? '∿'}
            </span>
          )}
          {(() => {
            const colors = entity.payload.colors as { primary?: string; atmosphere?: string; accent?: string } | undefined
            return (
              <span style={{ display: 'flex', gap: '4px', flexShrink: 0, alignItems: 'center' }}>
                {(['primary', 'atmosphere', 'accent'] as const).map(role => {
                  const hex = colors?.[role]
                  return (
                    <span
                      key={role}
                      title={hex ? `${role}: ${hex}` : `${role}: —`}
                      style={{
                        display: 'inline-block',
                        width: '11px', height: '11px', borderRadius: '0',
                        background: hex ?? 'transparent',
                        border: hex ? 'none' : '1px dashed rgba(212,188,138,0.25)',
                        flexShrink: 0,
                      }}
                    />
                  )
                })}
              </span>
            )
          })()}
          {!readOnly && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDeleteEntity(id) }}
              disabled={isSaving}
              style={{
                fontSize: '0.62rem', padding: '0.1rem 0.35rem',
                background: 'none', border: '1px solid rgba(180,80,80,0.4)',
                borderRadius: '3px', cursor: isSaving ? 'wait' : 'pointer',
                color: '#c06060', flexShrink: 0,
                opacity: hoveredId === id ? 1 : 0,
                transition: 'opacity 0.12s',
                pointerEvents: hoveredId === id ? 'auto' : 'none',
              }}
            >
              del
            </button>
          )}
        </div>
        {!isCollapsed && children.map(childId => renderNode(childId, depth + 1))}
      </div>
    )
  }

  return (
    <div style={{
      width: 'calc(100% / 3)', flexShrink: 0,
      borderRight: '1px solid var(--border-warm)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Panel header */}
      <div style={{ padding: '0.8rem 1.25rem 0.5rem', borderBottom: '1px solid rgba(212,188,138,0.25)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.22rem' }}>
          <div style={{ fontSize: '0.58rem', color: 'var(--ink-faint)', letterSpacing: '0.16em', textTransform: 'uppercase', flex: 1 }}>
            Containment Hierarchy
          </div>
          {!readOnly && (
            <button
              type="button"
              disabled={arrangingHierarchy}
              onClick={onAutoArrange}
              title="Use AI to infer containment relationships (rooms → buildings → settlements)"
              style={{ fontSize: '0.62rem', padding: '0.15rem 0.45rem', background: 'none', border: '1px solid var(--sidebar-border)', borderRadius: '3px', cursor: arrangingHierarchy ? 'wait' : 'pointer', color: 'var(--gold)', opacity: arrangingHierarchy ? 0.5 : 1, flexShrink: 0 }}
            >
              {arrangingHierarchy ? 'Arranging…' : 'Auto-arrange'}
              {!arrangingHierarchy && lastArrangeCount !== null && (
                <span style={{ opacity: 0.55, fontSize: '0.67rem', marginLeft: '0.25rem' }}>
                  (+{lastArrangeCount})
                </span>
              )}
            </button>
          )}
        </div>
        <div style={{ fontSize: '0.73rem', color: 'var(--ink-muted)', lineHeight: 1.45 }}>
          Drag to re-parent. Drop onto root zone to remove parent.
        </div>
      </div>

      {/* Root drop zone */}
      <div
        {...(!readOnly && {
          onDragOver: (e: React.DragEvent) => { e.preventDefault(); if (dragIdRef.current) setDropTarget('root') },
          onDragLeave: () => setDropTarget(prev => prev === 'root' ? null : prev),
          onDrop: (e: React.DragEvent) => { e.preventDefault(); onDrop('root') },
        })}
        style={{
          padding: '0.45rem 1.25rem',
          borderBottom: '1px solid rgba(212,188,138,0.25)',
          background: dropTarget === 'root' ? 'rgba(212,188,138,0.15)' : 'transparent',
          border: dropTarget === 'root' ? '1px dashed var(--gold)' : '1px dashed rgba(212,188,138,0.2)',
          margin: '0.3rem 0.5rem',
          borderRadius: '4px',
          fontSize: '0.65rem', color: dropTarget === 'root' ? 'var(--gold)' : 'var(--ink-faint)',
          transition: 'background 0.12s, border-color 0.12s, color 0.12s',
          flexShrink: 0,
          cursor: 'default',
        }}
      >
        ↑ Drop here → make root (no parent)
      </div>

      {/* Tree + catalog candidates */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0.35rem 0.5rem 1rem' }}>
        {catalogCandidates.length > 0 && CATALOG_GROUPS.map(group => {
          const members = catalogCandidates
            .filter(c => group.test(c.spatialLevel) && (isReviewingCatalog || !c.isRejected))
            .sort((a, b) => {
              const strip = (s: string) => s.replace(/^(the|a|an)\s+/i, '')
              return strip(a.name).localeCompare(strip(b.name))
            })
          if (members.length === 0) return null
          const collapsed = collapsedCatalogGroups.has(group.id)
          const keptCount = isReviewingCatalog ? members.filter(c => !c.isRejected).length : members.length
          return (
            <div key={group.id}>
              <div
                onClick={() => onToggleCatalogGroup(group.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.4rem',
                  padding: '0.55rem 0.5rem 0.25rem',
                  cursor: 'pointer', userSelect: 'none',
                  borderTop: group.id > 0 ? '1px solid rgba(212,188,138,0.1)' : undefined,
                  marginTop: group.id > 0 ? '0.25rem' : undefined,
                }}
              >
                <span style={{ fontSize: '0.48rem', color: group.color, flexShrink: 0, lineHeight: 1 }}>{collapsed ? '▶' : '▼'}</span>
                <span style={{ fontSize: '0.68rem', fontWeight: 600, color: group.color, letterSpacing: '0.07em', textTransform: 'uppercase', flex: 1 }}>
                  {group.label}
                </span>
                <span style={{ fontSize: '0.62rem', color: 'var(--ink-faint)', flexShrink: 0 }}>
                  {keptCount < members.length ? `${keptCount} / ${members.length}` : members.length}
                </span>
              </div>
              {!collapsed && members.map(c => (
                <div
                  key={c.id}
                  onMouseEnter={e => {
                    if (!c.excerpt) return
                    const rect = e.currentTarget.getBoundingClientRect()
                    setCatalogTooltip({ id: c.id, x: rect.right + 10, y: rect.top })
                  }}
                  onMouseLeave={() => setCatalogTooltip(null)}
                  onClick={() => onToggleCatalogReject?.(c.id)}
                  style={{
                    paddingLeft: '0.5rem', paddingTop: '0.3rem', paddingBottom: '0.3rem', paddingRight: '0.5rem',
                    display: 'flex', alignItems: 'flex-start', gap: '0.45rem',
                    borderRadius: '4px', cursor: 'pointer',
                    opacity: c.isRejected ? 0.4 : 1,
                    border: '1px solid transparent',
                    userSelect: 'none',
                  }}
                >
                  <span style={{
                    width: '0.75rem', height: '0.75rem', borderRadius: '50%', flexShrink: 0, marginTop: '0.1rem',
                    border: c.isRejected ? '1px solid rgba(180,60,60,0.5)' : '1px solid var(--gold)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.38rem', color: c.isRejected ? 'rgba(180,60,60,0.7)' : 'var(--gold)',
                  }}>
                    {c.isRejected ? '✕' : '◉'}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.86rem', color: c.isRejected ? 'var(--ink-faint)' : 'var(--ink)', textDecoration: c.isRejected ? 'line-through' : 'none' }}>
                        {c.name}
                      </span>
                      {c.placeType && (
                        <span style={{ fontSize: '0.58rem', color: group.color, letterSpacing: '0.05em', opacity: 0.85, flexShrink: 0 }}>
                          {c.spatialLevel != null ? `L${c.spatialLevel} · ` : ''}{c.placeType}
                        </span>
                      )}
                    </span>
                    {(c.parentContext || c.sectionTitle) && (
                      <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--ink-faint)', opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.parentContext ? `in ${c.parentContext}` : ''}{c.parentContext && c.sectionTitle ? ' · ' : ''}{c.sectionTitle ?? ''}
                      </span>
                    )}
                    {c.note && (
                      <span style={{ display: 'block', fontSize: '0.70rem', color: 'var(--ink-faint)', opacity: 0.6, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.note}
                      </span>
                    )}
                  </span>
                  {c.source === 'gap' && (
                    <span style={{ fontSize: '0.52rem', color: 'var(--ink-faint)', flexShrink: 0, letterSpacing: '0.08em', opacity: 0.7, marginTop: '0.15rem' }}>gap</span>
                  )}
                </div>
              ))}
            </div>
          )
        })}
        {rootIds.map(id => renderNode(id, 0))}
        {entities.length === 0 && catalogCandidates.length === 0 && (
          <p style={{ padding: '1rem 0.75rem', fontSize: '0.82rem', color: 'var(--ink-faint)' }}>
            {isReviewingCatalog ? 'No places found. This may be a preamble or title section — click Skip to continue to the next section, or add a place manually.' : 'No entities in atlas yet.'}
          </p>
        )}
      </div>

      {/* Absorb action row */}
      {!readOnly && (
        <div style={{
          padding: '0.5rem 1.25rem',
          borderTop: selectedIds.length >= 1 ? '1px solid rgba(212,188,138,0.15)' : 'none',
          display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', flexShrink: 0,
        }}>
          {selectedIds.length === 0 && (
            <p style={{ fontSize: '0.72rem', color: 'var(--ink-faint)', margin: 0 }}>
              Click a place to inspect it. Click two to absorb.
            </p>
          )}
          {selectedIds.length === 1 && (
            <p style={{ fontSize: '0.72rem', color: 'var(--ink-muted)', margin: 0 }}>
              Click a second place to absorb it into <em>{entityMap.get(selectedIds[0])?.name}</em>.
            </p>
          )}
          {selectedIds.length === 2 && (
            <>
              <span style={{ fontSize: '0.72rem', color: 'var(--ink-muted)' }}>
                <strong style={{ color: 'var(--gold)' }}>1</strong> <em>{entityMap.get(selectedIds[0])?.name}</em>
                {' absorbs '}
                <strong style={{ color: 'var(--gold)' }}>2</strong> <em>{entityMap.get(selectedIds[1])?.name}</em>
              </span>
              <button
                type="button"
                onClick={onAbsorb}
                disabled={absorbing}
                style={{
                  fontSize: '0.72rem', padding: '0.22rem 0.65rem',
                  background: '#7f1d1d', border: 'none', borderRadius: '4px',
                  cursor: absorbing ? 'wait' : 'pointer',
                  color: '#fef2f2', opacity: absorbing ? 0.6 : 1,
                }}
              >
                {absorbing ? 'Absorbing…' : 'Absorb'}
              </button>
            </>
          )}
          {selectedIds.length > 0 && (
            <button
              type="button"
              onClick={onClearSelection}
              style={{ fontSize: '0.72rem', padding: '0.2rem 0.4rem', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-faint)', marginLeft: 'auto' }}
            >
              ×
            </button>
          )}
          {absorbMsg && (
            <span style={{ fontSize: '0.72rem', color: 'var(--ink-muted)', width: '100%' }}>{absorbMsg}</span>
          )}
        </div>
      )}

      {/* Confirm catalog sticky bar */}
      {onConfirmCatalog && (
        <div style={{
          flexShrink: 0, borderTop: '1px solid rgba(212,188,138,0.3)',
          padding: '0.55rem 1.25rem',
          background: 'rgba(212,188,138,0.06)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem',
        }}>
          <div style={{ flex: 1 }}>{confirmCatalogSlot}</div>
          <button
            type="button"
            onClick={onConfirmCatalog}
            disabled={confirmingCatalog}
            style={{
              fontSize: '0.78rem', padding: '0.32rem 0.9rem',
              background: 'var(--gold)', border: 'none', borderRadius: '4px',
              cursor: confirmingCatalog ? 'wait' : 'pointer',
              color: '#1a1008', fontWeight: 600,
              opacity: confirmingCatalog ? 0.6 : 1, flexShrink: 0,
            }}
          >
            {confirmingCatalog ? 'Confirming…' : 'Confirm catalog →'}
          </button>
        </div>
      )}
    </div>
  )
}
