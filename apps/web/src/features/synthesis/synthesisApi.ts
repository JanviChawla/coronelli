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
