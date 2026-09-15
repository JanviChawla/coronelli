import { useState } from 'react'
import { type Candidate, reviewCandidate } from './candidateApi'
import { ReviewForm } from './ReviewForm'

interface Section {
  id: string
  title: string | null
}

interface Props {
  sections: Section[]
  candidates: Record<string, Candidate[]>
}

function contentCell(c: Candidate) {
  const summary = c.display_summary
  if (!summary || !summary.trim()) {
    return (
      <span style={{ color: '#c00', fontSize: '0.75rem', fontStyle: 'italic' }}>
        ⚠ missing display summary
      </span>
    )
  }
  return summary
}

function kindBadge(kind: string) {
  const labels: Record<string, string> = {
    entity: 'Place',
    claim: 'Claim',
    visual_claim: 'Visual',
    travel_rule: 'Route',
    scene_anchor: 'Anchor',
  }
  const colors: Record<string, string> = {
    entity: '#dbeafe',
    claim: '#dcfce7',
    visual_claim: '#fef9c3',
    travel_rule: '#ede9fe',
    scene_anchor: '#fee2e2',
  }
  return (
    <span style={{
      fontSize: '0.68rem',
      background: colors[kind] ?? '#f0f0f0',
      padding: '0.15rem 0.45rem',
      borderRadius: '3px',
      whiteSpace: 'nowrap',
    }}>
      {labels[kind] ?? kind}
    </span>
  )
}

const _TERMINAL_STATES = new Set(['rejected', 'deferred', 'merged'])

export function CandidatesTable({ sections, candidates: initialCandidates }: Props) {
  const [candidates, setCandidates] = useState(initialCandidates)
  const [challengingId, setChallengingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleReview(
    sectionId: string,
    candidateId: string,
    action: string,
    editedPayload?: Record<string, unknown>,
  ) {
    setError(null)
    try {
      await reviewCandidate(candidateId, {
        action: action as 'approve' | 'reject' | 'defer' | 'merge',
        edited_payload: editedPayload ?? null,
      })
      setCandidates(prev => ({
        ...prev,
        [sectionId]: prev[sectionId].map(c =>
          c.id === candidateId
            ? { ...c, review_state: action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : action === 'defer' ? 'deferred' : action, payload: editedPayload ?? c.payload }
            : c
        ),
      }))
    } catch {
      setError('Review action failed.')
    }
    setChallengingId(null)
    setEditingId(null)
  }

  const totalCount = sections.reduce((n, s) => n + (candidates[s.id]?.length ?? 0), 0)

  return (
    <div>
      <p style={{ fontSize: '0.8rem', color: '#888', marginBottom: '1rem' }}>
        {totalCount} candidate{totalCount !== 1 ? 's' : ''} across {sections.length} section{sections.length !== 1 ? 's' : ''} · review each to approve, reject, or defer
      </p>

      {error && <p role="alert" style={{ color: 'red', fontSize: '0.85rem' }}>{error}</p>}

      {sections.map(section => {
        const rows = candidates[section.id] ?? []
        if (rows.length === 0) return null
        return (
          <div key={section.id} style={{ marginBottom: '2rem' }}>
            <h4 style={{ fontSize: '0.85rem', color: '#555', margin: '0 0 0.4rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {section.title ?? '(untitled)'}
              <span style={{ fontWeight: 400, marginLeft: '0.5rem', color: '#aaa' }}>
                {rows.length} candidate{rows.length !== 1 ? 's' : ''}
              </span>
            </h4>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                  <th style={thStyle}>Kind</th>
                  <th style={{ ...thStyle, width: '45%' }}>Content</th>
                  <th style={thStyle}>Source</th>
                  <th style={thStyle}>Conf</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(c => {
                  const isChallenging = challengingId === c.id
                  const isEditing = editingId === c.id
                  const isTerminal = _TERMINAL_STATES.has(c.review_state)

                  return (
                    <>
                      <tr
                        key={c.id}
                        style={{
                          borderBottom: isChallenging ? 'none' : '1px solid #f0f0f0',
                          opacity: isTerminal ? 0.45 : 1,
                          background: isChallenging ? '#fffbeb' : undefined,
                        }}
                      >
                        <td style={tdStyle}>{kindBadge(c.kind)}</td>
                        <td style={{ ...tdStyle, fontWeight: c.kind === 'scene_anchor' ? 500 : 400 }}>
                          {contentCell(c)}
                        </td>
                        <td style={tdStyle}>
                          <span style={{
                            fontSize: '0.68rem',
                            background: c.status === 'explicit' ? '#dcfce7' : '#fef9c3',
                            padding: '0.1rem 0.35rem',
                            borderRadius: '3px',
                          }}>
                            {c.status}
                          </span>
                        </td>
                        <td style={{ ...tdStyle, color: '#888', textAlign: 'right' }}>
                          {Math.round(c.confidence * 100)}%
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>
                          {isTerminal ? (
                            <span style={{ fontSize: '0.7rem', color: '#999' }}>{c.review_state}</span>
                          ) : !isChallenging ? (
                            <button
                              type="button"
                              onClick={() => { setChallengingId(c.id); setEditingId(null) }}
                              style={challengeBtn}
                            >
                              Challenge
                            </button>
                          ) : null}
                        </td>
                      </tr>

                      {isChallenging && (
                        <tr key={`${c.id}-challenge`} style={{ background: '#fffbeb', borderBottom: '1px solid #f0f0f0' }}>
                          <td colSpan={5} style={{ padding: '0.6rem 0.75rem 0.75rem' }}>
                            <blockquote style={{ margin: '0 0 0.6rem', fontSize: '0.8rem', color: '#555', fontStyle: 'italic', borderLeft: '3px solid #f0c040', paddingLeft: '0.6rem' }}>
                              {c.excerpt}
                            </blockquote>
                            {isEditing ? (
                              <ReviewForm
                                candidate={c}
                                onSubmit={(editedPayload) => handleReview(section.id, c.id, 'approve', editedPayload)}
                                onCancel={() => { setEditingId(null); setChallengingId(null) }}
                              />
                            ) : (
                              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                <button type="button" onClick={() => handleReview(section.id, c.id, 'reject')} style={{ fontSize: '0.8rem' }}>
                                  Reject
                                </button>
                                <button type="button" onClick={() => setEditingId(c.id)} style={{ fontSize: '0.8rem' }}>
                                  Edit &amp; re-approve
                                </button>
                                <button type="button" onClick={() => handleReview(section.id, c.id, 'defer')} style={{ fontSize: '0.8rem' }}>
                                  Defer
                                </button>
                                <button type="button" onClick={() => setChallengingId(null)} style={{ fontSize: '0.8rem', color: '#888' }}>
                                  Cancel
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.3rem 0.5rem',
  fontSize: '0.72rem',
  color: '#888',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

const tdStyle: React.CSSProperties = {
  padding: '0.4rem 0.5rem',
  verticalAlign: 'top',
}

const challengeBtn: React.CSSProperties = {
  fontSize: '0.72rem',
  color: '#888',
  background: 'none',
  border: '1px solid #ddd',
  borderRadius: '3px',
  padding: '0.15rem 0.5rem',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
