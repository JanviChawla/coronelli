import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { SectionEditor } from './SectionEditor'
import { SourceWorkflow } from './SourceWorkflow'
import {
  deleteDocument, fetchDocuments, fetchSections, importDocument,
  patchDocument, resetLibrary, updateSections,
  type Document, type Section, type SectionUpdate,
} from './sourceApi'

type View = 'workflow' | 'edit-sections' | 'sections-review'

// ── World bubble layout ───────────────────────────────────────────────────────

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

// Bubble layout: cx/cy = center %, size in vh
const BUBBLE_LAYOUT = [
  { cx: '20%', cy: '50%', size: '52vh' },
  { cx: '47%', cy: '48%', size: '38vh' },
  { cx: '70%', cy: '47%', size: '28vh' },
  { cx: '87%', cy: '47%', size: '20vh' },
]

// ── Component ─────────────────────────────────────────────────────────────────

export function SourceLibrary() {
  const [documents, setDocuments]   = useState<Document[]>([])
  const [hoveredId, setHoveredId]   = useState<string | null>(null)
  const [selected, setSelected]     = useState<Document | null>(null)
  const [sections, setSections]     = useState<Section[]>([])
  const [view, setView]             = useState<View>('workflow')
  const [error, setError]           = useState<string | null>(null)
  const [importing, setImporting]   = useState(false)
  const [showReset, setShowReset]   = useState(false)
  const [resetInput, setResetInput] = useState('')
  const [resetting, setResetting]   = useState(false)
  const [editingDoc, setEditingDoc] = useState<Document | null>(null)
  const [editTitle, setEditTitle]   = useState('')
  const [editAuthor, setEditAuthor] = useState('')
  const [editYear, setEditYear]     = useState('')
  const [editSaving, setEditSaving] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { fetchDocuments().then(setDocuments).catch(() => {}) }, [])

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function handleOpenDoc(doc: Document) {
    setSelected(doc); setView('workflow'); setError(null); setSections([])
    try { setSections(await fetchSections(doc.id)) } catch { setError('Could not load sections.') }
  }

  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setImporting(true); setError(null)
    try {
      const result = await importDocument(file, 'demo')
      setDocuments(prev => [...prev, result.document])
      setSelected(result.document)
      setSections(result.sections); setView('sections-review')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import failed.')
    } finally { setImporting(false); if (fileRef.current) fileRef.current.value = '' }
  }

  async function handleDelete(doc: Document) {
    try {
      await deleteDocument(doc.id)
      setDocuments(prev => prev.filter(d => d.id !== doc.id))
      if (selected?.id === doc.id) setSelected(null)
    } catch { setError('Could not delete document.') }
  }

  async function handleSave(updates: SectionUpdate[]) {
    if (!selected) return
    try { const u = await updateSections(selected.id, updates); setSections(u); setView('workflow') }
    catch { setError('Could not save sections.') }
  }

  function openEdit(doc: Document) {
    setEditingDoc(doc); setEditTitle(doc.title)
    setEditAuthor(doc.author ?? ''); setEditYear(doc.year ? String(doc.year) : '')
  }

  async function saveEdit() {
    if (!editingDoc) return; setEditSaving(true)
    try {
      const updated = await patchDocument(editingDoc.id, {
        title: editTitle.trim() || editingDoc.title,
        author: editAuthor.trim() || undefined,
        year: editYear.trim() ? parseInt(editYear, 10) : undefined,
      })
      setDocuments(prev => prev.map(d => d.id === updated.id ? updated : d))
      if (selected?.id === updated.id) setSelected(updated)
      setEditingDoc(null)
    } catch { setError('Could not update metadata.') }
    finally { setEditSaving(false) }
  }

  async function handleReset() {
    setResetting(true)
    try { await resetLibrary(); setDocuments([]); setSelected(null); setError(null) }
    catch { setError('Reset failed.') }
    finally { setResetting(false); setShowReset(false); setResetInput('') }
  }

  // ── Font shorthands ───────────────────────────────────────────────────────
  const Cinzel = "'Cinzel', serif"
  const Mono   = "'Space Mono', monospace"
  const inWorkflow = selected && (view === 'workflow' || view === 'edit-sections')

  // ── Modals ────────────────────────────────────────────────────────────────

  function editingDocOverlay() {
    if (!editingDoc) return null
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(200,215,240,0.45)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
        <div style={{ background: 'rgba(248,250,255,0.97)', border: '1px solid rgba(180,200,235,0.5)', borderRadius: '14px', padding: '2rem 2.25rem', width: '380px', maxWidth: '90vw' }}>
          <p style={{ fontSize: '1rem', fontWeight: 400, color: '#0F1937', marginBottom: '1.25rem', fontFamily: Cinzel }}>Edit metadata</p>
          {[
            { label: 'Title',  value: editTitle,  set: setEditTitle,  type: 'text'   },
            { label: 'Author', value: editAuthor, set: setEditAuthor, type: 'text'   },
            { label: 'Year',   value: editYear,   set: setEditYear,   type: 'number' },
          ].map(({ label, value, set, type }) => (
            <div key={label} style={{ marginBottom: '0.9rem' }}>
              <label style={{ display: 'block', fontSize: '0.65rem', color: 'rgba(15,25,55,0.45)', marginBottom: '0.25rem', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: Mono }}>{label}</label>
              <input type={type} value={value} onChange={e => set(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveEdit() }}
                style={{ width: '100%', boxSizing: 'border-box', padding: '0.5rem 0.75rem', fontSize: '0.85rem', border: '1px solid rgba(15,25,55,0.15)', borderRadius: '7px', background: 'rgba(255,255,255,0.85)', color: '#0F1937', outline: 'none' }} />
            </div>
          ))}
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
            <button type="button" onClick={() => setEditingDoc(null)} disabled={editSaving}
              style={{ fontSize: '0.8rem', padding: '0.45rem 1rem', background: 'none', border: '1px solid rgba(15,25,55,0.18)', borderRadius: '7px', cursor: 'pointer', color: 'rgba(15,25,55,0.5)' }}>Cancel</button>
            <button type="button" onClick={saveEdit} disabled={editSaving}
              style={{ fontSize: '0.8rem', padding: '0.45rem 1.1rem', background: 'rgba(60,90,185,0.85)', border: 'none', borderRadius: '7px', cursor: 'pointer', color: '#fff', fontWeight: 600, opacity: editSaving ? 0.6 : 1 }}>
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
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(200,215,240,0.45)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
        <div style={{ background: 'rgba(248,250,255,0.97)', border: '1px solid rgba(180,200,235,0.5)', borderRadius: '14px', padding: '2rem 2.25rem', width: '360px', maxWidth: '90vw' }}>
          <p style={{ fontSize: '1rem', color: '#0F1937', marginBottom: '0.4rem', fontFamily: Cinzel }}>Reset the library?</p>
          <p style={{ fontSize: '0.78rem', color: 'rgba(15,25,55,0.5)', marginBottom: '1.5rem', lineHeight: 1.6, fontFamily: Mono }}>Permanently deletes every document, section, candidate, and atlas entity. No undo.</p>
          <p style={{ fontSize: '0.72rem', color: 'rgba(15,25,55,0.45)', marginBottom: '0.5rem', fontFamily: Mono }}>Type <strong style={{ color: 'rgba(15,25,55,0.75)' }}>reset</strong> to confirm:</p>
          <input type="text" value={resetInput} onChange={e => setResetInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && resetInput === 'reset') handleReset() }}
            placeholder="reset" autoFocus
            style={{ width: '100%', boxSizing: 'border-box', padding: '0.5rem 0.75rem', fontSize: '0.85rem', border: '1px solid rgba(15,25,55,0.15)', borderRadius: '7px', background: 'rgba(255,255,255,0.85)', color: '#0F1937', marginBottom: '1.25rem', outline: 'none' }} />
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => { setShowReset(false); setResetInput('') }} disabled={resetting}
              style={{ fontSize: '0.8rem', padding: '0.45rem 1rem', background: 'none', border: '1px solid rgba(15,25,55,0.15)', borderRadius: '7px', cursor: 'pointer', color: 'rgba(15,25,55,0.5)' }}>Cancel</button>
            <button type="button" onClick={handleReset} disabled={resetInput !== 'reset' || resetting}
              style={{ fontSize: '0.8rem', padding: '0.45rem 1rem', background: resetInput === 'reset' ? 'rgba(180,40,40,0.85)' : 'rgba(15,25,55,0.08)', border: 'none', borderRadius: '7px', cursor: resetInput === 'reset' ? 'pointer' : 'not-allowed', color: resetInput === 'reset' ? '#fff' : 'rgba(15,25,55,0.25)', opacity: resetting ? 0.6 : 1, transition: 'background 0.15s' }}>
              {resetting ? 'Resetting…' : 'Reset everything'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>

      {/* ── Workflow ───────────────────────────────────────────────────────── */}
      {inWorkflow && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 30 }}>
          {view === 'edit-sections' ? (
            <div style={{ height: '100%', background: 'var(--parchment)', display: 'flex', flexDirection: 'column', padding: '3.5rem 4rem', overflowY: 'auto' }}>
              <button type="button" onClick={() => setView('workflow')}
                style={{ fontSize: '0.8rem', marginBottom: '1.25rem', color: 'var(--ink-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}>
                ← Back to workflow
              </button>
              <SectionEditor documentId={selected!.id} sections={sections} onSave={handleSave} />
            </div>
          ) : (
            <SourceWorkflow
              document={selected!} sections={sections}
              onBack={() => setSelected(null)}
              onEditSections={() => setView('edit-sections')}
              onEdit={() => openEdit(selected!)}
              onDelete={() => { handleDelete(selected!); setSelected(null) }}
            />
          )}
        </div>
      )}

      {/* ── Home page ──────────────────────────────────────────────────────── */}
      {!inWorkflow && (
        <div style={{ position: 'absolute', inset: 0 }}>

          <style>{`
            @keyframes bubbleFloat {
              from { transform: translateY(0px);   }
              to   { transform: translateY(-18px); }
            }
            @keyframes decoFloat {
              from { transform: translate(-50%,-50%) translateY(0px);   }
              to   { transform: translate(-50%,-50%) translateY(-10px); }
            }
          `}</style>

          {/* Background */}
          <div style={{ position: 'absolute', inset: 0, backgroundImage: "url('/bg/background2.png')", backgroundSize: 'cover', backgroundPosition: 'center bottom' }} />

          {/* ── Header ──────────────────────────────────────────────────── */}
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.5rem 2rem', zIndex: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
              <span style={{ fontSize: '0.9rem', color: 'rgba(20,35,80,0.6)', lineHeight: 1 }}>✦</span>
              <div>
                <div style={{ fontSize: '1.5rem', color: 'rgba(12,22,60,0.9)', fontFamily: Cinzel, letterSpacing: '0.05em', fontWeight: 400, lineHeight: 1 }}>Coronelli</div>
                <div style={{ fontSize: '0.44rem', color: 'rgba(12,22,60,0.4)', letterSpacing: '0.22em', textTransform: 'uppercase', fontFamily: Mono, marginTop: '0.22rem' }}>Literary Atlases for Curious Minds</div>
              </div>
            </div>
            <div />
          </div>

          {/* ── World bubbles ─────────────────────────────────────────────── */}
          {documents.slice(0, 4).map((doc, i) => {
            const layout    = BUBBLE_LAYOUT[i]!
            const isHovered = hoveredId === doc.id
            const h         = hashStr(doc.id)
            const floatDur  = 3.8 + (h % 10) * 0.28
            const floatDelay = (h % 20) * 0.14
            const titleSize = `calc(${layout.size} * 0.068)`
            const authorSize = `calc(${layout.size} * 0.046)`
            const badgeSize = `calc(${layout.size} * 0.040)`

            return (
              <div
                key={doc.id}
                onClick={() => handleOpenDoc(doc)}
                onMouseEnter={() => setHoveredId(doc.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  position: 'absolute',
                  left: layout.cx, top: layout.cy,
                  width: layout.size, height: layout.size,
                  transform: `translate(-50%, -50%) scale(${isHovered ? 1.07 : 1})`,
                  transition: 'transform 0.55s cubic-bezier(0.34, 1.56, 0.64, 1)',
                  zIndex: isHovered ? 15 : 8 - i,
                  cursor: 'pointer',
                }}
              >
                {/* Float wrapper */}
                <div style={{
                  width: '100%', height: '100%',
                  animation: `bubbleFloat ${floatDur}s ease-in-out ${floatDelay}s infinite alternate`,
                  position: 'relative',
                }}>
                  {/* Glass circle */}
                  <div style={{
                    position: 'absolute', inset: 0, borderRadius: '50%',
                    background: isHovered ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.18)',
                    backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
                    border: `1.5px solid ${isHovered ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.48)'}`,
                    boxShadow: isHovered
                      ? '0 20px 60px rgba(80,100,180,0.28), inset 0 1px 0 rgba(255,255,255,0.5)'
                      : '0 10px 40px rgba(80,100,180,0.14), inset 0 1px 0 rgba(255,255,255,0.35)',
                    transition: 'background 0.35s, border-color 0.35s, box-shadow 0.35s',
                  }} />

                  {/* Text — centered */}
                  <div style={{
                    position: 'absolute', inset: 0,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    padding: '12%', textAlign: 'center', pointerEvents: 'none',
                  }}>
                    <div style={{ fontSize: titleSize, fontFamily: Cinzel, color: '#0E1535', fontWeight: 400, lineHeight: 1.2 }}>
                      {doc.title}
                    </div>
                    {doc.author && (
                      <div style={{ fontSize: authorSize, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#0E1535', opacity: 0.5, marginTop: '0.4em', fontFamily: Mono }}>
                        {doc.author}
                      </div>
                    )}
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3em', marginTop: '0.6em', background: 'rgba(255,255,255,0.55)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', borderRadius: '20px', padding: '0.12em 0.55em' }}>
                      <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#D97706', flexShrink: 0 }} />
                      <span style={{ fontSize: badgeSize, color: '#0E1535', fontFamily: Mono, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>In progress</span>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}

          {/* ── Empty state ────────────────────────────────────────────────── */}
          {documents.length === 0 && !importing && (
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none', zIndex: 5 }}>
              <div style={{ fontSize: '0.78rem', color: 'rgba(12,22,60,0.35)', letterSpacing: '0.14em', fontFamily: Mono }}>No worlds yet — add one →</div>
            </div>
          )}

          {/* ── New world bubble ───────────────────────────────────────────── */}
          <label style={{
            position: 'absolute', bottom: '8%', right: '4%',
            width: '13vh', height: '13vh', minWidth: '90px', minHeight: '90px',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.22)',
            backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
            border: '1.5px solid rgba(255,255,255,0.68)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.12rem',
            cursor: importing ? 'wait' : 'pointer',
            boxShadow: '0 8px 30px rgba(140,165,225,0.18)',
            animation: 'decoFloat 4.6s ease-in-out 0.3s infinite alternate',
            zIndex: 15,
          }}>
            <input ref={fileRef} type="file" accept=".txt,.md,.pdf" style={{ display: 'none' }} onChange={handleImportFile} disabled={importing} />
            <div style={{ fontSize: '1.55rem', color: 'rgba(12,22,60,0.48)', lineHeight: 1, fontWeight: 300 }}>{importing ? '…' : '+'}</div>
            <div style={{ fontSize: '0.58rem', color: 'rgba(12,22,60,0.46)', fontFamily: Cinzel, letterSpacing: '0.04em', textAlign: 'center' }}>New world</div>
          </label>

          {/* ── Burn library ────────────────────────────────────────────────── */}
          <button type="button" onClick={() => { setShowReset(true); setResetInput('') }}
            style={{ position: 'absolute', bottom: '2rem', left: '2rem', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: '0.45rem', zIndex: 15 }}>
            <div style={{ fontSize: '1rem', lineHeight: 1.3 }}>🔥</div>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: '0.7rem', color: 'rgba(190,55,35,0.8)', fontFamily: Cinzel, letterSpacing: '0.04em' }}>Burn library</div>
              <div style={{ fontSize: '0.46rem', color: 'rgba(190,55,35,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: Mono }}>Erase all worlds and their data</div>
            </div>
          </button>

          {error && (
            <div style={{ position: 'absolute', top: '5rem', left: '50%', transform: 'translateX(-50%)', color: '#b04040', fontSize: '0.75rem', background: 'rgba(255,255,255,0.9)', padding: '0.4rem 1rem', borderRadius: '6px', fontFamily: Mono, zIndex: 25 }}>{error}</div>
          )}

          {/* ── Sections review modal ─────────────────────────────────────── */}
          {selected && view === 'sections-review' && (
            <div style={{ position: 'fixed', inset: '4vh 10vw', background: 'rgba(242,246,255,0.97)', border: '1px solid rgba(175,200,235,0.45)', borderRadius: '14px', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', overflow: 'auto', zIndex: 50, padding: '3rem 3rem 2.5rem', boxShadow: '0 8px 60px rgba(100,125,210,0.18)' }}>
              <p style={{ fontSize: '0.63rem', color: 'rgba(12,22,60,0.38)', marginBottom: '2rem', fontStyle: 'italic', fontFamily: Mono, letterSpacing: '0.06em' }}>
                Confirm metadata and sections before beginning the pipeline.
              </p>
              <div style={{ marginBottom: '1.75rem' }}>
                <h2 style={{ fontSize: '1.8rem', fontWeight: 400, color: '#0E1535', marginBottom: '0.3rem', lineHeight: 1.2, fontFamily: Cinzel }}>{selected.title}</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  {selected.author && <span style={{ fontSize: '0.82rem', color: 'rgba(12,22,60,0.52)', fontFamily: Mono }}>{selected.author}</span>}
                  {selected.year && <span style={{ fontSize: '0.75rem', color: 'rgba(12,22,60,0.35)', fontFamily: Mono }}>{selected.year}</span>}
                  <button type="button" onClick={() => openEdit(selected)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '0.68rem', color: 'rgba(12,22,60,0.38)', textDecoration: 'underline', textUnderlineOffset: '3px', fontFamily: Mono }}>✎ Edit</button>
                </div>
              </div>
              <p style={{ fontSize: '0.58rem', color: 'rgba(12,22,60,0.38)', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.5rem', fontFamily: Mono }}>
                {sections.length} section{sections.length !== 1 ? 's' : ''}
              </p>
              <div style={{ border: '1px solid rgba(12,22,60,0.1)', borderRadius: '8px', overflow: 'hidden', marginBottom: '2rem' }}>
                {sections.length === 0
                  ? <div style={{ padding: '1rem 1.1rem', fontSize: '0.82rem', color: 'rgba(12,22,60,0.3)', fontStyle: 'italic', fontFamily: Mono }}>Loading sections…</div>
                  : sections.map((s, i) => {
                      const lines = s.text.split('\n').filter(l => l.trim())
                      const preview = lines.slice(0, 2).map(l => l.length > 120 ? l.slice(0, 120) + '…' : l).join(' ')
                      return (
                        <div key={s.id} style={{ padding: '0.6rem 1.1rem', borderBottom: i < sections.length - 1 ? '1px solid rgba(12,22,60,0.07)' : 'none' }}>
                          <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'baseline', marginBottom: preview ? '0.15rem' : 0 }}>
                            <span style={{ fontSize: '0.55rem', color: 'rgba(12,22,60,0.4)', minWidth: '1.6rem', fontFamily: Mono, flexShrink: 0 }}>§{s.ordinal + 1}</span>
                            <span style={{ fontSize: '0.85rem', color: 'rgba(12,22,60,0.8)', fontWeight: 500, fontFamily: Cinzel }}>{s.title || `Section ${s.ordinal + 1}`}</span>
                          </div>
                          {preview && <div style={{ paddingLeft: '2.3rem', fontSize: '0.72rem', color: 'rgba(12,22,60,0.3)', fontStyle: 'italic', lineHeight: 1.45, fontFamily: Mono }}>{preview}</div>}
                        </div>
                      )
                    })
                }
              </div>
              <button type="button" onClick={() => setView('workflow')}
                style={{ width: '100%', padding: '0.65rem', background: 'rgba(100,120,195,0.15)', border: '1px solid rgba(100,120,195,0.32)', borderRadius: '8px', color: '#0E1535', fontSize: '0.8rem', cursor: 'pointer', letterSpacing: '0.1em', fontFamily: Mono }}>
                Begin pipeline →
              </button>
              {error && <p style={{ color: '#b04040', fontSize: '0.75rem', marginTop: '0.75rem', fontFamily: Mono }}>{error}</p>}
            </div>
          )}

        </div>
      )}

      {editingDocOverlay()}
      {resetModal()}

    </div>
  )
}
