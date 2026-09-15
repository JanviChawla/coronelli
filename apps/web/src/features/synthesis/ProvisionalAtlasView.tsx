import { useState } from 'react'
import type { SynthesisItem } from './synthesisApi'
import { approveAllSynthesisEntities, reviewSynthesisItem } from './synthesisApi'

interface Props {
  items: SynthesisItem[]
  documentId: string
  onResynthesize: () => void
}

const KIND_LABELS: Record<string, string> = {
  entity: 'Place',
  claim: 'Claim',
  route: 'Route',
  visual_claim: 'Visual',
  same_as: 'Same As',
  unresolved: 'Unresolved',
  reveal_event: 'Reveal',
}

const KIND_COLORS: Record<string, string> = {
  entity: '#dbeafe',
  claim: '#dcfce7',
  route: '#ede9fe',
  visual_claim: '#fef9c3',
  same_as: '#ffedd5',
  unresolved: '#fce7f3',
  reveal_event: '#f3f4f6',
}

const KIND_ORDER = ['entity', 'claim', 'route', 'visual_claim', 'same_as', 'reveal_event', 'unresolved']

const STATE_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  approved: { label: '✓ approved', bg: '#dcfce7', color: '#166534' },
  rejected: { label: 'rejected', bg: '#fee2e2', color: '#991b1b' },
  deferred: { label: 'deferred', bg: '#f3f4f6', color: '#6b7280' },
}

