const BASE = 'http://localhost:8000'

export type PreflightResult = {
  section_id: string
  title: string | null
  estimated_input_tokens: number
  estimated_cost_usd: number | null
  cache_valid: boolean
  cached_run_id: string | null
}

export type ExtractionRunResult = {
  run: { id: string; status: string }
  candidates: { id: string; kind: string }[]
  from_cache: boolean
}

export async function fetchPreflight(sectionId: string): Promise<PreflightResult> {
  const res = await fetch(`${BASE}/api/sections/${sectionId}/extract/preflight`)
  if (!res.ok) {
    let detail = `Preflight failed (HTTP ${res.status})`
    try {
      const body = await res.json()
      if (body?.detail) detail = body.detail
    } catch { /* ignore parse errors */ }
    throw new Error(detail)
  }
  return res.json()
}

export async function triggerExtraction(sectionId: string): Promise<ExtractionRunResult> {
  const res = await fetch(`${BASE}/api/sections/${sectionId}/extract`, { method: 'POST' })
  if (!res.ok) {
    let detail = `Extraction failed (HTTP ${res.status})`
    try {
      const body = await res.json()
      if (body?.detail) detail = body.detail
    } catch { /* ignore parse errors */ }
    throw new Error(detail)
  }
  return res.json()
}
