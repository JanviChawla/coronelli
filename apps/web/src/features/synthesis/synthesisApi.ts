const BASE = 'http://localhost:8000'

export type SynthesisItem = {
  id: string
  synthesis_run_id: string
  document_id: string
  kind: string
  payload: Record<string, unknown>
  review_state: string
  confidence: number | null
  rationale: string | null
  ordinal: number
  display_summary: string
}

export type SynthesisRun = {
  id: string
  document_id: string
  status: string
  provider: string
  model: string
  synthesis_prompt_version: string
  evidence_hash: string | null
  from_cache: boolean
}

export type SynthesisResponse = {
  run: SynthesisRun
  items: SynthesisItem[]
  item_count: number
  from_cache: boolean
}

export type ProvisionalAtlasResponse = {
  document_id: string
  run_id: string | null
  items: SynthesisItem[]
  item_count: number
}

export async function triggerSynthesis(documentId: string, force = false): Promise<SynthesisResponse> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/synthesize?force=${force}`, {
    method: 'POST',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Synthesis failed: ${text}`)
  }
  return res.json()
}

export async function fetchProvisionalAtlas(documentId: string): Promise<ProvisionalAtlasResponse> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/provisional-atlas`)
  if (!res.ok) throw new Error('Failed to fetch provisional atlas')
  return res.json()
}

export type SynthesisReviewRequest = {
  action: 'approve' | 'reject' | 'defer'
}

export type SynthesisReviewResponse = {
  item: SynthesisItem
  created_entity: Record<string, unknown> | null
  created_claim: Record<string, unknown> | null
  created_travel_rule: Record<string, unknown> | null
}

export async function reviewSynthesisItem(
  itemId: string,
  req: SynthesisReviewRequest,
): Promise<SynthesisReviewResponse> {
  const res = await fetch(`${BASE}/api/synthesis-items/${itemId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Review failed: ${text}`)
  }
  return res.json()
}

export async function approveAllSynthesisEntities(documentId: string): Promise<{ approved: number }> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/synthesis-items/approve-entities`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error('Batch approve failed')
  return res.json()
}
