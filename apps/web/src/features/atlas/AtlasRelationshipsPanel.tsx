import { useState } from 'react'
import type { AtlasClaim, AtlasEntity } from './atlasApi'
import type { PendingClaim, DedupProposal } from './AtlasEditor'

const RELATIONSHIP_PREDICATES = ['LEADS_TO', 'ADJACENT_TO']

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

interface Props {
  readOnly: boolean
  focusedId: string | null
  focusedEntityName: string | undefined
  entityMap: Map<string, AtlasEntity>
  sortedEntities: AtlasEntity[]
  visibleSpatialClaims: AtlasClaim[]
  spatialClaims: AtlasClaim[]
  filteredPendingClaims: PendingClaim[]
  showingPending: boolean
  saving: string | null
  dedupProposals: DedupProposal[]
  onToggleDedupReject?: (id: string) => void
  onConfirmDedup?: () => void
  confirmingDedup: boolean
  dedupConfirmCount: number
  onAddRel: (predicate: string, subjectId: string, objectId: string) => Promise<void>
  onDeleteClaim: (claimId: string) => void
  onSaveEdit: (claimId: string, predicate: string, objId: string) => void
}

export function AtlasRelationshipsPanel({
  readOnly, focusedId, focusedEntityName, entityMap, sortedEntities,
  visibleSpatialClaims, spatialClaims, filteredPendingClaims, showingPending,
  saving, dedupProposals, onToggleDedupReject, onConfirmDedup,
  confirmingDedup, dedupConfirmCount, onAddRel, onDeleteClaim, onSaveEdit,
}: Props) {
  const [showContainment, setShowContainment] = useState(true)
  const [addingRel, setAddingRel] = useState(false)
  const [newRel, setNewRel] = useState({ subjectId: '', predicate: 'ADJACENT_TO', objectId: '' })
  const [editingClaimId, setEditingClaimId] = useState<string | null>(null)
  const [editPred, setEditPred] = useState('')
  const [editObjId, setEditObjId] = useState('')

  const CONTAINMENT_ONLY = new Set(['LOCATED_IN', 'CONTAINS'])
  const visibleClaims = visibleSpatialClaims.filter(c => {
    const pred = c.predicate ?? ''
    if (pred === 'SAME_AS') return false
    if (!showContainment && CONTAINMENT_ONLY.has(pred)) return false
    return true
  })
  const visiblePending = filteredPendingClaims.filter(c => {
    if (!showContainment && CONTAINMENT_ONLY.has(c.predicate)) return false
    return true
  })

  return (
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
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
                ? `${visiblePending.length} pending`
                : focusedId
                  ? `${visibleClaims.length} of ${spatialClaims.length} claim${spatialClaims.length !== 1 ? 's' : ''}`
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
                onClick={async () => {
                  if (!newRel.subjectId || !newRel.objectId) return
                  await onAddRel(newRel.predicate, newRel.subjectId, newRel.objectId)
                  setNewRel({ subjectId: '', predicate: 'ADJACENT_TO', objectId: '' })
                  setAddingRel(false)
                }}
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

          {/* Claims list */}
          {[...visibleClaims]
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
                      <button type="button" onClick={() => { onSaveEdit(claim.id, editPred, editObjId); setEditingClaimId(null) }} disabled={isSaving} style={{ fontSize: '0.72rem', padding: '0.22rem 0.55rem', background: 'var(--gold)', border: 'none', borderRadius: '3px', cursor: 'pointer', color: '#1a1008' }}>Save</button>
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
                          onClick={() => onDeleteClaim(claim.id)}
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

          {/* Pending claims */}
          {showingPending && visiblePending.map(c => (
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

          {visibleClaims.length === 0 && !showingPending && !addingRel && (
            <p style={{ padding: '0.75rem 0', fontSize: '0.82rem', color: 'var(--ink-faint)' }}>
              {focusedId
                ? `No relationships for ${focusedEntityName ?? 'this place'} yet.`
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
  )
}
