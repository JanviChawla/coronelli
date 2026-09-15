const BASE = 'http://localhost:8000'

export type Section = {
  id: string
  document_id: string
  ordinal: number
  title: string | null
  text: string
  page_start: number | null
  page_end: number | null
  user_corrected: boolean
}

export type Document = {
  id: string
  title: string
  original_filename: string
  mime_type: string
  content_hash: string
  imported_at: string
  parser_version: string
  category: string
  series_id: string | null
  series_order: number | null
}

export type SectionUpdate = {
  id: string
  ordinal: number
  title: string | null
  text: string
}

export async function fetchDocuments(): Promise<Document[]> {
  const res = await fetch(`${BASE}/api/documents`)
  if (!res.ok) throw new Error('Failed to fetch documents')
  return res.json()
}

export async function fetchSections(documentId: string): Promise<Section[]> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/sections`)
  if (!res.ok) throw new Error('Failed to fetch sections')
  return res.json()
}

export async function importDocument(
  file: File,
  category: string,
): Promise<{ document: Document; sections: Section[] }> {
  const form = new FormData()
  form.append('file', file)
  form.append('category', category)
  const res = await fetch(`${BASE}/api/documents/import`, { method: 'POST', body: form })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Import failed' }))
    throw new Error(err.detail ?? 'Import failed')
  }
  return res.json()
}

export async function deleteDocument(documentId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/documents/${documentId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete document')
}

export async function resetLibrary(): Promise<void> {
  const res = await fetch(`${BASE}/api/admin/reset`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Reset failed')
}

export async function updateSections(
  documentId: string,
  sections: SectionUpdate[],
): Promise<Section[]> {
  const res = await fetch(`${BASE}/api/documents/${documentId}/sections`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sections),
  })
  if (!res.ok) throw new Error('Failed to save sections')
  return res.json()
}
