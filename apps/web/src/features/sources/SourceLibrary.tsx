import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { SectionEditor } from './SectionEditor'
import { SourceWorkflow } from './SourceWorkflow'
import {
  deleteDocument,
  fetchDocuments,
  fetchSections,
  importDocument,
  resetLibrary,
  updateSections,
  type Document,
  type Section,
  type SectionUpdate,
} from './sourceApi'
import { fetchAtlas, fetchEntityMentions } from '../atlas/atlasApi'
import type { EntityMention } from '../atlas/atlasApi'
import { AtlasExplorer, InspectorContent } from '../atlas/AtlasExplorer'
import type { InspectorTarget } from '../atlas/atlasGraph'

type View = 'workflow' | 'edit-sections' | 'atlas-explorer'

const S = {
  shell: { display: 'flex' as const, flexDirection: 'column' as const, height: '100%' },
  header: {
    background: 'var(--sidebar-bg)', borderBottom: '1px solid var(--sidebar-border)',
    display: 'flex' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const,
    padding: '0 1.75rem', height: '52px', flexShrink: 0,
  },
  brand:   { fontSize: '1.55rem', color: 'var(--gold)', letterSpacing: '0.04em', fontWeight: 400 },
  tagline: { fontSize: '0.6rem', color: 'var(--sidebar-muted)', letterSpacing: '0.22em', textTransform: 'uppercase' as const },
  body:    { flex: 1, display: 'flex' as const, overflow: 'hidden' as const },
  sidebar: {
    width: '272px', flexShrink: 0, background: 'var(--sidebar-bg)',
    borderRight: '1px solid var(--sidebar-border)',
    overflowY: 'auto' as const, display: 'flex' as const, flexDirection: 'column' as const,
  },
  inspector: {
    width: '288px', flexShrink: 0, background: 'var(--parchment-alt)',
    borderLeft: '1px solid var(--border-warm)', overflowY: 'auto' as const, padding: '1.75rem 1.5rem',
  },
  footer: {
    background: 'var(--sidebar-bg)', borderTop: '1px solid var(--sidebar-border)',
    height: '40px', display: 'flex' as const, alignItems: 'center' as const,
    justifyContent: 'space-between' as const, padding: '0 1.75rem', flexShrink: 0,
  },
  footerText: { fontSize: '0.68rem', color: 'var(--sidebar-muted)', letterSpacing: '0.1em', textTransform: 'uppercase' as const },
}

