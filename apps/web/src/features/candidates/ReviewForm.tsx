import { useState } from 'react'
import type { Candidate } from './candidateApi'

interface Props {
  candidate: Candidate
  onSubmit: (editedPayload: Record<string, unknown>) => void
  onCancel: () => void
}

export function ReviewForm({ candidate, onSubmit, onCancel }: Props) {
  const [fields, setFields] = useState<Record<string, unknown>>({ ...candidate.payload })

  function set(key: string, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSubmit(fields)
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Edit candidate before approving">
      {candidate.kind === 'entity' && (
        <>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: '#666' }}>Name</span>
            <input
              aria-label="Candidate name"
              value={String(fields.name ?? '')}
              onChange={(e) => set('name', e.target.value)}
              style={{ display: 'block', width: '100%' }}
            />
          </label>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: '#666' }}>Type</span>
            <input
              aria-label="Candidate type"
              value={String(fields.type ?? '')}
              onChange={(e) => set('type', e.target.value)}
              style={{ display: 'block', width: '100%' }}
            />
          </label>
        </>
      )}

      {(candidate.kind === 'claim' || candidate.kind === 'visual_claim') && (
        <>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: '#666' }}>Subject</span>
            <input
              aria-label="Claim subject"
              value={String(fields.subject ?? '')}
              onChange={(e) => set('subject', e.target.value)}
              style={{ display: 'block', width: '100%' }}
            />
          </label>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: '#666' }}>Predicate</span>
            <input
              aria-label="Claim predicate"
              value={String(fields.predicate ?? '')}
              onChange={(e) => set('predicate', e.target.value)}
              style={{ display: 'block', width: '100%' }}
            />
          </label>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: '#666' }}>Object</span>
            <input
              aria-label="Claim object"
              value={String(fields.object ?? '')}
              onChange={(e) => set('object', e.target.value)}
              style={{ display: 'block', width: '100%' }}
            />
          </label>
        </>
      )}

      {candidate.kind === 'travel_rule' && (
        <>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: '#666' }}>Traveler</span>
            <input
              aria-label="Traveler"
              value={String(fields.traveler ?? '')}
              onChange={(e) => set('traveler', e.target.value)}
              style={{ display: 'block', width: '100%' }}
            />
          </label>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: '#666' }}>Route</span>
            <input
              aria-label="Route"
              value={String(fields.route ?? '')}
              onChange={(e) => set('route', e.target.value)}
              style={{ display: 'block', width: '100%' }}
            />
          </label>
        </>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
        <button type="submit">Approve candidate</button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
