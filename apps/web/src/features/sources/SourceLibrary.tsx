import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
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

const S = {
  shell: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    height: '100%',
  },
  header: {
    background: 'var(--sidebar-bg)',
    borderBottom: '1px solid var(--sidebar-border)',
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    padding: '0 1.75rem',
    height: '52px',
    flexShrink: 0,
  },
  brand: {
    fontSize: '1.55rem',
    color: 'var(--gold)',
    letterSpacing: '0.04em',
    fontWeight: 400,
  },
  tagline: {
    fontSize: '0.6rem',
    color: 'var(--sidebar-muted)',
    letterSpacing: '0.22em',
    textTransform: 'uppercase' as const,
  },
  body: {
    flex: 1,
    display: 'flex' as const,
    overflow: 'hidden' as const,
  },
  sidebar: {
    width: '272px',
    flexShrink: 0,
    background: 'var(--sidebar-bg)',
    borderRight: '1px solid var(--sidebar-border)',
    overflowY: 'auto' as const,
    display: 'flex' as const,
    flexDirection: 'column' as const,
  },
  main: {
    flex: 1,
    overflowY: 'auto' as const,
    background: 'var(--parchment)',
    padding: '2.75rem 3.25rem',
  },
  inspector: {
    width: '288px',
    flexShrink: 0,
    background: 'var(--parchment-alt)',
    borderLeft: '1px solid var(--border-warm)',
    overflowY: 'auto' as const,
    padding: '1.75rem 1.5rem',
  },
  footer: {
    background: 'var(--sidebar-bg)',
    borderTop: '1px solid var(--sidebar-border)',
    height: '40px',
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    padding: '0 1.75rem',
    flexShrink: 0,
  },
  footerText: {
    fontSize: '0.68rem',
    color: 'var(--sidebar-muted)',
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
  },
}