export function SourceLibrary() {
  const [documents, setDocuments]               = useState<Document[]>([])
  const [selected, setSelected]                 = useState<Document | null>(null)
  const [sections, setSections]                 = useState<Section[]>([])
  const [view, setView]                         = useState<View>('workflow')
  const [error, setError]                       = useState<string | null>(null)
  const [importing, setImporting]               = useState(false)
  const [hasApprovedAtlas, setHasApprovedAtlas] = useState(false)
  const [inspectorTarget, setInspectorTarget]   = useState<InspectorTarget>(null)
  const [entityMentions, setEntityMentions]     = useState<EntityMention[]>([])
  const [cursor, setCursor]                     = useState(0)
  const [showReset, setShowReset]               = useState(false)
  const [resetInput, setResetInput]             = useState('')
  const [resetting, setResetting]               = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const sectionTitles = new Map(sections.map(s => [s.id, s.title]))
  const sectionOrder  = new Map(sections.map((s, i) => [s.id, i]))

  useEffect(() => { fetchDocuments().then(setDocuments).catch(() => {}) }, [])

  async function checkAtlas(docId: string) {
    try {
      const atlas = await fetchAtlas(docId)
      setHasApprovedAtlas(atlas.entity_count > 0)
      if (atlas.entity_count > 0) {
        setEntityMentions(await fetchEntityMentions(docId))
      }
    } catch {
      setHasApprovedAtlas(false)
    }
  }

  async function handleSelect(doc: Document) {
    setSelected(doc)
    setView('workflow')
    setError(null)
    setInspectorTarget(null)
    setHasApprovedAtlas(false)
    setEntityMentions([])
    setCursor(0)
    setSections([])
    try {
      setSections(await fetchSections(doc.id))
      await checkAtlas(doc.id)
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
      setHasApprovedAtlas(false)
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
        setHasApprovedAtlas(false)
        setInspectorTarget(null)
        setEntityMentions([])
        setCursor(0)
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

  async function handleReset() {
    setResetting(true)
    try {
      await resetLibrary()
      setDocuments([])
      setSelected(null)
      setSections([])
      setHasApprovedAtlas(false)
      setInspectorTarget(null)
      setEntityMentions([])
      setCursor(0)
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

  function handleAtlasLoaded(entityCount: number) {
    setHasApprovedAtlas(entityCount > 0)
    if (entityCount > 0 && selected) {
      fetchEntityMentions(selected.id).then(setEntityMentions).catch(() => {})
    }
  }

  // Main panel style differs in explorer mode (no padding, no scroll)
  const mainStyle = view === 'atlas-explorer'
    ? { flex: 1, overflow: 'hidden' as const, background: 'var(--parchment)' }
    : { flex: 1, overflowY: 'auto' as const, background: 'var(--parchment)', padding: '2.75rem 3.25rem' }

  return (
    <div style={S.shell}>
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header style={S.header}>
        <span style={S.brand}>Coronelli</span>
        <span style={S.tagline}>Texts for places · a richer world</span>
      </header>

      {/* ── Body ────────────────────────────────────────────────────── */}
      <div style={S.body}>

        {/* Sidebar */}
        <nav style={S.sidebar}>
          <div style={{ padding: '1.5rem 1.25rem 0.75rem' }}>
            <p style={{ fontSize: '1.2rem', fontWeight: 400, color: 'var(--sidebar-text)', marginBottom: '0.85rem' }}>
              Library
            </p>
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
              <li key={doc.id} style={{ display: 'flex', alignItems: 'center' }}>
                <button
                  className={`sidebar-item${selected?.id === doc.id ? ' active' : ''}`}
                  onClick={() => handleSelect(doc)}
                >
                  <span style={{ fontSize: '0.75rem', opacity: 0.5, flexShrink: 0 }}>◻</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {doc.title}
                  </span>
                  {selected?.id === doc.id && (
                    <span style={{ fontSize: '0.7rem', opacity: 0.6, flexShrink: 0 }}>›</span>
                  )}
                </button>
                <button className="sidebar-delete-btn" onClick={() => handleDelete(doc)} title={`Remove ${doc.title}`}>
                  ×
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
        </nav>

        {/* Main content */}
        <main style={mainStyle}>
          {!selected ? (
            <div style={{ textAlign: 'center', paddingTop: '5rem', color: 'var(--ink-faint)' }}>
              <p style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>Select a work from the library</p>
              <p style={{ fontSize: '0.82rem' }}>or add one with + Add to Library</p>
            </div>
          ) : view === 'atlas-explorer' ? (
            <AtlasExplorer
              documentId={selected.id}
              sections={sections}
              onSelect={setInspectorTarget}
              onAtlasLoaded={handleAtlasLoaded}
              onCursorChange={setCursor}
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
              onAtlasChanged={() => selected && checkAtlas(selected.id)}
              onViewAtlas={() => { setView('atlas-explorer'); setInspectorTarget(null) }}
            />
          )}
        </main>

        {/* Inspector */}
        <aside style={S.inspector}>
          <h3 style={{ fontSize: '1.2rem', fontWeight: 400, color: 'var(--ink)', marginBottom: '0.35rem' }}>
            Inspector
          </h3>
          <div style={{ width: '40px', height: '1px', background: 'var(--gold)', marginBottom: '2rem' }} />
          <InspectorContent
            target={inspectorTarget}
            sectionTitles={sectionTitles}
            cursor={cursor}
            entityMentions={entityMentions}
            sectionOrder={sectionOrder}
          />
        </aside>
      </div>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer style={S.footer}>
        {view === 'atlas-explorer' ? (
          <button
            type="button"
            onClick={() => { setView('workflow'); setInspectorTarget(null) }}
            style={{ ...S.footerText, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gold)' }}
          >
            ← Workflow
          </button>
        ) : hasApprovedAtlas && selected ? (
          <button
            type="button"
            onClick={() => { setView('atlas-explorer'); setInspectorTarget(null) }}
            style={{ ...S.footerText, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gold)' }}
          >
            ◻ Atlas Explorer →
          </button>
        ) : (
          <span style={S.footerText}>◻ Atlas Explorer</span>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <span style={S.footerText}>
            {hasApprovedAtlas && selected ? '● Atlas ready' : '⊘ Available after atlas is approved'}
          </span>
          <button
            type="button"
            onClick={() => { setShowReset(true); setResetInput('') }}
            style={{ ...S.footerText, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--sidebar-muted)', opacity: 0.5 }}
          >
            Reset library
          </button>
        </div>
      </footer>

      {/* ── Reset confirmation overlay ───────────────────────────────── */}
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
