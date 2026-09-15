import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { SectionEditor } from './SectionEditor'
import { SourceWorkflow } from './SourceWorkflow'
import {
  deleteDocument,
  fetchDocuments,
  fetchSections,
  importDocument,
  patchDocument,
  resetLibrary,
  updateSections,
  type Document,
  type Section,
  type SectionUpdate,
} from './sourceApi'
import { AtlasExplorer } from '../atlas/AtlasExplorer'

type View = 'workflow' | 'edit-sections' | 'atlas-explorer'

const S = {
  shell: { display: 'flex' as const, height: '100%' },
}

export function SourceLibrary() {
  const [documents, setDocuments]               = useState<Document[]>([])
  const [selected, setSelected]                 = useState<Document | null>(null)
  const [sections, setSections]                 = useState<Section[]>([])
  const [view, setView]                         = useState<View>('workflow')
  const [error, setError]                       = useState<string | null>(null)
  const [importing, setImporting]               = useState(false)
  const [showReset, setShowReset]               = useState(false)
  const [resetInput, setResetInput]             = useState('')
  const [resetting, setResetting]               = useState(false)
  const [editingDoc, setEditingDoc]             = useState<Document | null>(null)
  const [editTitle, setEditTitle]               = useState('')
  const [editAuthor, setEditAuthor]             = useState('')
  const [editYear, setEditYear]                 = useState('')
  const [editSaving, setEditSaving]             = useState(false)
  const [sidebarOpen, setSidebarOpen]           = useState(true)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { fetchDocuments().then(setDocuments).catch(() => {}) }, [])

  async function handleSelect(doc: Document) {
    setSelected(doc)
    setView('workflow')
    setError(null)
    setSections([])
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
      setDocuments(prev => [...prev, result.document])
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
      setDocuments(prev => prev.filter(d => d.id !== doc.id))
      if (selected?.id === doc.id) {
        setSelected(null)
        setSections([])
        setView('workflow')
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

  function openEdit(doc: Document) {
    setEditingDoc(doc)
    setEditTitle(doc.title)
    setEditAuthor(doc.author ?? '')
    setEditYear(doc.year ? String(doc.year) : '')
  }

  async function saveEdit() {
    if (!editingDoc) return
    setEditSaving(true)
    try {
      const year = editYear.trim() ? parseInt(editYear, 10) : null
      const updated = await patchDocument(editingDoc.id, {
        title: editTitle.trim() || editingDoc.title,
        author: editAuthor.trim() || undefined,
        year: year ?? undefined,
      })
      setDocuments(prev => prev.map(d => d.id === updated.id ? updated : d))
      if (selected?.id === updated.id) setSelected(updated)
      setEditingDoc(null)
    } catch {
      setError('Could not update document metadata.')
    } finally {
      setEditSaving(false)
    }
  }

  async function handleReset() {
    setResetting(true)
    try {
      await resetLibrary()
      setDocuments([])
      setSelected(null)
      setSections([])
      setView('workflow')
      setError(null)
    } catch {
      setError('Reset failed.')
    } finally {
      setResetting(false)
      setShowReset(false)
      setResetInput('')
    }
  }

  const mainStyle = view === 'atlas-explorer'
    ? { flex: 1, overflow: 'hidden' as const, backgroundColor: 'var(--parchment)' }
    : { flex: 1, overflowY: 'auto' as const, backgroundColor: 'var(--parchment)', padding: '3.5rem 4rem' }

  return (
    <div style={S.shell}>
      {/* ── Body ────────────────────────────────────────────────────── */}

        {/* Sidebar */}
        <nav
          className="texture-dark"
          style={{
            width: sidebarOpen ? '288px' : '44px',
            flexShrink: 0,
            backgroundColor: 'var(--sidebar-bg)',
            borderRight: '1px solid var(--sidebar-border)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column' as const,
            transition: 'width 0.3s ease',
            position: 'relative' as const,
          }}
        >
          {/* Collapsed rail — fades in when sidebar is closed */}
          <button
            onClick={() => setSidebarOpen(true)}
            title="Open library"
            style={{
              position: 'absolute' as const, inset: 0,
              display: 'flex', flexDirection: 'column' as const,
              alignItems: 'center', paddingTop: '1.2rem', gap: '0.75rem',
              background: 'none', border: 'none', cursor: 'pointer',
              opacity: sidebarOpen ? 0 : 1,
              pointerEvents: sidebarOpen ? 'none' : 'auto',
              transition: 'opacity 0.18s ease',
            }}
          >
            <span style={{ color: 'var(--gold)', fontSize: '1rem', lineHeight: 1 }}>›</span>
            <span style={{
              writingMode: 'vertical-rl' as const, transform: 'rotate(180deg)',
              fontSize: '0.58rem', letterSpacing: '0.22em',
              color: 'var(--gold)', textTransform: 'uppercase' as const,
              fontWeight: 400, opacity: 0.72,
            }}>Coronelli</span>
          </button>

          {/* Full sidebar content — fades out when collapsed */}
          <div style={{
            width: '288px', flex: 1,
            display: 'flex', flexDirection: 'column' as const, overflowY: 'auto' as const,
            opacity: sidebarOpen ? 1 : 0,
            transition: 'opacity 0.15s ease',
            pointerEvents: sidebarOpen ? 'auto' : 'none' as any,
          }}>

          {/* Brand — sidebar-brand class carries the botanical ::after ornament */}
          <div className="sidebar-brand" style={{ padding: '1.4rem 1.25rem 1rem', borderBottom: '1px solid var(--sidebar-border)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: '1.1rem', letterSpacing: '0.18em', color: 'var(--gold)', textTransform: 'uppercase', fontWeight: 400, lineHeight: 1 }}>
                Coronelli
              </div>
              <div style={{ fontSize: '0.55rem', color: 'var(--sidebar-muted)', letterSpacing: '0.2em', textTransform: 'uppercase', marginTop: '0.35rem' }}>
                Texts for places
              </div>
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              title="Collapse library"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--sidebar-muted)', fontSize: '1.1rem', padding: '0',
                opacity: 0.45, lineHeight: 1, flexShrink: 0,
                transition: 'opacity 0.15s',
              }}
            >
              ‹
            </button>
          </div>

          <div style={{ padding: '1.1rem 1.25rem 0.75rem' }}>
            <label style={{ display: 'block', cursor: importing ? 'wait' : 'pointer' }}>
              <input ref={fileRef} type="file" accept=".txt,.md,.pdf"
                style={{ display: 'none' }} onChange={handleImportFile} disabled={importing} />
              <span style={{
                display: 'flex', alignItems: 'center', gap: '0.4rem',
                border: '1px solid var(--sidebar-border)', borderRadius: '4px',
                padding: '0.4rem 0.85rem', color: 'var(--sidebar-text)',
                fontSize: '0.8rem', opacity: importing ? 0.55 : 1, userSelect: 'none' as const,
              }}>
                + {importing ? 'Importing…' : 'Add to Library'}
              </span>
            </label>
          </div>

          {error && (
            <p style={{ padding: '0 1.25rem 0.5rem', fontSize: '0.73rem', color: '#e87070' }}>
              {error}
            </p>
          )}

          <div style={{ padding: '0.5rem 1.25rem 0.3rem' }}>
            <p style={{ fontSize: '0.58rem', color: 'var(--sidebar-muted)', letterSpacing: '0.13em', textTransform: 'uppercase' }}>
              Standalone works
            </p>
          </div>

          <ul style={{ listStyle: 'none', paddingBottom: '0.75rem' }}>
            {documents.length === 0 && (
              <li style={{ padding: '0.35rem 1.25rem', fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>
                No works yet
              </li>
            )}
            {documents.map(doc => (
              <li key={doc.id} style={{ margin: '0.6rem 0.5rem 0 0' }}>
                <button
                  onClick={() => handleSelect(doc)}
                  className={`sidebar-doc-btn${selected?.id === doc.id ? ' active' : ''}`}
                >
                  <div style={{ fontWeight: 400, fontSize: '0.92rem', color: selected?.id === doc.id ? 'var(--sidebar-text)' : 'var(--sidebar-muted)', lineHeight: 1.35, marginBottom: doc.author || doc.year ? '0.4rem' : 0 }}>
                    {doc.title}
                  </div>
                  {doc.author && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--sidebar-muted)', opacity: selected?.id === doc.id ? 0.8 : 0.6 }}>{doc.author}</div>
                  )}
                  {doc.year && (
                    <div style={{ fontSize: '0.65rem', color: 'var(--sidebar-muted)', opacity: 0.5, marginTop: '0.15rem' }}>{doc.year}</div>
                  )}
                </button>
              </li>
            ))}
          </ul>

          <div style={{
            borderTop: '1px solid var(--sidebar-border)',
            padding: '0.75rem 1.25rem 0.35rem',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <p style={{ fontSize: '0.58rem', color: 'var(--sidebar-muted)', letterSpacing: '0.13em', textTransform: 'uppercase' }}>
              Series
            </p>
            <button style={{
              fontSize: '0.68rem', color: 'var(--sidebar-muted)', background: 'none',
              border: '1px solid var(--sidebar-border)', borderRadius: '3px',
              padding: '0.1rem 0.4rem', cursor: 'not-allowed', opacity: 0.6,
            }}>
              + New series
            </button>
          </div>
          <p style={{ padding: '0.2rem 1.25rem 1rem', fontSize: '0.75rem', color: 'var(--sidebar-muted)', fontStyle: 'italic' }}>
            Coming soon
          </p>

          <div style={{ marginTop: 'auto', borderTop: '1px solid var(--sidebar-border)', padding: '0.75rem 1.25rem' }}>
            <button
              type="button"
              onClick={() => { setShowReset(true); setResetInput('') }}
              style={{
                fontSize: '0.65rem', color: 'var(--sidebar-muted)', background: 'none',
                border: '1px solid var(--sidebar-border)', borderRadius: '3px',
                padding: '0.18rem 0.55rem', cursor: 'pointer', opacity: 0.65,
                letterSpacing: '0.08em', textTransform: 'uppercase' as const,
              }}
            >
              Burn library
            </button>
          </div>

          </div>{/* end full sidebar content */}
        </nav>

        {/* Main content */}
        <main style={mainStyle} className="texture-parchment">
          {!selected ? (
            <div style={{ textAlign: 'center', paddingTop: '5rem', color: 'var(--ink-faint)' }}>
              <p style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>Select a work from the library</p>
              <p style={{ fontSize: '0.82rem' }}>or add one with + Add to Library</p>
            </div>
          ) : view === 'atlas-explorer' ? (
            <AtlasExplorer
              documentId={selected.id}
              sections={sections}
              onAtlasLoaded={() => {}}
            />
          ) : view === 'edit-sections' ? (
            <>
              <button type="button" onClick={() => setView('workflow')}
                style={{ fontSize: '0.8rem', marginBottom: '1.25rem', color: 'var(--ink-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                ← Back to workflow
              </button>
              <SectionEditor documentId={selected.id} sections={sections} onSave={handleSave} />
            </>
          ) : (
            <SourceWorkflow
              document={selected}
              sections={sections}
              onEditSections={() => setView('edit-sections')}
              onAtlasChanged={() => {}}
              onViewAtlas={() => setView('atlas-explorer')}
              onEdit={() => openEdit(selected)}
              onDelete={() => handleDelete(selected)}
            />
          )}
        </main>

      {/* ── Edit metadata overlay ───────────────────────────────────── */}
      {editingDoc && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }}>
          <div style={{
            background: 'var(--parchment)', border: '1px solid var(--border-warm)',
            borderRadius: '6px', padding: '2rem 2.25rem', width: '380px', maxWidth: '90vw',
          }}>
            <p style={{ fontSize: '1rem', fontWeight: 400, color: 'var(--ink)', marginBottom: '1.25rem' }}>
              Edit metadata
            </p>
            {[
              { label: 'Title', value: editTitle, set: setEditTitle, type: 'text' },
              { label: 'Author', value: editAuthor, set: setEditAuthor, type: 'text' },
              { label: 'Year', value: editYear, set: setEditYear, type: 'number' },
            ].map(({ label, value, set, type }) => (
              <div key={label} style={{ marginBottom: '0.9rem' }}>
                <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--ink-muted)', marginBottom: '0.25rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {label}
                </label>
                <input
                  type={type}
                  value={value}
                  onChange={e => set(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveEdit() }}
                  style={{
                    width: '100%', boxSizing: 'border-box' as const,
                    padding: '0.45rem 0.75rem', fontSize: '0.85rem',
                    border: '1px solid var(--border-warm)', borderRadius: '4px',
                    background: 'var(--parchment-alt)', color: 'var(--ink)', outline: 'none',
                  }}
                />
              </div>
            ))}
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <button type="button" onClick={() => setEditingDoc(null)} disabled={editSaving}
                style={{ fontSize: '0.8rem', padding: '0.45rem 1rem', background: 'none', border: '1px solid var(--border-warm)', borderRadius: '4px', cursor: 'pointer', color: 'var(--ink-muted)' }}>
                Cancel
              </button>
              <button type="button" onClick={saveEdit} disabled={editSaving}
                style={{ fontSize: '0.8rem', padding: '0.45rem 1.1rem', background: 'var(--gold)', border: 'none', borderRadius: '4px', cursor: 'pointer', color: '#1a1008', opacity: editSaving ? 0.6 : 1 }}>
                {editSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showReset && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }}>
          <div style={{
            background: 'var(--parchment)', border: '1px solid var(--border-warm)',
            borderRadius: '6px', padding: '2rem 2.25rem', width: '360px', maxWidth: '90vw',
          }}>
            <p style={{ fontSize: '1rem', fontWeight: 400, color: 'var(--ink)', marginBottom: '0.4rem' }}>
              Reset the library?
            </p>
            <p style={{ fontSize: '0.8rem', color: 'var(--ink-muted)', marginBottom: '1.5rem', lineHeight: 1.55 }}>
              This permanently deletes every document, section, candidate, synthesis run, and atlas entity.
              There is no undo.
            </p>
            <p style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', marginBottom: '0.5rem' }}>
              Type <strong>reset</strong> to confirm:
            </p>
            <input
              type="text"
              value={resetInput}
              onChange={e => setResetInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && resetInput === 'reset') handleReset() }}
              placeholder="reset"
              autoFocus
              style={{
                width: '100%', boxSizing: 'border-box' as const,
                padding: '0.5rem 0.75rem', fontSize: '0.85rem',
                border: '1px solid var(--border-warm)', borderRadius: '4px',
                background: 'var(--parchment-alt)', color: 'var(--ink)',
                marginBottom: '1.25rem', outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => { setShowReset(false); setResetInput('') }}
                disabled={resetting}
                style={{
                  fontSize: '0.8rem', padding: '0.45rem 1rem',
                  background: 'none', border: '1px solid var(--border-warm)',
                  borderRadius: '4px', cursor: 'pointer', color: 'var(--ink-muted)',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={resetInput !== 'reset' || resetting}
                style={{
                  fontSize: '0.8rem', padding: '0.45rem 1rem',
                  background: resetInput === 'reset' ? '#7f1d1d' : 'var(--border-warm)',
                  border: 'none', borderRadius: '4px',
                  cursor: resetInput === 'reset' ? 'pointer' : 'not-allowed',
                  color: resetInput === 'reset' ? '#fef2f2' : 'var(--ink-faint)',
                  opacity: resetting ? 0.6 : 1,
                  transition: 'background 0.15s',
                }}
              >
                {resetting ? 'Resetting…' : 'Reset everything'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