export function SourceLibrary() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [selected, setSelected] = useState<Document | null>(null)
  const [sections, setSections] = useState<Section[]>([])
  const [view, setView] = useState<View>('workflow')
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchDocuments().then(setDocuments).catch(() => {})
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

  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
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
    <div style={S.shell}>
      {/* ── Header ────────────────────────────────────────────────── */}
      <header style={S.header}>
        <span style={S.brand}>Coronelli</span>
        <span style={S.tagline}>Texts for places · a richer world</span>
      </header>

      {/* ── Body ──────────────────────────────────────────────────── */}
      <div style={S.body}>

        {/* Sidebar */}
        <nav style={S.sidebar}>
          {/* Library heading */}
          <div style={{ padding: '1.5rem 1.25rem 0.75rem' }}>
            <p style={{
              fontSize: '1.2rem', fontWeight: 400,
              color: 'var(--sidebar-text)', marginBottom: '0.85rem',
            }}>
              Library
            </p>

            {/* Add to Library */}
            <label style={{ display: 'block', cursor: importing ? 'wait' : 'pointer' }}>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,.pdf"
                style={{ display: 'none' }}
                onChange={handleImportFile}
                disabled={importing}
              />
              <span style={{
                display: 'flex', alignItems: 'center', gap: '0.4rem',
                border: '1px solid var(--sidebar-border)',
                borderRadius: '4px',
                padding: '0.4rem 0.85rem',
                color: 'var(--sidebar-text)',
                fontSize: '0.8rem',
                opacity: importing ? 0.55 : 1,
                userSelect: 'none' as const,
              }}>
                + {importing ? 'Importing…' : 'Add to Library'}
              </span>
            </label>
          </div>

          {error && (
            <p style={{
              padding: '0 1.25rem 0.5rem',
              fontSize: '0.73rem',
              color: '#e87070',
            }}>
              {error}
            </p>
          )}

          {/* Standalone works */}
          <div style={{ padding: '0.5rem 1.25rem 0.3rem' }}>
            <p style={{
              fontSize: '0.58rem',
              color: 'var(--sidebar-muted)',
              letterSpacing: '0.13em',
              textTransform: 'uppercase',
            }}>
              Standalone works
            </p>
          </div>

          <ul style={{ listStyle: 'none', paddingBottom: '0.75rem' }}>
            {documents.length === 0 && (
              <li style={{ padding: '0.35rem 1.25rem', fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>
                No works yet
              </li>
            )}
            {documents.map((doc) => (
              <li key={doc.id} style={{ display: 'flex', alignItems: 'center' }}>
                <button
                  className={`sidebar-item${selected?.id === doc.id ? ' active' : ''}`}
                  onClick={() => handleSelect(doc)}
                >
                  <span style={{ fontSize: '0.75rem', opacity: 0.5, flexShrink: 0 }}>◻</span>
                  <span style={{
                    flex: 1, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {doc.title}
                  </span>
                  {selected?.id === doc.id && (
                    <span style={{ fontSize: '0.7rem', opacity: 0.6, flexShrink: 0 }}>›</span>
                  )}
                </button>
                <button
                  className="sidebar-delete-btn"
                  onClick={() => handleDelete(doc)}
                  title={`Remove ${doc.title}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>

          {/* Series */}
          <div style={{
            borderTop: '1px solid var(--sidebar-border)',
            padding: '0.75rem 1.25rem 0.35rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <p style={{
              fontSize: '0.58rem',
              color: 'var(--sidebar-muted)',
              letterSpacing: '0.13em',
              textTransform: 'uppercase',
            }}>
              Series
            </p>
            <button style={{
              fontSize: '0.68rem',
              color: 'var(--sidebar-muted)',
              background: 'none',
              border: '1px solid var(--sidebar-border)',
              borderRadius: '3px',
              padding: '0.1rem 0.4rem',
              cursor: 'not-allowed',
              opacity: 0.6,
            }}>
              + New series
            </button>
          </div>
          <p style={{
            padding: '0.2rem 1.25rem 1rem',
            fontSize: '0.75rem',
            color: 'var(--sidebar-muted)',
            fontStyle: 'italic',
          }}>
            Coming soon
          </p>
        </nav>

        {/* Main content */}
        <main style={S.main}>
          {!selected ? (
            <div style={{ textAlign: 'center', paddingTop: '5rem', color: 'var(--ink-faint)' }}>
              <p style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>Select a work from the library</p>
              <p style={{ fontSize: '0.82rem' }}>or add one with + Add to Library</p>
            </div>
          ) : view === 'edit-sections' ? (
            <>
              <button
                type="button"
                onClick={() => setView('workflow')}
                style={{
                  fontSize: '0.8rem', marginBottom: '1.25rem',
                  color: 'var(--ink-muted)', background: 'none',
                  border: 'none', cursor: 'pointer', padding: 0,
                }}
              >
                ← Back to workflow
              </button>
              <SectionEditor
                documentId={selected.id}
                sections={sections}
                onSave={handleSave}
              />
            </>
          ) : (
            <SourceWorkflow
              document={selected}
              sections={sections}
              onEditSections={() => setView('edit-sections')}
            />
          )}
        </main>

        {/* Inspector */}
        <aside style={S.inspector}>
          <h3 style={{
            fontSize: '1.2rem', fontWeight: 400,
            color: 'var(--ink)', marginBottom: '0.35rem',
          }}>
            Inspector
          </h3>
          <div style={{
            width: '40px', height: '1px',
            background: 'var(--gold)', marginBottom: '2rem',
          }} />
          <div style={{ textAlign: 'center', paddingTop: '2rem', color: 'var(--ink-faint)' }}>
            <div style={{ fontSize: '2.25rem', marginBottom: '0.85rem', opacity: 0.25 }}>⊙</div>
            <p style={{ fontSize: '0.8rem', lineHeight: 1.55 }}>
              Select a place, route, or source detail to inspect it.
            </p>
          </div>
        </aside>
      </div>

      {/* ── Footer ────────────────────────────────────────────────── */}
      <footer style={S.footer}>
        <span style={S.footerText}>◻ Atlas Explorer</span>
        <span style={S.footerText}>
          {selected && sections.length > 0
            ? '● Atlas available'
            : '⊘ Available after extraction is complete'}
        </span>
      </footer>
    </div>
  )
}
