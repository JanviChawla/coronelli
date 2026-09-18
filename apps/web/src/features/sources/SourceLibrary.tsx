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

type View = 'workflow' | 'edit-sections' | 'sections-review'

export function SourceLibrary() {
  const [documents, setDocuments]     = useState<Document[]>([])
  const [selected, setSelected]       = useState<Document | null>(null)
  const [sections, setSections]       = useState<Section[]>([])
  const [view, setView]               = useState<View>('workflow')
  const [error, setError]             = useState<string | null>(null)
  const [importing, setImporting]     = useState(false)
  const [showReset, setShowReset]     = useState(false)
  const [resetInput, setResetInput]   = useState('')
  const [resetting, setResetting]     = useState(false)
  const [editingDoc, setEditingDoc]   = useState<Document | null>(null)
  const [editTitle, setEditTitle]     = useState('')
  const [editAuthor, setEditAuthor]   = useState('')
  const [editYear, setEditYear]       = useState('')
  const [editSaving, setEditSaving]   = useState(false)
  const [confirmingBurnId, setConfirmingBurnId] = useState<string | null>(null)
  const burnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { fetchDocuments().then(setDocuments).catch(() => {}) }, [])

  async function handleSelectDoc(doc: Document) {
    setSelected(doc)
    setView('sections-review')
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
      setView('sections-review')
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
      setError(null)
    } catch {
      setError('Reset failed.')
    } finally {
      setResetting(false)
      setShowReset(false)
      setResetInput('')
    }
  }

  function triggerBurn(doc: Document) {
    if (confirmingBurnId === doc.id) {
      if (burnTimerRef.current) clearTimeout(burnTimerRef.current)
      setConfirmingBurnId(null)
      handleDelete(doc)
    } else {
      if (burnTimerRef.current) clearTimeout(burnTimerRef.current)
      setConfirmingBurnId(doc.id)
      burnTimerRef.current = setTimeout(() => setConfirmingBurnId(null), 3000)
    }
  }

  // ── Sections review (after import or open) ───────────────────────────────

  if (selected && view === 'sections-review') {
    return (
      <div style={{ height: '100%', background: 'var(--parchment)', display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto', padding: '3.5rem 2rem 4rem' }}>
        <div style={{ width: '100%', maxWidth: '580px' }}>
          <button type="button" onClick={() => setSelected(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '0.72rem', color: 'var(--ink-muted)', marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            ← Library
          </button>

          {/* Book identity */}
          <div style={{ marginBottom: '1.75rem' }}>
            <h2 style={{ fontSize: '2rem', fontWeight: 400, color: 'var(--ink-muted)', marginBottom: '0.25rem', lineHeight: 1.2 }}>{selected.title}</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              {selected.author && <span style={{ fontSize: '0.88rem', color: 'var(--ink-faint)' }}>{selected.author}</span>}
              {selected.year && <span style={{ fontSize: '0.8rem', color: 'var(--ink-faint)', opacity: 0.7 }}>{selected.year}</span>}
              <button type="button" onClick={() => openEdit(selected)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '0.72rem', color: 'var(--ink-faint)', textDecoration: 'underline', textDecorationColor: 'rgba(140,120,80,0.35)', textUnderlineOffset: '3px' }}>
                ✎ Edit
              </button>
            </div>
          </div>

          {/* Sections list */}
          <p style={{ fontSize: '0.6rem', color: 'var(--ink-faint)', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
            {sections.length} section{sections.length !== 1 ? 's' : ''}
          </p>
          <div style={{ border: '1px solid var(--border-warm)', borderRadius: '6px', background: 'var(--parchment-card)', overflow: 'hidden', marginBottom: '2rem' }}>
            {sections.length === 0 ? (
              <div style={{ padding: '1rem 1.1rem', fontSize: '0.85rem', color: 'var(--ink-faint)', fontStyle: 'italic' }}>Loading sections…</div>
            ) : sections.map((s, i) => {
              const nonEmpty = s.text.split('\n').filter(l => l.trim())
              const preview = nonEmpty.slice(0, 3).map(l => l.length > 130 ? l.slice(0, 130) + '…' : l).join(' ')
              return (
                <div key={s.id} style={{ padding: '0.6rem 1.1rem', borderBottom: i < sections.length - 1 ? '1px solid rgba(212,188,138,0.15)' : 'none' }}>
                  <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'baseline', marginBottom: preview ? '0.18rem' : 0 }}>
                    <span style={{ fontSize: '0.58rem', color: 'var(--gold)', minWidth: '1.6rem', flexShrink: 0, fontFamily: 'monospace', opacity: 0.8 }}>§{s.ordinal}</span>
                    <span style={{ fontSize: '0.88rem', color: 'var(--ink-muted)', fontWeight: 500 }}>{s.title || `Section ${s.ordinal}`}</span>
                  </div>
                  {preview && (
                    <div style={{ paddingLeft: '2.3rem', fontSize: '0.75rem', color: 'var(--ink-faint)', fontStyle: 'italic', lineHeight: 1.45 }}>
                      {preview}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <button type="button" className="btn-cta" onClick={() => setView('workflow')} style={{ width: '100%' }}>
            Begin pipeline →
          </button>
          {error && <p style={{ color: '#e87070', fontSize: '0.78rem', marginTop: '0.75rem' }}>{error}</p>}
        </div>
        {editingDocOverlay()}
        {resetModal()}
      </div>
    )
  }

  // ── Workflow view (book open) ─────────────────────────────────────────────

  if (selected) {
    if (view === 'edit-sections') {
      return (
        <div style={{ display: 'flex', height: '100%', flexDirection: 'column', background: 'var(--parchment)', padding: '3.5rem 4rem', overflowY: 'auto' }}>
          <button type="button" onClick={() => setView('workflow')}
            style={{ fontSize: '0.8rem', marginBottom: '1.25rem', color: 'var(--ink-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}>
            ← Back to workflow
          </button>
          <SectionEditor documentId={selected.id} sections={sections} onSave={handleSave} />
          {editingDocOverlay()}
          {resetModal()}
        </div>
      )
    }

    return (
      <div style={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <SourceWorkflow
          document={selected}
          sections={sections}
          onBack={() => setSelected(null)}
          onEditSections={() => setView('edit-sections')}
          onEdit={() => openEdit(selected)}
          onDelete={() => { handleDelete(selected); setSelected(null) }}
        />
        {editingDocOverlay()}
        {resetModal()}
      </div>
    )
  }

  // ── Landing page ──────────────────────────────────────────────────────────

  return (
    <div className="texture-parchment" style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '5rem 2rem 4rem' }}>

      {/* Brand */}
      <div className="sidebar-brand" style={{ textAlign: 'center', marginBottom: '3.5rem' }}>
        <div style={{ fontSize: '2.2rem', letterSpacing: '0.28em', color: 'var(--gold)', textTransform: 'uppercase', fontWeight: 400, lineHeight: 1 }}>
          Coronelli
        </div>
        <div style={{ fontSize: '0.62rem', color: 'var(--ink-faint)', letterSpacing: '0.22em', textTransform: 'uppercase', marginTop: '0.6rem' }}>
          Texts for places
        </div>
      </div>

      {/* Add new book */}
      <label style={{ cursor: importing ? 'wait' : 'pointer', marginBottom: '2.5rem' }}>
        <input ref={fileRef} type="file" accept=".txt,.md,.pdf"
          style={{ display: 'none' }} onChange={handleImportFile} disabled={importing} />
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
          border: '1px solid var(--gold)', borderRadius: '5px',
          padding: '0.55rem 1.5rem', color: 'var(--gold)',
          fontSize: '0.88rem', opacity: importing ? 0.55 : 1, userSelect: 'none',
          letterSpacing: '0.08em',
        }}>
          {importing ? 'Importing…' : '+ Add New Book'}
        </span>
      </label>

      {error && (
        <p style={{ color: '#e87070', fontSize: '0.78rem', marginBottom: '1rem' }}>{error}</p>
      )}

      {/* Book grid */}
      {documents.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: '1.25rem',
          width: '100%',
          maxWidth: '900px',
          marginBottom: '3rem',
        }}>
          {documents.map(doc => (
            <div key={doc.id} style={{
              background: 'var(--parchment-card)',
              border: '1px solid var(--border-warm)',
              borderRadius: '6px',
              padding: '1.25rem 1.35rem 1rem',
              display: 'flex', flexDirection: 'column', gap: '0.25rem',
            }}>
              <div style={{ fontSize: '1rem', fontWeight: 500, color: 'var(--ink)', lineHeight: 1.3, marginBottom: '0.15rem' }}>
                {doc.title}
              </div>
              {doc.author && (
                <div style={{ fontSize: '0.78rem', color: 'var(--ink-muted)' }}>{doc.author}</div>
              )}
              {doc.year && (
                <div style={{ fontSize: '0.68rem', color: 'var(--ink-faint)' }}>{doc.year}</div>
              )}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.9rem' }}>
                <button
                  type="button"
                  onClick={() => handleSelectDoc(doc)}
                  style={{
                    flex: 1, padding: '0.4rem 0', fontSize: '0.8rem',
                    background: 'var(--gold)', color: '#1a1008',
                    border: 'none', borderRadius: '4px', cursor: 'pointer',
                    fontWeight: 600, letterSpacing: '0.04em',
                  }}
                >
                  Open
                </button>
                <button
                  type="button"
                  onClick={() => triggerBurn(doc)}
                  title={confirmingBurnId === doc.id ? 'Click again to confirm' : 'Delete this book'}
                  style={{
                    padding: '0.4rem 0.75rem', fontSize: '0.75rem',
                    background: 'none',
                    border: `1px solid ${confirmingBurnId === doc.id ? 'rgba(180,60,60,0.6)' : 'var(--border-warm)'}`,
                    borderRadius: '4px', cursor: 'pointer',
                    color: confirmingBurnId === doc.id ? '#c06060' : 'var(--ink-faint)',
                    transition: 'all 0.15s',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {confirmingBurnId === doc.id ? 'Sure?' : 'Burn'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {documents.length === 0 && !importing && (
        <p style={{ fontSize: '0.88rem', color: 'var(--ink-faint)', marginBottom: '3rem' }}>
          No books yet. Add one to begin.
        </p>
      )}

      {/* Burn library */}
      <button
        type="button"
        onClick={() => { setShowReset(true); setResetInput('') }}
        style={{
          fontSize: '0.62rem', color: 'var(--ink-faint)', background: 'none',
          border: '1px solid rgba(212,188,138,0.2)', borderRadius: '3px',
          padding: '0.22rem 0.65rem', cursor: 'pointer',
          letterSpacing: '0.1em', textTransform: 'uppercase',
          opacity: 0.6, marginTop: 'auto', paddingTop: '0.22rem',
        }}
      >
        Burn library
      </button>

      {editingDocOverlay()}
      {resetModal()}
    </div>
  )

  function editingDocOverlay() {
    if (!editingDoc) return null
    return (
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
    )
  }

  function resetModal() {
    if (!showReset) return null
    return (
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
            <button type="button" onClick={() => { setShowReset(false); setResetInput('') }} disabled={resetting}
              style={{ fontSize: '0.8rem', padding: '0.45rem 1rem', background: 'none', border: '1px solid var(--border-warm)', borderRadius: '4px', cursor: 'pointer', color: 'var(--ink-muted)' }}>
              Cancel
            </button>
            <button type="button" onClick={handleReset} disabled={resetInput !== 'reset' || resetting}
              style={{
                fontSize: '0.8rem', padding: '0.45rem 1rem',
                background: resetInput === 'reset' ? '#7f1d1d' : 'var(--border-warm)',
                border: 'none', borderRadius: '4px',
                cursor: resetInput === 'reset' ? 'pointer' : 'not-allowed',
                color: resetInput === 'reset' ? '#fef2f2' : 'var(--ink-faint)',
                opacity: resetting ? 0.6 : 1, transition: 'background 0.15s',
              }}>
              {resetting ? 'Resetting…' : 'Reset everything'}
            </button>
          </div>
        </div>
      </div>
    )
  }
}
