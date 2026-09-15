import { useEffect, useRef, useState } from 'react'
import { SectionEditor } from './SectionEditor'
import { SourceWorkflow } from './SourceWorkflow'
import {
  deleteDocument,
  fetchDocuments,
  fetchSections,
  importDocument,
  updateSections,
  type Document,
  type Section,
  type SectionUpdate,
} from './sourceApi'

type View = 'workflow' | 'edit-sections'

export function SourceLibrary() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [selected, setSelected] = useState<Document | null>(null)
  const [sections, setSections] = useState<Section[]>([])
  const [view, setView] = useState<View>('workflow')
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchDocuments()
      .then(setDocuments)
      .catch(() => {})
  }, [])

  async function handleSelect(doc: Document) {
    setSelected(doc)
    setView('workflow')
    setError(null)
    try {
      setSections(await fetchSections(doc.id))
    } catch {
      setError('Could not load sections.')
    }
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault()
    const file = fileRef.current?.files?.[0]
    if (!file) return
    setImporting(true)
    setError(null)
    try {
      const result = await importDocument(file, 'demo')
      setDocuments((prev) => [...prev, result.document])
      setSelected(result.document)
      setSections(result.sections)
      setView('workflow')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import failed.')
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleDelete(doc: Document) {
    try {
      await deleteDocument(doc.id)
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id))
      if (selected?.id === doc.id) {
        setSelected(null)
        setSections([])
      }
    } catch {
      setError('Could not delete document.')
    }
  }

  async function handleSave(updates: SectionUpdate[]) {
    if (!selected) return
    try {
      const updated = await updateSections(selected.id, updates)
      setSections(updated)
      setView('workflow')
    } catch {
      setError('Could not save sections.')
    }
  }

  return (
    <div>
      <section aria-label="Import document">
        <form onSubmit={handleImport}>
          <input ref={fileRef} type="file" accept=".txt,.md,.pdf" aria-label="Choose file" />
          <button type="submit" disabled={importing}>
            {importing ? 'Importing…' : 'Import'}
          </button>
        </form>
      </section>

      {error && <p role="alert" style={{ color: 'red' }}>{error}</p>}

      <section aria-label="Document library">
        {documents.length === 0 ? (
          <p>No documents yet. Import a .txt, .md, or .pdf file to get started.</p>
        ) : (
          <ul>
            {documents.map((doc) => (
              <li key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <button
                  onClick={() => handleSelect(doc)}
                  aria-current={selected?.id === doc.id ? 'true' : undefined}
                >
                  {doc.title}
                </button>
                <button
                  onClick={() => handleDelete(doc)}
                  aria-label={`Delete ${doc.title}`}
                  style={{ fontSize: '0.75rem', color: '#c00' }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && sections.length > 0 && view === 'workflow' && (
        <section aria-label={`Workflow for ${selected.title}`} style={{ marginTop: '1.5rem' }}>
          <SourceWorkflow
            document={selected}
            sections={sections}
            onEditSections={() => setView('edit-sections')}
          />
        </section>
      )}

      {selected && sections.length > 0 && view === 'edit-sections' && (
        <section aria-label={`Edit sections for ${selected.title}`} style={{ marginTop: '1.5rem' }}>
          <button
            type="button"
            onClick={() => setView('workflow')}
            style={{ fontSize: '0.8rem', marginBottom: '0.75rem' }}
          >
            ← Back to workflow
          </button>
          <SectionEditor
            documentId={selected.id}
            sections={sections}
            onSave={handleSave}
          />
        </section>
      )}
    </div>
  )
}
