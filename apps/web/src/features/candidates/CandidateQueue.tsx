import { useEffect, useState } from 'react'
import { type Candidate, fetchCandidates, reviewCandidate } from './candidateApi'
import { CandidateCard } from './CandidateCard'

interface Props {
  sectionId: string
  sectionTitle: string | null
}

export function CandidateQueue({ sectionId, sectionTitle }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(true)
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
        prev.map((c) =>
          c.id === candidateId
            ? { ...c, review_state: action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : action === 'defer' ? 'deferred' : action }
            : c,
        ),
      )
    } catch {
      setError('Review action failed. Please try again.')
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

      {!loading && candidates.length > 0 && (
        <p style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.75rem' }}>
          {candidates.length} candidate{candidates.length !== 1 ? 's' : ''} —{' '}
          {proposed.length} proposed, {reviewed.length} reviewed
        </p>
      )}

      {proposed.map((c) => (
        <CandidateCard key={c.id} candidate={c} onReviewed={handleReviewed} />
      ))}

      {reviewed.length > 0 && (
        <>
          <h4 style={{ marginTop: '1rem', marginBottom: '0.5rem', fontSize: '0.85rem', color: '#666' }}>
            Reviewed
          </h4>
          {reviewed.map((c) => (
            <CandidateCard key={c.id} candidate={c} onReviewed={handleReviewed} />
          ))}
        </>
      )}
    </section>
  )
}
