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

// Candidates in these states have been explicitly resolved — no further challenge offered.
const _TERMINAL_STATES = new Set(['rejected', 'deferred', 'merged'])

export function CandidateCard({ candidate, onReviewed }: Props) {
  const [challenging, setChallenging] = useState(false)
  const [editing, setEditing] = useState(false)

  const isTerminal = _TERMINAL_STATES.has(candidate.review_state)
  const canChallenge = !isTerminal && !challenging

  return (
    <li
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.4rem',
        padding: '0.5rem 0',
        borderBottom: '1px solid #eee',
        opacity: isTerminal ? 0.5 : 1,
      }}
    >
      {/* Compact row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.7rem', background: '#eef', padding: '0.1rem 0.4rem', borderRadius: '3px', whiteSpace: 'nowrap' }}>
          {kindLabel(candidate.kind)}
        </span>
        <span
          style={{
            fontSize: '0.7rem',
            background: candidate.status === 'explicit' ? '#efe' : '#fff3cd',
            padding: '0.1rem 0.4rem',
            borderRadius: '3px',
            whiteSpace: 'nowrap',
          }}
        >
          {candidate.status}
        </span>
        <span style={{ flex: 1, fontSize: '0.9rem' }}>{payloadSummary(candidate)}</span>
        <span style={{ fontSize: '0.75rem', color: '#888', whiteSpace: 'nowrap' }}>
          {Math.round(candidate.confidence * 100)}%
        </span>
        {isTerminal ? (
          <span style={{ fontSize: '0.75rem', color: '#666', whiteSpace: 'nowrap' }}>
            {candidate.review_state}
          </span>
        ) : canChallenge ? (
          <button
            type="button"
            onClick={() => setChallenging(true)}
            style={{ fontSize: '0.75rem', color: '#888', background: 'none', border: '1px solid #ccc', borderRadius: '3px', padding: '0.15rem 0.5rem', cursor: 'pointer' }}
          >
            Challenge
          </button>
        ) : null}
      </div>

      {/* Exception workflow — only shown when challenging */}
      {challenging && !editing && (
        <div style={{ marginLeft: '0.5rem', paddingLeft: '0.75rem', borderLeft: '3px solid #f0c040' }}>
          <blockquote style={{ margin: '0 0 0.5rem', fontSize: '0.82rem', color: '#555', fontStyle: 'italic' }}>
            {candidate.excerpt}
          </blockquote>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => { onReviewed(candidate.id, 'reject'); setChallenging(false) }}>
              Reject
            </button>
            <button type="button" onClick={() => setEditing(true)}>
              Edit &amp; approve
            </button>
            <button type="button" onClick={() => { onReviewed(candidate.id, 'defer'); setChallenging(false) }}>
              Defer
            </button>
            <button type="button" onClick={() => setChallenging(false)} style={{ color: '#888' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div style={{ marginLeft: '0.5rem', paddingLeft: '0.75rem', borderLeft: '3px solid #f0c040' }}>
          <ReviewForm
            candidate={candidate}
            onSubmit={(editedPayload) => {
              setEditing(false)
              setChallenging(false)
              onReviewed(candidate.id, 'approve', editedPayload)
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}
    </li>
  )
}
