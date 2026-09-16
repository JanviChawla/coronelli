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

export type CatalogBatchStatus = {
  document_id: string
  sections_total: number
  sections_done: number
  status: 'running' | 'completed' | 'idle'
  catalog_confirmed: boolean
}

export async function triggerDocumentCatalog(documentId: string, force = false): Promise<CatalogBatchStatus> {
  const url = `${BASE}/api/documents/${documentId}/extract/catalog${force ? '?force=true' : ''}`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) {
    let detail = `Catalog batch failed (HTTP ${res.status})`
    try { const body = await res.json(); if (body?.detail) detail = body.detail } catch { /* ignore */ }
    throw new Error(detail)
  }
  return res.json()
}

export async function getDocumentCatalogStatus(documentId: string): Promise<CatalogBatchStatus> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/extract/catalog/status`)
  if (!res.ok) throw new Error(`Catalog status fetch failed: ${res.statusText}`)
  return res.json()
}

export async function confirmDocumentCatalog(documentId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/extract/catalog/confirm`, { method: 'POST' })
  if (!res.ok) throw new Error(`Catalog confirm failed: ${res.statusText}`)
}

export async function triggerCatalogExtraction(sectionId: string, force = false): Promise<ExtractionRunResult> {
  const url = `${BASE}/api/sections/${sectionId}/extract/catalog${force ? '?force=true' : ''}`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) {
    let detail = `Catalog extraction failed (HTTP ${res.status})`
    try {
      const body = await res.json()
      if (body?.detail) detail = body.detail
    } catch { /* ignore parse errors */ }
    throw new Error(detail)
  }
  return res.json()
}

export async function triggerEvidenceExtraction(sectionId: string, force = false): Promise<ExtractionRunResult> {
  const url = `${BASE}/api/sections/${sectionId}/extract/evidence${force ? '?force=true' : ''}`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) {
    let detail = `Evidence extraction failed (HTTP ${res.status})`
    try {
      const body = await res.json()
      if (body?.detail) detail = body.detail
    } catch { /* ignore parse errors */ }
    throw new Error(detail)
  }

  const job: { run_id: string; status: string } = await res.json()

  // If already completed (cache hit), return immediately
  if (job.status === 'completed') {
    return { run: { id: job.run_id, status: 'completed' }, candidates: [], from_cache: true }
  }

  // Poll until the background job finishes (202 path)
  const POLL_MS = 2000
  const MAX_WAIT_MS = 10 * 60 * 1000 // 10 minutes
  const deadline = Date.now() + MAX_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS))
    const runRes = await fetch(`${BASE}/api/extraction-runs/${job.run_id}`)
    if (!runRes.ok) continue
    const run: { id: string; status: string; error?: string } = await runRes.json()
    if (run.status === 'completed') {
      return { run: { id: run.id, status: 'completed' }, candidates: [], from_cache: false }
    }
    if (run.status === 'failed') {
      throw new Error(`Evidence extraction failed: ${run.error ?? 'unknown error'}`)
    }
    // still running — keep polling
  }
  throw new Error('Evidence extraction timed out after 10 minutes')
}

export type ExtractionProgress = {
  status: 'running' | 'idle'
  current_phase: string | null
}

export async function getExtractionProgress(sectionId: string): Promise<ExtractionProgress> {
  const res = await fetch(`${BASE}/api/sections/${sectionId}/extraction/progress`)
  if (!res.ok) throw new Error(`Progress fetch failed: ${res.statusText}`)
  return res.json()
}

export async function fetchPlaceSuggestions(documentId: string): Promise<string[]> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/place-suggestions`)
  if (!res.ok) return []
  return res.json()
}

export async function addManualCandidate(
  documentId: string,
  name: string,
  type?: string,
): Promise<{ id: string; name: string }> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/manual-entity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type: type || null }),
  })
  if (!res.ok) throw new Error('Failed to add manual place')
  return res.json()
}
