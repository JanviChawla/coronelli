import { useState } from 'react'
import type { Candidate } from './candidateApi'
import { ReviewForm } from './ReviewForm'

interface Props {
  candidate: Candidate
  onReviewed: (candidateId: string, action: string, editedPayload?: Record<string, unknown>) => void
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'entity': return 'Entity'
    case 'claim': return 'Spatial claim'
    case 'visual_claim': return 'Visual claim'
    case 'travel_rule': return 'Travel rule'
    default: return kind
  }
}

function payloadSummary(candidate: Candidate): string {
  const p = candidate.payload
  if (candidate.kind === 'entity') return `${p.name ?? ''}${p.type ? ` (${p.type})` : ''}`
  if (candidate.kind === 'claim' || candidate.kind === 'visual_claim') {
    return [p.subject, p.predicate, p.object].filter(Boolean).join(' → ')
  }
  if (candidate.kind === 'travel_rule') {
    const traverse = p.can_traverse ? 'can traverse' : 'cannot traverse'
    return `${p.traveler ?? 'traveler'} ${traverse} ${p.route ?? ''}`
  }
  return ''
}

const _PROPOSED = 'proposed'

export function CandidateCard({ candidate, onReviewed }: Props) {
  const [editing, setEditing] = useState(false)
  const isProposed = candidate.review_state === _PROPOSED

  return (
    <article
      style={{
        border: '1px solid #ddd',
        borderRadius: '4px',
        padding: '0.75rem',
        marginBottom: '0.75rem',
        opacity: isProposed ? 1 : 0.7,
      }}
    >
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
        <span style={{ fontSize: '0.7rem', background: '#eef', padding: '0.1rem 0.4rem', borderRadius: '3px' }}>
          {kindLabel(candidate.kind)}
        </span>
        <span
          style={{
            fontSize: '0.7rem',
            background: candidate.status === 'explicit' ? '#efe' : '#ffeedd',
            padding: '0.1rem 0.4rem',
            borderRadius: '3px',
          }}
        >
          {candidate.status}
        </span>
        {isProposed && (
          <span style={{ fontSize: '0.7rem', background: '#fff3cd', padding: '0.1rem 0.4rem', borderRadius: '3px' }}>
            provisional
          </span>
        )}
        {!isProposed && (
          <span style={{ fontSize: '0.7rem', color: '#555' }}>{candidate.review_state}</span>
        )}
        <span style={{ fontSize: '0.7rem', color: '#888', marginLeft: 'auto' }}>
          {Math.round(candidate.confidence * 100)}% confidence
        </span>
      </div>

      <p style={{ margin: '0 0 0.4rem', fontWeight: 500 }}>{payloadSummary(candidate)}</p>

      {candidate.temporal_interpretation !== 'static' && (
        <p style={{ margin: '0 0 0.4rem', fontSize: '0.75rem', color: '#666' }}>
          Temporal: {candidate.temporal_interpretation}
        </p>
      )}

      <blockquote
        style={{
          margin: '0 0 0.5rem',
          padding: '0.4rem 0.6rem',
          borderLeft: '3px solid #ccc',
          fontSize: '0.85rem',
          color: '#444',
          fontStyle: 'italic',
        }}
      >
        {candidate.excerpt}
      </blockquote>

      {editing ? (
        <ReviewForm
          candidate={candidate}
          onSubmit={(editedPayload) => {
            setEditing(false)
            onReviewed(candidate.id, 'approve', editedPayload)
          }}
          onCancel={() => setEditing(false)}
        />
      ) : isProposed ? (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => onReviewed(candidate.id, 'approve')}>
            Approve candidate
          </button>
          <button type="button" onClick={() => setEditing(true)}>
            Edit &amp; approve
          </button>
          <button type="button" onClick={() => onReviewed(candidate.id, 'reject')}>
            Challenge candidate
          </button>
          <button type="button" onClick={() => onReviewed(candidate.id, 'defer')}>
            Defer candidate
          </button>
        </div>
      ) : null}
    </article>
  )
}
