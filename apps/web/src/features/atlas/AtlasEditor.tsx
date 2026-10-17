import { useCallback, useEffect, useRef, useState } from 'react'
import type { AtlasClaim, AtlasEntity } from './atlasApi'
import {
  createAtlasClaim,
  deleteAtlasEntity,
  deleteAtlasClaim,
  fetchAtlas,
  fetchEntityExcerpts,
  mergeEntities,
  patchAtlasClaim,
  patchAtlasEntity,
  promoteContainmentHierarchy,
} from './atlasApi'
import type { EntityExcerpt } from './atlasApi'

// Predicates managed by drag-and-drop or Absorb on the left — excluded from the right panel
const HIERARCHY_PREDICATES = new Set(['LOCATED_IN', 'CONTAINS'])  // CONTAINS kept for old DB data; SAME_AS is not spatial

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

// Predicates available in the right-panel "Add relationship" form
const RELATIONSHIP_PREDICATES = [
  'LEADS_TO',
  'ADJACENT_TO',
]

type PendingClaim = { id: string; subject: string; predicate: string; object: string }
type CatalogCandidate = { id: string; name: string; excerpt: string | null; source: string; isRejected: boolean; parentContext?: string | null; note?: string | null; sectionTitle?: string | null; spatialLevel?: number | null; placeType?: string | null }
type DedupProposal = { id: string; subject: string; object: string; rationale: string | null; isRejected: boolean }
type PendingVisualClaim = { id: string; subject: string; category: string; observation: string; excerpt: string | null; section_title: string | null }

interface Props {
  documentId: string
  onDone: () => void
  readOnly?: boolean
  canExplore?: boolean
  pendingClaims?: PendingClaim[]
  pendingVisualClaims?: PendingVisualClaim[]
  catalogCandidates?: CatalogCandidate[]
  onToggleCatalogReject?: (id: string) => void
  dedupProposals?: DedupProposal[]
  onToggleDedupReject?: (id: string) => void
  hideHeader?: boolean
  onConfirmCatalog?: () => void
  confirmingCatalog?: boolean
  onConfirmDedup?: () => void
  confirmingDedup?: boolean
  dedupConfirmCount?: number
  confirmCatalogSlot?: React.ReactNode
  isReviewingCatalog?: boolean
}

// ── Small shared selects ───────────────────────────────────────────────────────

function EntitySelect({
  entities, value, onChange, placeholder,
}: { entities: AtlasEntity[]; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        fontSize: '0.78rem', padding: '0.26rem 0.5rem',
        border: '1px solid var(--border-warm)', borderRadius: '3px',
        background: 'var(--parchment-alt)', color: 'var(--ink)',
        minWidth: '120px', maxWidth: '160px',
      }}
    >
      <option value="">{placeholder ?? 'Select…'}</option>
      {entities.map(e => (
        <option key={e.id} value={e.id}>{e.name}</option>
      ))}
    </select>
  )
}

function PredicateSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        fontSize: '0.72rem', padding: '0.26rem 0.4rem',
        border: '1px solid var(--border-warm)', borderRadius: '3px',
        background: 'var(--parchment-alt)', color: 'var(--ink-muted)',
        letterSpacing: '0.04em', maxWidth: '140px',
      }}
    >
      {RELATIONSHIP_PREDICATES.map(p => <option key={p} value={p}>{p}</option>)}
    </select>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function AtlasEditor({ documentId, onDone, readOnly = false, canExplore = true, pendingClaims = [], pendingVisualClaims = [], catalogCandidates = [], onToggleCatalogReject, dedupProposals = [], onToggleDedupReject, hideHeader = false, onConfirmCatalog, confirmingCatalog = false, onConfirmDedup, confirmingDedup = false, dedupConfirmCount = 0, confirmCatalogSlot, isReviewingCatalog = false }: Props) {
  const [entities, setEntities] = useState<AtlasEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)

  // Drag state
  const dragIdRef = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  // Catalog group 2 (Rooms & Features / L3) starts collapsed — too many entries in long books
  const [collapsedCatalogGroups, setCollapsedCatalogGroups] = useState<Set<number>>(new Set([2]))

  function toggleCollapsed(id: string) {
    setCollapsedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleCatalogGroup(groupId: number) {
    setCollapsedCatalogGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  // Add relationship form
  const [addingRel, setAddingRel] = useState(false)
  const [newRel, setNewRel] = useState({ subjectId: '', predicate: 'ADJACENT_TO', objectId: '' })

  // Inline edit state
  const [editingClaimId, setEditingClaimId] = useState<string | null>(null)
  const [editPred, setEditPred] = useState('')
  const [editObjId, setEditObjId] = useState('')

  // Left-panel selection (for Absorb / SAME_AS)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [absorbing, setAbsorbing] = useState(false)
  const [absorbMsg, setAbsorbMsg] = useState('')

  // Inline type/tier/level editing
  const [editingTypeId, setEditingTypeId] = useState<string | null>(null)
  const [editingTierId, setEditingTierId] = useState<string | null>(null)
  const [editingLevelId, setEditingLevelId] = useState<string | null>(null)

  // Excerpts for the selected entity
  const [excerpts, setExcerpts] = useState<EntityExcerpt[]>([])
  const [loadingExcerpts, setLoadingExcerpts] = useState(false)
  const [catalogTooltip, setCatalogTooltip] = useState<{ id: string; x: number; y: number } | null>(null)

  const [arrangingHierarchy, setArrangingHierarchy] = useState(false)

  // Containment filter toggle (SAME_AS always excluded from relationships panel)
  const [showContainment, setShowContainment] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchAtlas(documentId)
      setEntities(data.entities)
    } finally {
      setLoading(false)
    }
  }, [documentId])

  useEffect(() => { load() }, [load])

  // Auto-expand Rooms & Features when catalog review starts
  useEffect(() => {
    if (isReviewingCatalog) {
      setCollapsedCatalogGroups(prev => {
        if (!prev.has(2)) return prev
        const next = new Set(prev)
        next.delete(2)
        return next
      })
    }
  }, [isReviewingCatalog])

  // ── Derived hierarchy ────────────────────────────────────────────────────────

  const entityMap = new Map(entities.map(e => [e.id, e]))

  const parentOf = new Map<string, string>()
  // inverse=true means the parent relationship came from a CONTAINS claim on the parent entity
  const parentClaimOf = new Map<string, { claim: AtlasClaim; inverse: boolean }>()

  // Pass 1: LOCATED_IN / PART_OF — direct parent relationships (highest priority)
  for (const entity of entities) {
    for (const claim of entity.claims) {
      if (
        claim.claim_type === 'spatial' &&
        (claim.predicate === 'LOCATED_IN' || claim.predicate === 'PART_OF') &&
        claim.object_refs?.[0] &&
        entityMap.has(claim.object_refs[0])
      ) {
        parentOf.set(entity.id, claim.object_refs[0])
        parentClaimOf.set(entity.id, { claim, inverse: false })
        break
      }
    }
  }

  // Pass 2: CONTAINS — inverse parent relationships (only where not already set)
  for (const entity of entities) {
    for (const claim of entity.claims) {
      if (
        claim.claim_type === 'spatial' &&
        claim.predicate === 'CONTAINS' &&
        claim.object_refs?.[0] &&
        entityMap.has(claim.object_refs[0])
      ) {
        const childId = claim.object_refs[0]
        if (!parentOf.has(childId)) {
          parentOf.set(childId, entity.id)
          parentClaimOf.set(childId, { claim, inverse: true })
        }
      }
    }
  }

  const childrenOf = new Map<string, string[]>()
  for (const e of entities) childrenOf.set(e.id, [])
  for (const [childId, parentId] of parentOf) {
    childrenOf.get(parentId)?.push(childId)
  }

  const rootIds = entities
    .filter(e => !parentOf.has(e.id))
    .map(e => e.id)
    .sort((a, b) => (entityMap.get(a)?.name ?? '').localeCompare(entityMap.get(b)?.name ?? ''))

  // Depth in containment hierarchy — used as fallback when payload.spatial_level is absent
  const depthOf = new Map<string, number>()
  const computeDepth = (id: string, visited = new Set<string>()): number => {
    if (depthOf.has(id)) return depthOf.get(id)!
    if (visited.has(id)) return 0
    visited.add(id)
    const parent = parentOf.get(id)
    const d = parent ? 1 + computeDepth(parent, visited) : 0
    depthOf.set(id, d)
    return d
  }
  for (const e of entities) computeDepth(e.id)

  // Right panel: synthesized spatial claims, filtered by containment toggle
  const allSpatialClaims = entities.flatMap(e =>
    e.claims.filter(c => c.claim_type === 'spatial')
  )
  const CONTAINMENT_ONLY = new Set(['LOCATED_IN', 'CONTAINS'])
  const spatialClaims = allSpatialClaims.filter(c => {
    const pred = c.predicate ?? ''
    if (pred === 'SAME_AS') return false
    if (!showContainment && CONTAINMENT_ONLY.has(pred)) return false
    return true
  })

  // Pending claims from evidence extraction (shown when no synthesized claims exist yet)
  const filteredPendingClaims = (pendingClaims ?? []).filter(c => {
    if (c.predicate === 'SAME_AS') return false
    if (!showContainment && CONTAINMENT_ONLY.has(c.predicate)) return false
    return true
  })
  const showingPending = allSpatialClaims.filter(c => c.predicate !== 'SAME_AS').length === 0 && filteredPendingClaims.length > 0
  const sortedEntities = [...entities].sort((a, b) => a.name.localeCompare(b.name))

  // Focused entity drives center detail panel + right panel entity filter
  const focusedId = selectedIds[0] ?? null
  const focusedEntity = focusedId ? entityMap.get(focusedId) : null

  // Right panel: filter claims to focused entity when one is selected
  const visibleSpatialClaims = focusedId
    ? spatialClaims.filter(c => c.subject_ref === focusedId || (c.object_refs ?? []).includes(focusedId))
    : spatialClaims

  // ── Drag-and-drop handlers ───────────────────────────────────────────────────

  // Find ALL CONTAINS claims on any entity that list dragId as an object ref.
  // These become stale whenever dragId is reparented and must be deleted.
  function staleContainsClaims(dragId: string): AtlasClaim[] {
    const stale: AtlasClaim[] = []
    for (const entity of entities) {
      for (const claim of entity.claims) {
        if (claim.predicate === 'CONTAINS' && claim.object_refs?.includes(dragId)) {
          stale.push(claim)
        }
      }
    }
    return stale
  }

  async function handleDrop(targetId: string | 'root') {
    const dragId = dragIdRef.current
    if (!dragId || dragId === targetId) return
    setSaving(dragId)
    try {
      const existing = parentClaimOf.get(dragId)
      if (targetId === 'root') {
        // Remove the parent claim and any CONTAINS claims pointing to dragId
        if (existing) await deleteAtlasClaim(documentId, existing.claim.id)
        for (const c of staleContainsClaims(dragId)) {
          if (c.id !== existing?.claim.id) await deleteAtlasClaim(documentId, c.id)
        }
      } else {
        // Cycle check: walk up from targetId — if we reach dragId it's a cycle
        let cur: string | undefined = targetId
        while (cur) {
          if (cur === dragId) { setSaving(null); return }
          cur = parentOf.get(cur)
        }
        // Delete all CONTAINS claims on other entities that reference dragId — they're now stale
        for (const c of staleContainsClaims(dragId)) {
          await deleteAtlasClaim(documentId, c.id)
        }
        if (existing && !existing.inverse) {
          // Direct LOCATED_IN/PART_OF claim — patch object in place
          await patchAtlasClaim(documentId, existing.claim.id, { object_refs: [targetId] })
        } else {
          await createAtlasClaim(documentId, {
            predicate: 'LOCATED_IN',
            subject_ref: dragId,
            object_refs: [targetId],
          })
        }
      }
      await load()
    } finally {
      setSaving(null)
      dragIdRef.current = null
      setDropTarget(null)
    }
  }

  // ── Tree renderer ────────────────────────────────────────────────────────────

  function handleSelectNode(id: string) {
    setAbsorbMsg('')
    setSelectedIds(prev => {
      const next = (() => {
        if (prev[0] === id) return prev.length === 2 ? [prev[1]] : []
        if (prev[1] === id) return [prev[0]]
        if (prev.length < 2) return [...prev, id]
        return [prev[0], id]
      })()
      // Fetch excerpts for the first selected entity
      const primary = next[0]
      if (primary && primary !== prev[0]) {
        setExcerpts([])
        setLoadingExcerpts(true)
        fetchEntityExcerpts(documentId, primary)
          .then(setExcerpts)
          .finally(() => setLoadingExcerpts(false))
      } else if (!primary) {
        setExcerpts([])
      }
      return next
    })
  }

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
            onClick: () => handleSelectNode(id),
            onMouseEnter: () => setHoveredId(id),
            onMouseLeave: () => setHoveredId(prev => prev === id ? null : prev),
            onDragStart: (e: React.DragEvent) => { e.stopPropagation(); dragIdRef.current = id },
            onDragEnd: () => { dragIdRef.current = null; setDropTarget(null) },
            onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (dragIdRef.current && dragIdRef.current !== id) setDropTarget(id) },
            onDragLeave: (e: React.DragEvent) => { e.stopPropagation(); setDropTarget(prev => prev === id ? null : prev) },
            onDrop: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); handleDrop(id) },
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
              onClick={e => { e.stopPropagation(); toggleCollapsed(id) }}
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
          <span style={{ fontSize: '0.86rem', color: 'var(--ink)', flex: 1 }}>
            {entity.name}
          </span>
          {!readOnly && editingLevelId === id ? (
            <select
              autoFocus
              value={entity.payload.spatial_level != null ? String(entity.payload.spatial_level) : ''}
              onClick={e => e.stopPropagation()}
              onChange={e => handlePatchLevel(id, e.target.value)}
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
              onChange={e => handlePatchType(id, e.target.value)}
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
              onChange={e => handlePatchTier(id, e.target.value)}
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
                        width: '11px',
                        height: '11px',
                        borderRadius: '0',
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
              onClick={(e) => { e.stopPropagation(); handleDeleteEntity(id) }}
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

  // ── Claim operations ─────────────────────────────────────────────────────────

  async function handlePatchType(entityId: string, placeKind: string) {
    setSaving(entityId)
    setEditingTypeId(null)
    try { await patchAtlasEntity(documentId, entityId, { place_kind: placeKind }); await load() }
    finally { setSaving(null) }
  }

  async function handlePatchTier(entityId: string, tier: string) {
    setSaving(entityId)
    setEditingTierId(null)
    try { await patchAtlasEntity(documentId, entityId, { tier }); await load() }
    finally { setSaving(null) }
  }

  async function handlePatchLevel(entityId: string, level: string) {
    setSaving(entityId)
    setEditingLevelId(null)
    const spatial_level = level === '' ? -1 : parseInt(level, 10)
    try { await patchAtlasEntity(documentId, entityId, { spatial_level }); await load() }
    finally { setSaving(null) }
  }

  async function handleDeleteEntity(entityId: string) {
    setSaving(entityId)
    try {
      await deleteAtlasEntity(documentId, entityId)
      setSelectedIds(prev => prev.filter(id => id !== entityId))
      await load()
    } finally { setSaving(null) }
  }

  async function handleDeleteClaim(claimId: string) {
    setSaving(claimId)
    try { await deleteAtlasClaim(documentId, claimId); await load() } finally { setSaving(null) }
  }

  async function handleAddRel() {
    if (!newRel.subjectId || !newRel.objectId) return
    setSaving('new')
    try {
      await createAtlasClaim(documentId, {
        predicate: newRel.predicate,
        subject_ref: newRel.subjectId,
        object_refs: [newRel.objectId],
      })
      setNewRel({ subjectId: '', predicate: 'ADJACENT_TO', objectId: '' })
      setAddingRel(false)
      await load()
    } finally { setSaving(null) }
  }

  async function handleSaveEdit(claimId: string) {
    setSaving(claimId)
    try {
      await patchAtlasClaim(documentId, claimId, {
        predicate: editPred || undefined,
        object_refs: editObjId ? [editObjId] : undefined,
      })
      setEditingClaimId(null)
      await load()
    } finally { setSaving(null) }
  }

  async function handleAbsorb() {
    const [keepId, dropId] = selectedIds
    if (!keepId || !dropId) return
    setAbsorbing(true)
    setAbsorbMsg('')
    try {
      const result = await mergeEntities(keepId, dropId)
      setAbsorbMsg(`Absorbed into "${result.canonical_entity_name}"`)
      setSelectedIds([])
      await load()
    } catch {
      setAbsorbMsg('Absorb failed — check that both entities exist.')
    } finally { setAbsorbing(false) }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--ink-muted)' }}>
        Loading atlas…
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--parchment)', fontFamily: 'inherit' }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      {!hideHeader && (
        <div style={{
          padding: '0.9rem 2rem',
          borderBottom: '1px solid var(--border-warm)',
          display: 'flex', alignItems: 'center',
          flexShrink: 0,
        }}>
          {/* Left: title + badge */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <div style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--ink)' }}>Atlas Editor</div>
            {readOnly && (
              <span style={{
                fontSize: '0.52rem', fontWeight: 700, letterSpacing: '0.14em',
                color: 'rgba(180,120,20,0.9)', background: 'rgba(180,120,20,0.1)',
                border: '1px solid rgba(180,120,20,0.35)', borderRadius: '3px',
                padding: '0.18rem 0.45rem', textTransform: 'uppercase', lineHeight: 1,
              }}>
                Read only
              </span>
            )}
          </div>
          {/* Right: summary */}
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--ink-faint)', fontFamily: 'monospace' }}>
              {entities.length} {entities.length === 1 ? 'place' : 'places'} | {spatialClaims.length} {spatialClaims.length === 1 ? 'relationship' : 'relationships'}
            </span>
          </div>
        </div>
      )}

      {/* ── Three-panel body ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── Left: Containment tree ──────────────────────────────────────── */}
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
                  onClick={async () => {
                    setArrangingHierarchy(true)
                    try { await promoteContainmentHierarchy(documentId); await load() } catch { /* ignore */ } finally { setArrangingHierarchy(false) }
                  }}
                  title="Auto-build hierarchy from LOCATED_IN spatial claims"
                  style={{ fontSize: '0.62rem', padding: '0.15rem 0.45rem', background: 'none', border: '1px solid var(--sidebar-border)', borderRadius: '3px', cursor: arrangingHierarchy ? 'wait' : 'pointer', color: 'var(--gold)', opacity: arrangingHierarchy ? 0.5 : 1, flexShrink: 0 }}
                >
                  {arrangingHierarchy ? 'Arranging…' : 'Auto-arrange'}
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
              onDrop: (e: React.DragEvent) => { e.preventDefault(); handleDrop('root') },
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

          {/* Tree */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '0.35rem 0.5rem 1rem' }}>
            {/* Catalog candidates — grouped by spatial level */}
            {catalogCandidates.length > 0 && (() => {
              const CATALOG_GROUPS = [
                { id: 0, label: 'Realms & Regions', color: '#C9A84C', test: (lvl: number | null | undefined) => lvl === 0 || lvl === 1 },
                { id: 1, label: 'Places & Structures', color: '#7A9BB5', test: (lvl: number | null | undefined) => lvl === 2 },
                { id: 2, label: 'Rooms & Features', color: '#8FAF8F', test: (lvl: number | null | undefined) => lvl === 3 || lvl == null },
              ]
              return CATALOG_GROUPS.map(group => {
                const members = catalogCandidates.filter(c => group.test(c.spatialLevel))
                if (members.length === 0) return null
                const collapsed = collapsedCatalogGroups.has(group.id)
                const kept = members.filter(c => !c.isRejected).length
                return (
                  <div key={group.id}>
                    <div
                      onClick={() => toggleCatalogGroup(group.id)}
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
                        {kept < members.length ? `${kept} / ${members.length}` : members.length}
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
              })
            })()}
            {/* Real entity tree */}
            {rootIds.map(id => renderNode(id, 0))}
            {entities.length === 0 && catalogCandidates.length === 0 && (
              <p style={{ padding: '1rem 0.75rem', fontSize: '0.82rem', color: 'var(--ink-faint)' }}>
                {isReviewingCatalog ? 'No places found. This may be a preamble or title section — click Skip to continue to the next section, or add a place manually.' : 'No entities in atlas yet.'}
              </p>
            )}
          </div>

          {/* Absorb action row */}
          {!readOnly && <div style={{
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
                    onClick={handleAbsorb}
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
                  onClick={() => { setSelectedIds([]); setAbsorbMsg(''); setExcerpts([]) }}
                  style={{ fontSize: '0.72rem', padding: '0.2rem 0.4rem', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-faint)', marginLeft: 'auto' }}
                >
                  ×
                </button>
              )}
              {absorbMsg && (
                <span style={{ fontSize: '0.72rem', color: 'var(--ink-muted)', width: '100%' }}>{absorbMsg}</span>
              )}
          </div>}

          {/* Confirm catalog sticky bar — shown whenever handler is provided, even with 0 gap candidates */}
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

        {/* ── Center: Entity detail ───────────────────────────────────────── */}
        <div style={{
          width: 'calc(100% / 3)', flexShrink: 0,
          borderRight: '1px solid var(--border-warm)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{ padding: '0.8rem 1.25rem 0.5rem', borderBottom: '1px solid rgba(212,188,138,0.25)', flexShrink: 0 }}>
            <div style={{ fontSize: '0.58rem', color: 'var(--ink-faint)', letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: '0.22rem' }}>
              Place Detail
            </div>
            {focusedEntity ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.88rem', color: 'var(--ink)', fontWeight: 600 }}>{focusedEntity.name}</span>
                {(() => {
                  const colors = focusedEntity.payload.colors as { primary?: string; atmosphere?: string; accent?: string } | undefined
                  return (
                    <span style={{ display: 'flex', gap: '4px', flexShrink: 0, alignItems: 'center' }}>
                      {(['primary', 'atmosphere', 'accent'] as const).map(role => {
                        const hex = colors?.[role]
                        return (
                          <span key={role} title={hex ? `${role}: ${hex}` : `${role}: none`} style={{
                            width: '10px', height: '10px', borderRadius: '2px', flexShrink: 0,
                            background: hex ?? 'transparent',
                            border: hex ? '1px solid rgba(0,0,0,0.15)' : '1px dashed rgba(212,188,138,0.3)',
                          }} />
                        )
                      })}
                    </span>
                  )
                })()}
                {selectedIds.length === 2 && (
                  <span style={{ fontSize: '0.65rem', color: 'var(--ink-faint)', fontStyle: 'italic' }}>
                    · absorbs {entityMap.get(selectedIds[1])?.name}
                  </span>
                )}
              </div>
            ) : (
              <div style={{ fontSize: '0.73rem', color: 'var(--ink-faint)', fontStyle: 'italic' }}>
                Click a place to inspect it
              </div>
            )}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '0.6rem 1.25rem 1rem' }}>
            {focusedEntity ? (
              <>
                {loadingExcerpts && (
                  <p style={{ fontSize: '0.75rem', color: 'var(--ink-faint)', margin: 0 }}>Loading excerpts…</p>
                )}
                {!loadingExcerpts && excerpts.length === 0 && (
                  <p style={{ fontSize: '0.75rem', color: 'var(--ink-faint)', margin: 0, fontStyle: 'italic' }}>No excerpts found for this place.</p>
                )}
                {!loadingExcerpts && excerpts.map((ex, i) => (
                  <div key={i} style={{ marginBottom: '0.6rem' }}>
                    {ex.section_title && (
                      <div style={{ fontSize: '0.58rem', color: 'var(--gold)', opacity: 0.7, marginBottom: '0.15rem', letterSpacing: '0.04em' }}>
                        {ex.section_title}
                      </div>
                    )}
                    <p style={{
                      fontSize: '0.78rem', color: 'var(--ink-muted)', margin: 0,
                      lineHeight: 1.55, fontStyle: 'italic',
                      borderLeft: '2px solid rgba(212,188,138,0.3)', paddingLeft: '0.6rem',
                    }}>
                      "{ex.excerpt}"
                    </p>
                  </div>
                ))}
                {(() => {
                  if (pendingVisualClaims.length > 0) {
                    const names = new Set([
                      focusedEntity.name.toLowerCase(),
                      ...(focusedEntity.aliases ?? []).map(a => a.toLowerCase()),
                    ])
                    const matching = pendingVisualClaims.filter(v => names.has(v.subject.toLowerCase()))
                    if (matching.length === 0) return null
                    return (
                      <div style={{ marginTop: '0.75rem' }}>
                        <div style={{ fontSize: '0.58rem', color: 'var(--ink-faint)', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: '0.4rem', borderTop: '1px solid rgba(212,188,138,0.15)', paddingTop: '0.55rem' }}>
                          Visual observations · {matching.length}
                        </div>
                        {matching.map(v => (
                          <div key={v.id} style={{ marginBottom: '0.55rem' }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', marginBottom: '0.15rem' }}>
                              {v.section_title && (
                                <span style={{ fontSize: '0.58rem', color: 'var(--gold)', opacity: 0.7, letterSpacing: '0.04em' }}>{v.section_title}</span>
                              )}
                              <span style={{ fontSize: '0.55rem', color: 'var(--ink-faint)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{v.category}</span>
                            </div>
                            <p style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', margin: 0, lineHeight: 1.5, borderLeft: '2px solid rgba(139,171,202,0.35)', paddingLeft: '0.6rem' }}>
                              {v.observation}
                            </p>
                            {v.excerpt && v.excerpt !== v.observation && (
                              <p style={{ fontSize: '0.72rem', color: 'var(--ink-faint)', margin: '0.2rem 0 0 0.6rem', lineHeight: 1.4, fontStyle: 'italic' }}>
                                "{v.excerpt}"
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )
                  }
                  const visualClaims = (focusedEntity.claims ?? []).filter(c => c.claim_type === 'visual')
                  if (visualClaims.length === 0) return null
                  return (
                    <div style={{ marginTop: '0.75rem' }}>
                      <div style={{ fontSize: '0.58rem', color: 'var(--ink-faint)', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: '0.4rem', borderTop: '1px solid rgba(212,188,138,0.15)', paddingTop: '0.55rem' }}>
                        Visual observations · {visualClaims.length}
                      </div>
                      {visualClaims.map(v => {
                        const category = String(v.payload.category ?? v.payload.visual_property ?? '')
                        const observation = String(v.payload.observation ?? v.payload.value ?? '')
                        return (
                          <div key={v.id} style={{ marginBottom: '0.55rem' }}>
                            {category && (
                              <span style={{ fontSize: '0.55rem', color: 'var(--ink-faint)', letterSpacing: '0.06em', textTransform: 'uppercase', display: 'block', marginBottom: '0.15rem' }}>{category}</span>
                            )}
                            <p style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', margin: 0, lineHeight: 1.5, borderLeft: '2px solid rgba(139,171,202,0.35)', paddingLeft: '0.6rem' }}>
                              {observation}
                            </p>
                            {v.excerpt && v.excerpt !== observation && (
                              <p style={{ fontSize: '0.72rem', color: 'var(--ink-faint)', margin: '0.2rem 0 0 0.6rem', lineHeight: 1.4, fontStyle: 'italic' }}>
                                "{v.excerpt}"
                              </p>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </>
            ) : (
              <p style={{ fontSize: '0.78rem', color: 'var(--ink-faint)', margin: 0, fontStyle: 'italic', lineHeight: 1.6 }}>
                Select a place in the containment tree to see its excerpts and visual observations here.
              </p>
            )}
          </div>
        </div>

        {/* ── Right: Relationships ─────────────────────────────────────────── */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

          {/* Spatial relationships panel */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{
              padding: '0.8rem 1.5rem 0.5rem',
              borderBottom: '1px solid rgba(212,188,138,0.25)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              flexShrink: 0,
            }}>
              <div>
                <div style={{ fontSize: '0.58rem', color: 'var(--ink-faint)', letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: '0.22rem' }}>
                  Spatial Relationships
                </div>
                <div style={{ fontSize: '0.73rem', color: 'var(--ink-muted)' }}>
                  {showingPending
                    ? `${filteredPendingClaims.length} pending`
                    : focusedId
                      ? `${visibleSpatialClaims.length} of ${spatialClaims.length} claim${spatialClaims.length !== 1 ? 's' : ''}`
                      : `${spatialClaims.length} claim${spatialClaims.length !== 1 ? 's' : ''}`}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => setShowContainment(v => !v)}
                  style={{
                    fontSize: '0.62rem', padding: '0.18rem 0.5rem',
                    border: '1px solid var(--border-warm)',
                    borderRadius: '4px', cursor: 'pointer',
                    background: showContainment ? 'rgba(212,188,138,0.18)' : 'var(--parchment-alt)',
                    color: showContainment ? 'var(--ink-muted)' : 'var(--ink-faint)',
                    fontWeight: showContainment ? 500 : 400,
                  }}
                >
                  {showContainment ? '✓' : '○'} Containment
                </button>
                {!readOnly && !addingRel && (
                  <button
                    type="button"
                    onClick={() => setAddingRel(true)}
                    style={{
                      fontSize: '0.75rem', padding: '0.28rem 0.72rem',
                      background: 'none', border: '1px solid var(--border-warm)',
                      borderRadius: '4px', cursor: 'pointer', color: 'var(--ink-muted)',
                    }}
                  >
                    + Add
                  </button>
                )}
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '0.4rem 1.5rem 1rem' }}>
              {/* Dedup merge proposals */}
              {dedupProposals.length > 0 && (
                <div style={{ marginBottom: '0.85rem' }}>
                  <div style={{ fontSize: '0.58rem', color: 'var(--ink-faint)', letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: '0.4rem' }}>
                    Merge proposals — click to reject
                  </div>
                  {dedupProposals.map(p => (
                    <div
                      key={p.id}
                      onClick={() => onToggleDedupReject?.(p.id)}
                      style={{
                        display: 'flex', flexDirection: 'column',
                        padding: '0.35rem 0.6rem', marginBottom: '0.18rem',
                        borderRadius: '4px', fontSize: '0.82rem',
                        border: '1px solid rgba(212,188,138,0.2)',
                        opacity: p.isRejected ? 0.4 : 1,
                        cursor: 'pointer',
                        background: p.isRejected ? 'transparent' : 'rgba(212,188,138,0.04)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{
                          width: '0.75rem', height: '0.75rem', borderRadius: '50%', flexShrink: 0,
                          border: p.isRejected ? '1px solid rgba(180,60,60,0.5)' : '1px solid var(--gold)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '0.38rem', color: p.isRejected ? 'rgba(180,60,60,0.7)' : 'var(--gold)',
                        }}>
                          {p.isRejected ? '✕' : '='}
                        </span>
                        <span style={{ color: 'var(--ink)', fontWeight: 500, textDecoration: p.isRejected ? 'line-through' : 'none' }}>{p.subject}</span>
                        <span style={{ color: 'var(--ink-faint)', fontSize: '0.75rem' }}>=</span>
                        <span style={{ color: 'var(--ink)', fontWeight: 500, textDecoration: p.isRejected ? 'line-through' : 'none' }}>{p.object}</span>
                      </div>
                      {p.rationale && !p.isRejected && (
                        <div style={{ fontSize: '0.68rem', color: 'var(--ink-faint)', marginTop: '0.15rem', marginLeft: '1.2rem', lineHeight: 1.3 }}>
                          {p.rationale}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {/* Add relationship form */}
              {!readOnly && addingRel && (
                <div style={{
                  display: 'flex', gap: '0.45rem', alignItems: 'center', flexWrap: 'wrap',
                  padding: '0.55rem 0.75rem', marginBottom: '0.4rem',
                  background: 'rgba(212,188,138,0.07)', borderRadius: '4px',
                  border: '1px solid var(--border-warm)',
                }}>
                  <EntitySelect entities={sortedEntities} value={newRel.subjectId} onChange={v => setNewRel(r => ({ ...r, subjectId: v }))} placeholder="Subject…" />
                  <PredicateSelect value={newRel.predicate} onChange={v => setNewRel(r => ({ ...r, predicate: v }))} />
                  <EntitySelect entities={sortedEntities} value={newRel.objectId} onChange={v => setNewRel(r => ({ ...r, objectId: v }))} placeholder="Object…" />
                  <button
                    type="button"
                    onClick={handleAddRel}
                    disabled={!newRel.subjectId || !newRel.objectId || saving === 'new'}
                    style={{
                      fontSize: '0.75rem', padding: '0.26rem 0.65rem',
                      background: 'var(--gold)', border: 'none', borderRadius: '3px',
                      cursor: newRel.subjectId && newRel.objectId ? 'pointer' : 'not-allowed',
                      color: '#1a1008',
                      opacity: !newRel.subjectId || !newRel.objectId || saving === 'new' ? 0.5 : 1,
                    }}
                  >
                    {saving === 'new' ? '…' : 'Add'}
                  </button>
                  <button type="button" onClick={() => setAddingRel(false)} style={{ fontSize: '0.82rem', padding: '0.2rem 0.4rem', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-faint)' }}>×</button>
                </div>
              )}

              {/* Claims list (filtered to focused entity when one is selected) */}
              {[...visibleSpatialClaims]
                .sort((a, b) => {
                  const sa = entityMap.get(a.subject_ref ?? '')?.name ?? ''
                  const sb = entityMap.get(b.subject_ref ?? '')?.name ?? ''
                  return sa.localeCompare(sb) || (a.predicate ?? '').localeCompare(b.predicate ?? '')
                })
                .map(claim => {
                  const subjName = entityMap.get(claim.subject_ref ?? '')?.name
                    ?? String(claim.payload.subject ?? claim.subject_ref ?? '—')
                  const objId = claim.object_refs?.[0]
                  const objName = (objId ? entityMap.get(objId)?.name : undefined)
                    ?? String(claim.payload.object ?? objId ?? '—')
                  const isEditing = editingClaimId === claim.id
                  const isSaving = saving === claim.id

                  return (
                    <div
                      key={claim.id}
                      style={{
                        display: 'flex', gap: '0.45rem', alignItems: 'center',
                        padding: '0.38rem 0.6rem', marginBottom: '0.18rem',
                        borderRadius: '4px', fontSize: '0.82rem',
                        background: isEditing ? 'rgba(212,188,138,0.08)' : 'transparent',
                        border: isEditing ? '1px solid var(--border-warm)' : '1px solid transparent',
                        opacity: isSaving ? 0.45 : 1,
                        transition: 'opacity 0.15s',
                      }}
                    >
                      {isEditing ? (
                        <>
                          <span style={{ color: 'var(--ink)', flexShrink: 0 }}>{subjName}</span>
                          <PredicateSelect value={editPred} onChange={setEditPred} />
                          <EntitySelect entities={sortedEntities} value={editObjId} onChange={setEditObjId} placeholder="Object…" />
                          <button type="button" onClick={() => handleSaveEdit(claim.id)} disabled={isSaving} style={{ fontSize: '0.72rem', padding: '0.22rem 0.55rem', background: 'var(--gold)', border: 'none', borderRadius: '3px', cursor: 'pointer', color: '#1a1008' }}>Save</button>
                          <button type="button" onClick={() => setEditingClaimId(null)} style={{ fontSize: '0.8rem', padding: '0.2rem 0.4rem', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-faint)' }}>×</button>
                        </>
                      ) : (
                        <>
                          <span style={{ color: 'var(--ink)', flexShrink: 0 }}>{subjName}</span>
                          <span style={{ color: 'var(--ink-faint)', fontSize: '0.68rem', letterSpacing: '0.05em', flexShrink: 0, fontVariant: 'small-caps' }}>{claim.predicate ?? '?'}</span>
                          <span style={{
                            color: objId ? 'var(--ink)' : 'var(--ink-faint)',
                            flexShrink: 0, fontStyle: objId ? 'normal' : 'italic',
                          }}>{objName}</span>
                          {!readOnly && <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.22rem', flexShrink: 0 }}>
                            <button
                              type="button"
                              onClick={() => { setEditingClaimId(claim.id); setEditPred(claim.predicate ?? 'LOCATED_IN'); setEditObjId(objId ?? '') }}
                              style={{ fontSize: '0.66rem', padding: '0.14rem 0.4rem', background: 'none', border: '1px solid var(--border-warm)', borderRadius: '3px', cursor: 'pointer', color: 'var(--ink-muted)' }}
                            >
                              edit
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteClaim(claim.id)}
                              disabled={isSaving}
                              style={{ fontSize: '0.66rem', padding: '0.14rem 0.4rem', background: 'none', border: '1px solid rgba(180,80,80,0.4)', borderRadius: '3px', cursor: 'pointer', color: '#c06060' }}
                            >
                              del
                            </button>
                          </div>}
                        </>
                      )}
                    </div>
                  )
                })}

              {/* Pending claims (evidence candidates from step 2, before synthesis) */}
              {showingPending && filteredPendingClaims.map(c => (
                <div
                  key={c.id}
                  style={{
                    display: 'flex', gap: '0.45rem', alignItems: 'center',
                    padding: '0.38rem 0.6rem', marginBottom: '0.18rem',
                    borderRadius: '4px', fontSize: '0.82rem',
                    background: 'transparent',
                    border: '1px solid rgba(212,188,138,0.15)',
                    opacity: 0.65,
                  }}
                >
                  <span style={{ color: 'var(--ink)', flexShrink: 0 }}>{c.subject}</span>
                  <span style={{ color: 'var(--ink-faint)', fontSize: '0.68rem', letterSpacing: '0.05em', flexShrink: 0 }}>{c.predicate}</span>
                  <span style={{ color: 'var(--ink)', flexShrink: 0 }}>{c.object}</span>
                  <span style={{ marginLeft: 'auto', fontSize: '0.6rem', color: 'var(--ink-faint)', flexShrink: 0 }}>pending</span>
                </div>
              ))}

              {visibleSpatialClaims.length === 0 && !showingPending && !addingRel && (
                <p style={{ padding: '0.75rem 0', fontSize: '0.82rem', color: 'var(--ink-faint)' }}>
                  {focusedId
                    ? `No relationships for ${focusedEntity?.name ?? 'this place'} yet.`
                    : 'No spatial relationships yet — add one with + Add above.'}
                </p>
              )}
            </div>

            {/* Confirm merges sticky bar */}
            {dedupProposals.length > 0 && onConfirmDedup && (
              <div style={{
                flexShrink: 0, borderTop: '1px solid rgba(212,188,138,0.3)',
                padding: '0.55rem 1.5rem',
                background: 'rgba(212,188,138,0.06)',
                display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
              }}>
                <button
                  type="button"
                  onClick={onConfirmDedup}
                  disabled={confirmingDedup}
                  style={{
                    fontSize: '0.78rem', padding: '0.32rem 0.9rem',
                    background: 'var(--gold)', border: 'none', borderRadius: '4px',
                    cursor: confirmingDedup ? 'wait' : 'pointer',
                    color: '#1a1008', fontWeight: 600,
                    opacity: confirmingDedup ? 0.6 : 1,
                  }}
                >
                  {confirmingDedup ? 'Confirming…' : `Confirm ${dedupConfirmCount} merge${dedupConfirmCount !== 1 ? 's' : ''} →`}
                </button>
              </div>
            )}
          </div>

        </div>
      </div>

      {/* Catalog candidate excerpt tooltip — fixed, no layout shift */}
      {catalogTooltip && (() => {
        const c = catalogCandidates.find(x => x.id === catalogTooltip.id)
        if (!c?.excerpt) return null
        return (
          <div style={{
            position: 'fixed',
            left: catalogTooltip.x,
            top: catalogTooltip.y,
            zIndex: 1000,
            background: 'var(--parchment-card)',
            border: '1px solid var(--border-warm)',
            borderRadius: '5px',
            padding: '0.65rem 0.9rem',
            maxWidth: '340px',
            minWidth: '180px',
            fontSize: '0.78rem',
            color: 'var(--ink)',
            lineHeight: 1.6,
            boxShadow: '0 4px 18px rgba(0,0,0,0.22)',
            pointerEvents: 'none',
          }}>
            <div style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--ink-faint)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '0.35rem' }}>
              {c.name}
            </div>
            <span style={{ fontStyle: 'italic', color: 'var(--ink-muted)' }}>"{c.excerpt}"</span>
          </div>
        )
      })()}

    </div>
  )
}
