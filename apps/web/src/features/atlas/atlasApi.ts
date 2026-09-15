const BASE = 'http://localhost:8000'

export type AtlasClaim = {
  id: string
  claim_type: string
  predicate: string | null
  subject_ref: string | null
  object_refs: string[] | null
  payload: Record<string, unknown>
  confidence: number | null
}

export type AtlasEntity = {
  id: string
  name: string
  place_kind: string | null
  aliases: string[] | null
  state: string
  provenance_section_id: string | null
  payload: Record<string, unknown>
  claims: AtlasClaim[]
}

export type AtlasTravelRule = {
  id: string
  traveler: string | null
  route: string | null
  can_traverse: boolean | null
  condition: string | null
  payload: Record<string, unknown>
}

export type AtlasResponse = {
  document_id: string
  entities: AtlasEntity[]
  travel_rules: AtlasTravelRule[]
  entity_count: number
  claim_count: number
  travel_rule_count: number
}

export async function fetchAtlas(documentId: string): Promise<AtlasResponse> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/atlas`)
  if (!res.ok) throw new Error('Failed to fetch atlas')
  return res.json()
}

export async function downloadAtlasPackage(documentId: string, documentTitle: string): Promise<void> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/atlas-package`)
  if (!res.ok) throw new Error('Failed to export atlas package')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `atlas-${documentTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