export function ProvisionalAtlasView({ items: initialItems, documentId, onResynthesize }: Props) {
  const [items, setItems] = useState<SynthesisItem[]>(initialItems)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [batchLoading, setBatchLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleReview(itemId: string, action: 'approve' | 'reject' | 'defer') {
    setLoadingId(itemId)
    setError(null)
    try {
      const res = await reviewSynthesisItem(itemId, { action })
      setItems(prev => prev.map(it => it.id === itemId ? res.item : it))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Review failed.')
    } finally {
      setLoadingId(null)
    }
  }

  async function handleApproveAllEntities() {
    setBatchLoading(true)
    setError(null)
    try {
      await approveAllSynthesisEntities(documentId)
      setItems(prev => prev.map(it =>
        it.kind === 'entity' && it.review_state === 'provisional'
          ? { ...it, review_state: 'approved' }
          : it
      ))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Batch approve failed.')
    } finally {
      setBatchLoading(false)
    }
  }

  if (items.length === 0) {
    return (
      <div>
        <p style={{ color: '#888', fontSize: '0.85rem' }}>No synthesis items produced.</p>
        <button type="button" onClick={onResynthesize} style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
          Re-synthesize
        </button>
      </div>
    )
  }

  const byKind = new Map<string, SynthesisItem[]>()
  for (const item of items) {
    if (!byKind.has(item.kind)) byKind.set(item.kind, [])
    byKind.get(item.kind)!.push(item)
  }

  const sortedKinds = [...byKind.keys()].sort((a, b) => {
    const ai = KIND_ORDER.indexOf(a)
    const bi = KIND_ORDER.indexOf(b)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  const provisionalEntities = items.filter(it => it.kind === 'entity' && it.review_state === 'provisional')
  const approvedCount = items.filter(it => it.review_state === 'approved').length

  return (
    <div>
      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <p style={{ fontSize: '0.8rem', color: '#888', margin: 0 }}>
          {items.length} synthesis item{items.length !== 1 ? 's' : ''}
          {approvedCount > 0 && <> · {approvedCount} approved</>}
          {' · provisional — review required before atlas export'}
        </p>
        <button
          type="button"
          onClick={onResynthesize}
          style={{ fontSize: '0.72rem', color: '#888', background: 'none', border: '1px solid #ddd', borderRadius: '3px', padding: '0.15rem 0.5rem', cursor: 'pointer' }}
        >
          Re-synthesize
        </button>
      </div>

      {/* Batch approve */}
      {provisionalEntities.length > 0 && (
        <div style={{ marginBottom: '1.25rem', padding: '0.6rem 0.75rem', background: '#f8faff', border: '1px solid #dbeafe', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.82rem', color: '#1e40af' }}>
            {provisionalEntities.length} place{provisionalEntities.length !== 1 ? 's' : ''} awaiting review
          </span>
          <button
            type="button"
            onClick={handleApproveAllEntities}
            disabled={batchLoading}
            style={{ fontSize: '0.8rem', fontWeight: 500, padding: '0.25rem 0.65rem', cursor: batchLoading ? 'wait' : 'pointer' }}
          >
            {batchLoading ? 'Approving…' : `Approve all places (${provisionalEntities.length})`}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" style={{ color: 'red', fontSize: '0.82rem', marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}

      {/* Item groups */}
      {sortedKinds.map(kind => {
        const kindItems = byKind.get(kind)!
        return (
          <div key={kind} style={{ marginBottom: '1.5rem' }}>
            <h4 style={{
              fontSize: '0.78rem',
              color: '#555',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              margin: '0 0 0.4rem',
              fontWeight: 600,
            }}>
              {KIND_LABELS[kind] ?? kind}
              <span style={{ fontWeight: 400, marginLeft: '0.5rem', color: '#aaa' }}>
                {kindItems.length}
              </span>
            </h4>

            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {kindItems.map(item => {
                const isLoading = loadingId === item.id
                const isTerminal = item.review_state !== 'provisional'
                const badge = STATE_BADGE[item.review_state]

                return (
                  <li
                    key={item.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.5rem',
                      padding: '0.45rem 0',
                      borderBottom: '1px solid #f0f0f0',
                      fontSize: '0.85rem',
                      opacity: item.review_state === 'rejected' ? 0.45 : 1,
                    }}
                  >
                    <span style={{
                      fontSize: '0.65rem',
                      background: KIND_COLORS[item.kind] ?? '#f0f0f0',
                      padding: '0.15rem 0.45rem',
                      borderRadius: '3px',
                      whiteSpace: 'nowrap',
                      marginTop: '0.15rem',
                      flexShrink: 0,
                    }}>
                      {KIND_LABELS[item.kind] ?? item.kind}
                    </span>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: kind === 'entity' ? 500 : 400 }}>
                        {item.display_summary || (
                          <span style={{ color: '#c00', fontSize: '0.75rem', fontStyle: 'italic' }}>⚠ missing summary</span>
                        )}
                      </div>
                      {item.rationale && (
                        <div style={{ fontSize: '0.72rem', color: '#999', marginTop: '0.1rem' }}>
                          {item.rationale}
                        </div>
                      )}
                    </div>

                    {item.confidence != null && (
                      <span style={{ fontSize: '0.7rem', color: '#bbb', whiteSpace: 'nowrap', marginTop: '0.15rem', flexShrink: 0 }}>
                        {Math.round(item.confidence * 100)}%
                      </span>
                    )}

                    {/* Review actions */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0 }}>
                      {badge ? (
                        <span style={{
                          fontSize: '0.68rem',
                          background: badge.bg,
                          color: badge.color,
                          padding: '0.15rem 0.45rem',
                          borderRadius: '3px',
                          whiteSpace: 'nowrap',
                        }}>
                          {badge.label}
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={isLoading}
                            onClick={() => handleReview(item.id, 'approve')}
                            style={actionBtn('#166534', '#dcfce7', isLoading)}
                          >
                            {isLoading ? '…' : 'Approve'}
                          </button>
                          <button
                            type="button"
                            disabled={isLoading}
                            onClick={() => handleReview(item.id, 'defer')}
                            style={actionBtn('#6b7280', '#f3f4f6', isLoading)}
                          >
                            Defer
                          </button>
                          <button
                            type="button"
                            disabled={isLoading}
                            onClick={() => handleReview(item.id, 'reject')}
                            style={actionBtn('#991b1b', '#fee2e2', isLoading)}
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function actionBtn(color: string, bg: string, disabled: boolean): React.CSSProperties {
  return {
    fontSize: '0.68rem',
    color,
    background: bg,
    border: 'none',
    borderRadius: '3px',
    padding: '0.15rem 0.45rem',
    cursor: disabled ? 'wait' : 'pointer',
    fontWeight: 500,
    opacity: disabled ? 0.6 : 1,
  }
}
