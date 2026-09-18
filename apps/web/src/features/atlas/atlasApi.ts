const BASE = 'http://localhost:8000'

export type AtlasProvenance = {
  document_id: string | null
  section_id: string | null
}

export type AtlasDiscovery = {
  becomes_visible_at: AtlasProvenance
  visibility_policy: string
}

export type AtlasClaim = {
  id: string
  claim_type: string
  predicate: string | null
  subject_ref: string | null
  object_refs: string[] | null
  payload: Record<string, unknown>
  confidence: number | null
  excerpt: string | null
  status: string
  provenance?: AtlasProvenance
}

export type AtlasEntity = {
  id: string
  name: string
  place_kind: string | null
  aliases: string[] | null
  state: string
  status: string
  provenance_document_id?: string | null
  provenance_section_id: string | null
  provenance?: AtlasProvenance
  discovery?: AtlasDiscovery | null
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

export type EntityMention = {
  id: string
  entity_id: string
  document_id: string
  section_id: string
  section_ordinal: number
  mention_kind: string
}

export async function fetchEntityMentions(documentId: string): Promise<EntityMention[]> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/entity-mentions`)
  if (!res.ok) throw new Error('Failed to fetch entity mentions')
  return res.json()
}

export async function fetchAtlas(documentId: string): Promise<AtlasResponse> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/atlas`)
  if (!res.ok) throw new Error('Failed to fetch atlas')
  return res.json()
}

export async function mergeEntities(keepId: string, dropId: string): Promise<{ merged: boolean; canonical_entity_id: string; canonical_entity_name: string; new_aliases: string[] }> {
  const res = await fetch(`${BASE}/api/entities/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keep_id: keepId, drop_id: dropId }),
  })
  if (!res.ok) throw new Error('Failed to merge entities')
  return res.json()
}

export async function patchAtlasClaim(
  documentId: string,
  claimId: string,
  body: { predicate?: string; object_refs?: string[] },
): Promise<void> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/atlas/claims/${claimId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to update claim')
}

export type EntityExcerpt = {
  excerpt: string
  section_title: string | null
  section_ordinal: number | null
}

export async function fetchEntityExcerpts(documentId: string, entityId: string): Promise<EntityExcerpt[]> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/atlas/entities/${entityId}/excerpts`)
  if (!res.ok) return []
  return res.json()
}

export async function patchAtlasEntity(documentId: string, entityId: string, body: { place_kind?: string; tier?: string }): Promise<void> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/atlas/entities/${entityId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to update entity')
}

export async function deleteAtlasEntity(documentId: string, entityId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/atlas/entities/${entityId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Failed to delete entity')
}

export async function deleteAtlasClaim(documentId: string, claimId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/atlas/claims/${claimId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Failed to delete claim')
}

export async function createAtlasClaim(
  documentId: string,
  body: { claim_type?: string; predicate: string; subject_ref: string; object_refs: string[] },
): Promise<AtlasClaim> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/atlas/claims`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claim_type: 'spatial', ...body }),
  })
  if (!res.ok) throw new Error('Failed to create claim')
  return res.json()
}

export async function downloadAtlasPackage(documentId: string, documentTitle: string): Promise<void> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/atlas-package`)
  if (!res.ok) throw new Error('Failed to export atlas package')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `atlas-${documentTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}-v0.1.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
