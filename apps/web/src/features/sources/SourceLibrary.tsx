import { useEffect, useRef, useState } from 'react'
import { SectionEditor } from './SectionEditor'
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

export function SourceLibrary() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [selected, setSelected] = useState<Document | null>(null)
  const [sections, setSections] = useState<Section[]>([])
  const [category, setCategory] = useState<'demo' | 'private'>('demo')
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
      const result = await importDocument(file, category)
      setDocuments((prev) => [...prev, result.document])
      setSelected(result.document)
      setSections(result.sections)
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
      setSections(await updateSections(selected.id, updates))
    } catch {
      setError('Could not save sections.')
    }
  }

  return (
    <div>
      <section aria-label="Import document">
        <form onSubmit={handleImport}>
          <input ref={fileRef} type="file" accept=".txt,.md,.pdf" aria-label="Choose file" />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as 'demo' | 'private')}
            aria-label="Workspace category"
          >
            <option value="demo">Demo</option>
            <option value="private">Private</option>
          </select>
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
                  <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: '#888' }}>
                    ({doc.category})
                  </span>
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

      {selected && sections.length > 0 && (
        <section aria-label={`Sections for ${selected.title}`}>
          <h2>{selected.title}</h2>
          <SectionEditor documentId={selected.id} sections={sections} onSave={handleSave} />
        </section>
      )}
    </div>
  )
}
