const BASE = 'http://localhost:8000'

export type Candidate = {
  id: string
  extraction_run_id: string
  section_id: string
  kind: string
  payload: Record<string, unknown>
  status: string
  confidence: number
  excerpt: string
  rationale: string
  review_state: string
  ordinal: number
  temporal_interpretation: string
  first_revealed_at_section_id: string | null
  relation_kind: string | null
  relation_target_id: string | null
  display_summary: string
}

export type ReviewRequest = {
  action: 'approve' | 'reject' | 'defer' | 'merge'
  edited_payload?: Record<string, unknown> | null
  merge_target_id?: string | null
  rationale?: string | null
}

export type ReviewResponse = {
  event: {
    id: string
    candidate_id: string
    action: string
    canonical_entity_id: string | null
    canonical_claim_id: string | null
    canonical_travel_rule_id: string | null
    created_at: string
  }
  canonical_entity: Record<string, unknown> | null
  canonical_claim: Record<string, unknown> | null
}

export async function fetchCandidates(sectionId: string): Promise<Candidate[]> {
  const res = await fetch(`${BASE}/api/sections/${sectionId}/candidates`)
  if (!res.ok) throw new Error('Failed to fetch candidates')
  return res.json()
}

export async function approveAllCandidates(sectionId: string): Promise<{ approved: number; section_id: string }> {
  const res = await fetch(`${BASE}/api/sections/${sectionId}/candidates/approve-all`, { method: 'POST' })
  if (!res.ok) throw new Error(`Approve-all failed for section ${sectionId}`)
  return res.json()
}

export async function reviewCandidate(
  candidateId: string,
  req: ReviewRequest,
): Promise<ReviewResponse> {
  const res = await fetch(`${BASE}/api/candidates/${candidateId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) throw new Error('Review action failed')
  return res.json()
}

export async function fetchDocumentEntityCandidates(documentId: string): Promise<Candidate[]> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/entity-candidates`)
  if (!res.ok) throw new Error(`Failed to fetch entity candidates: ${res.statusText}`)
  return res.json()
}

export async function patchCandidateReviewState(
  candidateId: string,
  reviewState: 'proposed' | 'approved' | 'rejected',
): Promise<Candidate> {
  const res = await fetch(`${BASE}/api/candidates/${candidateId}/review-state`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ review_state: reviewState }),
  })
  if (!res.ok) throw new Error(`Failed to update review state: ${res.statusText}`)
  return res.json()
}
