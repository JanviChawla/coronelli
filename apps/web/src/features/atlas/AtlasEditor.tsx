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
import { buildHierarchy } from './atlasHierarchy'
import { AtlasHierarchyTree } from './AtlasHierarchyTree'
import { AtlasDetailPanel } from './AtlasDetailPanel'
import { AtlasRelationshipsPanel } from './AtlasRelationshipsPanel'

// ── Shared local types (exported for sub-panels) ──────────────────────────────

export type PendingClaim = { id: string; subject: string; predicate: string; object: string }
export type CatalogCandidate = { id: string; name: string; excerpt: string | null; source: string; isRejected: boolean; parentContext?: string | null; note?: string | null; sectionTitle?: string | null; spatialLevel?: number | null; placeType?: string | null }
export type DedupProposal = { id: string; subject: string; object: string; rationale: string | null; isRejected: boolean }
export type PendingVisualClaim = { id: string; subject: string; category: string; observation: string; excerpt: string | null; section_title: string | null }

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

// ── Main component ────────────────────────────────────────────────────────────

export function AtlasEditor({
  documentId, onDone, readOnly = false, canExplore = true,
  pendingClaims = [], pendingVisualClaims = [], catalogCandidates = [],
  onToggleCatalogReject, dedupProposals = [], onToggleDedupReject,
  hideHeader = false, onConfirmCatalog, confirmingCatalog = false,
  onConfirmDedup, confirmingDedup = false, dedupConfirmCount = 0,
  confirmCatalogSlot, isReviewingCatalog = false,
}: Props) {
  const [entities, setEntities] = useState<AtlasEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)

  // Drag state
  const dragIdRef = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  // Catalog group 2 (Rooms & Features / L3) starts collapsed
  const [collapsedCatalogGroups, setCollapsedCatalogGroups] = useState<Set<number>>(new Set([2]))

  // Left-panel selection (for Absorb / SAME_AS)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [absorbing, setAbsorbing] = useState(false)
  const [absorbMsg, setAbsorbMsg] = useState('')

  // Inline name/type/tier/level editing
  const [editingNameId, setEditingNameId] = useState<string | null>(null)
  const [editingNameValue, setEditingNameValue] = useState('')
  const [editingTypeId, setEditingTypeId] = useState<string | null>(null)
  const [editingTierId, setEditingTierId] = useState<string | null>(null)
  const [editingLevelId, setEditingLevelId] = useState<string | null>(null)

  // Excerpts for the selected entity
  const [excerpts, setExcerpts] = useState<EntityExcerpt[]>([])
  const [loadingExcerpts, setLoadingExcerpts] = useState(false)
  const [catalogTooltip, setCatalogTooltip] = useState<{ id: string; x: number; y: number } | null>(null)

  const [arrangingHierarchy, setArrangingHierarchy] = useState(false)
  const [lastArrangeCount, setLastArrangeCount] = useState<number | null>(null)

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

  // ── Derived data ─────────────────────────────────────────────────────────────

  const entityMap = new Map(entities.map(e => [e.id, e]))
  const { parentOf, parentClaimOf, childrenOf, rootIds, depthOf } = buildHierarchy(entities)

  // Right panel: synthesized spatial claims
  const allSpatialClaims = entities.flatMap(e => e.claims.filter(c => c.claim_type === 'spatial'))
  const spatialClaims = allSpatialClaims.filter(c => (c.predicate ?? '') !== 'SAME_AS')

  // Pending claims from evidence extraction
  const filteredPendingClaims = (pendingClaims ?? []).filter(c => c.predicate !== 'SAME_AS')
  const showingPending = allSpatialClaims.filter(c => c.predicate !== 'SAME_AS').length === 0 && filteredPendingClaims.length > 0
  const sortedEntities = [...entities].sort((a, b) => a.name.localeCompare(b.name))

  // Focused entity drives center detail panel + right panel entity filter
  const focusedId = selectedIds[0] ?? null
  const focusedEntity = focusedId ? entityMap.get(focusedId) : null
  const visibleSpatialClaims = focusedId
    ? spatialClaims.filter(c => c.subject_ref === focusedId || (c.object_refs ?? []).includes(focusedId))
    : spatialClaims

  // ── Handlers ─────────────────────────────────────────────────────────────────

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

  function handleSelectNode(id: string) {
    setAbsorbMsg('')
    setSelectedIds(prev => {
      const next = (() => {
        if (prev[0] === id) return prev.length === 2 ? [prev[1]] : []
        if (prev[1] === id) return [prev[0]]
        if (prev.length < 2) return [...prev, id]
        return [prev[0], id]
      })()
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
        if (existing) await deleteAtlasClaim(documentId, existing.claim.id)
        for (const c of staleContainsClaims(dragId)) {
          if (c.id !== existing?.claim.id) await deleteAtlasClaim(documentId, c.id)
        }
      } else {
        let cur: string | undefined = targetId
        while (cur) {
          if (cur === dragId) { setSaving(null); return }
          cur = parentOf.get(cur)
        }
        for (const c of staleContainsClaims(dragId)) {
          await deleteAtlasClaim(documentId, c.id)
        }
        if (existing && !existing.inverse) {
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

  async function handlePatchName(entityId: string, newName: string) {
    const trimmed = newName.trim()
    setEditingNameId(null)
    if (!trimmed) return
    const current = entities.find(e => e.id === entityId)
    if (!current || trimmed === current.name) return
    setSaving(entityId)
    try { await patchAtlasEntity(documentId, entityId, { name: trimmed }); await load() }
    finally { setSaving(null) }
  }

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

  async function handleAddRel(predicate: string, subjectId: string, objectId: string) {
    setSaving('new')
    try {
      await createAtlasClaim(documentId, {
        predicate,
        subject_ref: subjectId,
        object_refs: [objectId],
      })
      await load()
    } finally { setSaving(null) }
  }

  async function handleSaveEdit(claimId: string, predicate: string, objId: string) {
    setSaving(claimId)
    try {
      await patchAtlasClaim(documentId, claimId, {
        predicate: predicate || undefined,
        object_refs: objId ? [objId] : undefined,
      })
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
          <span style={{ fontSize: '0.75rem', color: 'var(--ink-faint)', fontFamily: 'monospace' }}>
            {entities.length} {entities.length === 1 ? 'place' : 'places'} | {spatialClaims.length} {spatialClaims.length === 1 ? 'relationship' : 'relationships'}
          </span>
        </div>
      )}

      {/* ── Three-panel body ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <AtlasHierarchyTree
          readOnly={readOnly}
          entities={entities}
          entityMap={entityMap}
          childrenOf={childrenOf}
          rootIds={rootIds}
          depthOf={depthOf}
          parentClaimOf={parentClaimOf}
          dropTarget={dropTarget}
          setDropTarget={setDropTarget}
          hoveredId={hoveredId}
          setHoveredId={setHoveredId}
          collapsedIds={collapsedIds}
          collapsedCatalogGroups={collapsedCatalogGroups}
          selectedIds={selectedIds}
          saving={saving}
          editingNameId={editingNameId}
          editingNameValue={editingNameValue}
          setEditingNameValue={setEditingNameValue}
          setEditingNameId={setEditingNameId}
          editingTypeId={editingTypeId}
          setEditingTypeId={setEditingTypeId}
          editingTierId={editingTierId}
          setEditingTierId={setEditingTierId}
          editingLevelId={editingLevelId}
          setEditingLevelId={setEditingLevelId}
          arrangingHierarchy={arrangingHierarchy}
          lastArrangeCount={lastArrangeCount}
          absorbMsg={absorbMsg}
          absorbing={absorbing}
          catalogCandidates={catalogCandidates}
          onToggleCatalogReject={onToggleCatalogReject}
          setCatalogTooltip={setCatalogTooltip}
          isReviewingCatalog={isReviewingCatalog}
          onConfirmCatalog={onConfirmCatalog}
          confirmingCatalog={confirmingCatalog}
          confirmCatalogSlot={confirmCatalogSlot}
          dragIdRef={dragIdRef}
          onDrop={handleDrop}
          onSelectNode={handleSelectNode}
          onToggleCollapsed={toggleCollapsed}
          onToggleCatalogGroup={toggleCatalogGroup}
          onAutoArrange={async () => {
            setArrangingHierarchy(true)
            setLastArrangeCount(null)
            try {
              const result = await promoteContainmentHierarchy(documentId)
              setLastArrangeCount(result.claims_created)
              await load()
            } catch { /* ignore */ } finally { setArrangingHierarchy(false) }
          }}
          onAbsorb={handleAbsorb}
          onClearSelection={() => { setSelectedIds([]); setAbsorbMsg(''); setExcerpts([]) }}
          onPatchName={handlePatchName}
          onPatchType={handlePatchType}
          onPatchTier={handlePatchTier}
          onPatchLevel={handlePatchLevel}
          onDeleteEntity={handleDeleteEntity}
        />

        <AtlasDetailPanel
          focusedEntity={focusedEntity}
          selectedIds={selectedIds}
          entityMap={entityMap}
          excerpts={excerpts}
          loadingExcerpts={loadingExcerpts}
          pendingVisualClaims={pendingVisualClaims}
        />

        <AtlasRelationshipsPanel
          readOnly={readOnly}
          focusedId={focusedId}
          focusedEntityName={focusedEntity?.name}
          entityMap={entityMap}
          sortedEntities={sortedEntities}
          visibleSpatialClaims={visibleSpatialClaims}
          spatialClaims={spatialClaims}
          filteredPendingClaims={filteredPendingClaims}
          showingPending={showingPending}
          saving={saving}
          dedupProposals={dedupProposals}
          onToggleDedupReject={onToggleDedupReject}
          onConfirmDedup={onConfirmDedup}
          confirmingDedup={confirmingDedup}
          dedupConfirmCount={dedupConfirmCount}
          onAddRel={handleAddRel}
          onDeleteClaim={handleDeleteClaim}
          onSaveEdit={handleSaveEdit}
        />
      </div>

      {/* Catalog candidate excerpt tooltip */}
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
