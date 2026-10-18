const BASE_URL = (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:8001'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Document {
  id: string
  title: string
  author?: string
  year?: number
  status: 'raw' | 'cataloging' | 'cataloged' | 'extracting' | 'ready'
  created_at: string
}

export interface Section {
  id: string
  document_id: string
  ordinal: number
  title?: string
  catalog_status: 'pending' | 'extracted' | 'confirmed'
  catalog_hash?: string
  word_count?: number
}

export interface Place {
  id: string
  document_id: string
  first_section_id?: string
  first_section_ordinal?: number
  name: string
  kind?: string
  kind_descriptor?: string
  spatial_level?: number
  tier?: 'peak' | 'elevated' | 'surface' | 'underground' | 'deep'
  parent_context?: string
  note?: string
  aliases: string[]
  palette?: Array<{ hex: string; label: string }>
  is_edge: boolean
  status: 'candidate' | 'confirmed' | 'rejected'
  source: 'catalog' | 'gap' | 'manual'
}

export interface Claim {
  id: string
  claim_type: 'spatial' | 'visual' | 'event'
  subject_id: string
  predicate?: string
  object_id?: string
  payload?: unknown
  excerpt?: string
  confidence?: number
}

export interface AtlasData {
  document: Document
  places: Place[]
  claims: Claim[]
  positions: Record<string, { x: number; z: number }>
}

export interface PlacesGrouped {
  candidate: Place[]
  confirmed: Place[]
  rejected: Place[]
}

export type SSEEvent =
  | { type: 'section_extracted'; section_id: string; claim_count: number }
  | { type: 'section_confirmed'; section_id: string }
  | { type: 'claim_batch'; section_id: string; claim_count: number }
  | { type: 'synthesis_done'; document_id: string }
  | { type: 'error'; stage: string; section_id?: string; message: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, init)
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status} ${path}: ${text}`)
  }
  if (res.status === 204) return undefined as unknown as T
  return res.json() as Promise<T>
}

// ── Documents ─────────────────────────────────────────────────────────────────

export function listDocuments(): Promise<Document[]> {
  return request('/documents')
}

export function getDocument(id: string): Promise<Document> {
  return request(`/documents/${id}`)
}

export function createDocument(
  file: File,
  meta: { title: string; author?: string; year?: number },
): Promise<Document & { sections: Section[] }> {
  const form = new FormData()
  form.append('file', file)
  form.append('title', meta.title)
  if (meta.author) form.append('author', meta.author)
  if (meta.year != null) form.append('year', String(meta.year))
  return request('/documents', { method: 'POST', body: form })
}

export function patchDocument(
  id: string,
  fields: Partial<Pick<Document, 'title' | 'author' | 'year'>>,
): Promise<Document> {
  return request(`/documents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
}

export function deleteDocument(id: string): Promise<void> {
  return request(`/documents/${id}`, { method: 'DELETE' })
}

// ── Sections ──────────────────────────────────────────────────────────────────

export function listSections(docId: string): Promise<Section[]> {
  return request(`/documents/${docId}/sections`)
}

export function patchSections(
  docId: string,
  updates: Array<{ id: string; title?: string; ordinal?: number }>,
): Promise<Section[]> {
  return request(`/documents/${docId}/sections`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
}

// ── Catalog ───────────────────────────────────────────────────────────────────

export function runCatalog(
  sectionId: string,
): Promise<{ section_id: string; cached: boolean; places: Place[] }> {
  return request(`/sections/${sectionId}/catalog/run`, { method: 'POST' })
}

export function confirmSection(
  sectionId: string,
): Promise<{ section_id: string; catalog_status: string; confirmed_count: number }> {
  return request(`/sections/${sectionId}/catalog/confirm`, { method: 'POST' })
}

export function patchPlace(
  id: string,
  fields: Partial<Pick<Place, 'status' | 'name' | 'kind' | 'kind_descriptor' | 'tier' | 'note' | 'is_edge'>>,
): Promise<Place> {
  return request(`/places/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
}

export function addManualPlace(
  docId: string,
  place: Omit<Place, 'id' | 'document_id' | 'status' | 'source'>,
): Promise<Place> {
  return request(`/documents/${docId}/places`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(place),
  })
}

export function getPlaces(docId: string): Promise<PlacesGrouped> {
  return request(`/documents/${docId}/places`)
}

// ── Extraction ────────────────────────────────────────────────────────────────

export function runExtraction(docId: string): Promise<{ status: string; document_id: string }> {
  return request(`/documents/${docId}/extract/run`, { method: 'POST' })
}

export function synthesize(
  docId: string,
): Promise<{ status: string; document_id: string; positions: number }> {
  return request(`/documents/${docId}/synthesize`, { method: 'POST' })
}

// ── Cost estimate ─────────────────────────────────────────────────────────────

export interface CostPassEstimate {
  estimated_input_tokens: number
  estimated_output_tokens: number
  estimated_cost_usd: number
}

export interface CostEstimate {
  model: string
  section_count: number
  catalog_gap: CostPassEstimate
  evidence: CostPassEstimate
  total_estimated_cost_usd: number
}

export function getEstimate(docId: string): Promise<CostEstimate> {
  return request(`/documents/${docId}/estimate`)
}

// ── Claims ────────────────────────────────────────────────────────────────────

export function addClaim(
  docId: string,
  claim: Pick<Claim, 'claim_type' | 'subject_id' | 'predicate' | 'object_id'> & { excerpt?: string },
): Promise<Claim> {
  return request(`/documents/${docId}/claims`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(claim),
  })
}

export function deleteClaim(claimId: string): Promise<void> {
  return request(`/claims/${claimId}`, { method: 'DELETE' })
}

// ── Atlas ─────────────────────────────────────────────────────────────────────

export function getAtlas(docId: string): Promise<AtlasData> {
  return request(`/documents/${docId}/atlas`)
}

// ── SSE ───────────────────────────────────────────────────────────────────────

export function openEventStream(
  docId: string,
  onEvent: (event: SSEEvent) => void,
): EventSource {
  const es = new EventSource(`${BASE_URL}/documents/${docId}/events`)
  es.onmessage = (e: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(e.data) as SSEEvent
      onEvent(parsed)
    } catch {
      // ignore malformed events
    }
  }
  return es
}
