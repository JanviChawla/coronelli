import { useEffect, useState } from 'react'
import { type Candidate, fetchCandidates, reviewCandidate } from './candidateApi'
import { CandidateCard } from './CandidateCard'

interface Props {
  sectionId: string
  sectionTitle: string | null
}

function nextReviewState(action: string): string {
  if (action === 'approve') return 'approved'
  if (action === 'reject') return 'rejected'
  if (action === 'defer') return 'deferred'
  return action
}

export function CandidateQueue({ sectionId, sectionTitle }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(true)
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchCandidates(sectionId)
      .then(setCandidates)
      .catch(() => setError('Could not load candidates.'))
      .finally(() => setLoading(false))
  }, [sectionId])

  async function handleReviewed(
    candidateId: string,
    action: string,
    editedPayload?: Record<string, unknown>,
  ) {
    try {
      await reviewCandidate(candidateId, {
        action: action as 'approve' | 'reject' | 'defer' | 'merge',
        edited_payload: editedPayload ?? null,
      })
      setCandidates((prev) =>
        prev.map((c) => c.id === candidateId ? { ...c, review_state: nextReviewState(action) } : c),
      )
    } catch {
      setError('Review action failed. Please try again.')
    }
  }

  async function handleApproveAll() {
    const proposed = candidates.filter((c) => c.review_state === 'proposed')
    if (proposed.length === 0) return
    setApproving(true)
    setError(null)
    try {
      for (const c of proposed) {
        await reviewCandidate(c.id, { action: 'approve' })
      }
      setCandidates((prev) =>
        prev.map((c) => c.review_state === 'proposed' ? { ...c, review_state: 'approved' } : c),
      )
    } catch {
      setError('Could not approve all candidates. Please try again.')
    } finally {
      setApproving(false)
    }
  }

  const proposed = candidates.filter((c) => c.review_state === 'proposed')
  const reviewed = candidates.filter((c) => c.review_state !== 'proposed')

  return (
    <section aria-label={`Candidates for ${sectionTitle ?? 'section'}`}>
      <h3 style={{ marginBottom: '0.25rem' }}>
        Candidates — {sectionTitle ?? 'section'}
      </h3>

      {loading && <p>Loading candidates…</p>}
      {error && <p role="alert" style={{ color: 'red' }}>{error}</p>}

      {!loading && !error && candidates.length === 0 && (
        <p style={{ color: '#888' }}>
          No candidates extracted for this section yet. Run extraction to generate candidates.
        </p>
      )}

      {!loading && proposed.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
          <button
            type="button"
            onClick={handleApproveAll}
            disabled={approving}
            style={{ fontWeight: 500 }}
          >
            {approving ? 'Approving…' : `Approve all proposed (${proposed.length})`}
          </button>
          <span style={{ fontSize: '0.8rem', color: '#888' }}>
            Challenge individual items to reject, edit, or defer them first.
          </span>
        </div>
      )}

      {!loading && candidates.length > 0 && (
        <>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem' }}>
            {proposed.map((c) => (
              <CandidateCard key={c.id} candidate={c} onReviewed={handleReviewed} />
            ))}
          </ul>

          {reviewed.length > 0 && (
            <>
              <h4 style={{ fontSize: '0.8rem', color: '#888', margin: '1rem 0 0.5rem' }}>
                Reviewed ({reviewed.length})
              </h4>
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {reviewed.map((c) => (
                  <CandidateCard key={c.id} candidate={c} onReviewed={handleReviewed} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
