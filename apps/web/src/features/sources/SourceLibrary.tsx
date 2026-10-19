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

// ── Star background ───────────────────────────────────────────────────────────

function StarBackground() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current; if (!cv) return
    const ctx = cv.getContext('2d'); if (!ctx) return
    let raf: number
    interface Star { x: number; y: number; r: number; base: number; speed: number; phase: number; rgb: string }
    let stars: Star[] = []

    function resize() { cv.width = cv.offsetWidth; cv.height = cv.offsetHeight }

    function init() {
      stars = []
      const w = cv.width, h = cv.height
      const add = (n: number, rMin: number, rMax: number, base: number, speed: number, rgb: string) => {
        for (let i = 0; i < n; i++) stars.push({
          x: Math.random() * w, y: Math.random() * h,
          r: rMin + Math.random() * (rMax - rMin),
          base, speed: speed * (0.4 + Math.random() * 0.6),
          phase: Math.random() * Math.PI * 2, rgb,
        })
      }
      add(2000, 0.15, 0.7,  0.55, 0.018, '210,225,255')
      add(500,  0.4,  1.3,  0.40, 0.012, '255,230,170')
      add(280,  0.1,  0.4,  0.80, 0.030, '255,255,255')
    }

    let t = 0
    function draw() {
      ctx.clearRect(0, 0, cv.width, cv.height)
      t += 0.016
      for (const s of stars) {
        const op = s.base * (0.55 + 0.45 * Math.sin(t * s.speed * 60 + s.phase))
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${s.rgb},${op.toFixed(3)})`; ctx.fill()
      }
      raf = requestAnimationFrame(draw)
    }

    resize(); init(); draw()
    const ro = new ResizeObserver(() => { resize(); init() }); ro.observe(cv)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])
  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
}

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

  // ── Style constants ───────────────────────────────────────────────────────
  const Cinzel  = "'Cinzel', serif"
  const Mono    = "'Space Mono', monospace"
  const Crimson = "'Crimson Pro', Georgia, serif"
  const NSimSun = "'NSimSun', 'New SimSun', SimSun, serif"
  const BD      = 'rgba(184,148,58,.18)'
  const BD_HI   = 'rgba(184,148,58,.38)'
  const PANEL   = 'rgba(4,8,18,.88)'

  const inWorkflow = selected && (view === 'workflow' || view === 'edit-sections')

  // ── Shared input style ────────────────────────────────────────────────────
  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '0.5rem 0.75rem',
    fontSize: '0.82rem', border: `1px solid ${BD}`, borderRadius: '6px',
    background: 'rgba(184,148,58,.06)', color: '#C8BC9E', outline: 'none',
    fontFamily: Crimson,
  }

  // ── Modals ────────────────────────────────────────────────────────────────

  function editingDocOverlay() {
    if (!editingDoc) return null
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(3,8,18,.72)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
        <div style={{ background: PANEL, border: `1px solid ${BD_HI}`, borderRadius: '12px', padding: '2rem 2.25rem', width: '380px', maxWidth: '90vw', backdropFilter: 'blur(20px)' }}>
          <p style={{ fontFamily: NSimSun, fontSize: '1.1rem', color: '#D4B060', marginBottom: '1.5rem', letterSpacing: '0.03em' }}>Edit metadata</p>
          {[
            { label: 'Title',  value: editTitle,  set: setEditTitle,  type: 'text'   },
            { label: 'Author', value: editAuthor, set: setEditAuthor, type: 'text'   },
            { label: 'Year',   value: editYear,   set: setEditYear,   type: 'number' },
          ].map(({ label, value, set, type }) => (
            <div key={label} style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', fontFamily: Mono, fontSize: '0.6rem', color: '#6B6352', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '0.35rem' }}>{label}</label>
              <input type={type} value={value} onChange={e => set(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveEdit() }}
                style={inputStyle} />
            </div>
          ))}
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
            <button type="button" onClick={() => setEditingDoc(null)} disabled={editSaving}
              style={{ fontFamily: Mono, fontSize: '0.7rem', padding: '0.45rem 1rem', background: 'none', border: `1px solid ${BD}`, borderRadius: '6px', cursor: 'pointer', color: '#6B6352', letterSpacing: '0.06em' }}>Cancel</button>
            <button type="button" onClick={saveEdit} disabled={editSaving}
              style={{ fontFamily: Mono, fontSize: '0.7rem', padding: '0.45rem 1.2rem', background: 'rgba(184,148,58,.18)', border: `1px solid ${BD_HI}`, borderRadius: '6px', cursor: 'pointer', color: '#D4B060', letterSpacing: '0.06em', opacity: editSaving ? 0.6 : 1 }}>
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
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(3,8,18,.72)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
        <div style={{ background: PANEL, border: `1px solid ${BD_HI}`, borderRadius: '12px', padding: '2rem 2.25rem', width: '360px', maxWidth: '90vw' }}>
          <p style={{ fontFamily: NSimSun, fontSize: '1.1rem', color: '#D4B060', marginBottom: '0.5rem', letterSpacing: '0.03em' }}>Burn library?</p>
          <p style={{ fontFamily: Mono, fontSize: '0.7rem', color: '#6B6352', marginBottom: '1.5rem', lineHeight: 1.7 }}>Permanently deletes every document, section, candidate, and atlas entity. No undo.</p>
          <p style={{ fontFamily: Mono, fontSize: '0.65rem', color: '#6B6352', marginBottom: '0.5rem' }}>Type <span style={{ color: '#C8BC9E' }}>reset</span> to confirm:</p>
          <input type="text" value={resetInput} onChange={e => setResetInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && resetInput === 'reset') handleReset() }}
            placeholder="reset" autoFocus style={{ ...inputStyle, marginBottom: '1.5rem' }} />
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => { setShowReset(false); setResetInput('') }} disabled={resetting}
              style={{ fontFamily: Mono, fontSize: '0.7rem', padding: '0.45rem 1rem', background: 'none', border: `1px solid ${BD}`, borderRadius: '6px', cursor: 'pointer', color: '#6B6352', letterSpacing: '0.06em' }}>Cancel</button>
            <button type="button" onClick={handleReset} disabled={resetInput !== 'reset' || resetting}
              style={{ fontFamily: Mono, fontSize: '0.7rem', padding: '0.45rem 1rem', background: resetInput === 'reset' ? 'rgba(160,40,40,.45)' : 'rgba(184,148,58,.06)', border: `1px solid ${resetInput === 'reset' ? 'rgba(200,60,60,.5)' : BD}`, borderRadius: '6px', cursor: resetInput === 'reset' ? 'pointer' : 'not-allowed', color: resetInput === 'reset' ? '#E8A0A0' : '#6B6352', opacity: resetting ? 0.6 : 1, transition: 'all 0.15s', letterSpacing: '0.06em' }}>
              {resetting ? 'Burning…' : 'Burn everything'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#060C18', color: '#C8BC9E' }}>

      {/* ── Workflow ───────────────────────────────────────────────────────── */}
      {inWorkflow && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 30 }}>
          {view === 'edit-sections' ? (
            <div style={{ height: '100%', background: '#060C18', display: 'flex', flexDirection: 'column', padding: '3.5rem 4rem', overflowY: 'auto' }}>
              <button type="button" onClick={() => setView('workflow')}
                style={{ fontFamily: Mono, fontSize: '0.7rem', marginBottom: '1.25rem', color: '#6B6352', background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start', letterSpacing: '0.06em' }}>
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
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#010205' }}>

          {/* Star field */}
          <StarBackground />

          {/* Header */}
          <header style={{ position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: `1px solid ${BD}`, flexShrink: 0, background: 'rgba(1,2,5,0.72)', backdropFilter: 'blur(6px)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontFamily: Cinzel, fontSize: 17, fontWeight: 400, letterSpacing: '.22em', color: '#D4B060' }}>CORONELLI</span>
              <span style={{ fontFamily: Mono, fontSize: 8, color: '#6B6352', letterSpacing: '.10em', textTransform: 'uppercase', border: `1px solid ${BD}`, padding: '2px 6px', borderRadius: 2 }}>Literary Atlas</span>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: importing ? 'wait' : 'pointer', padding: '10px 22px', border: `1px solid ${BD_HI}`, borderRadius: 6, background: 'rgba(184,148,58,.12)', transition: 'background 0.18s' }}>
              <input ref={fileRef} type="file" accept=".txt,.md,.pdf" style={{ display: 'none' }} onChange={handleImportFile} disabled={importing} />
              <span style={{ fontFamily: Cinzel, fontSize: 13, color: '#D4B060', letterSpacing: '.14em' }}>{importing ? 'Importing…' : '+ New World'}</span>
            </label>
          </header>

          {/* Book grid */}
          <div style={{ position: 'relative', zIndex: 1, flex: 1, overflowY: 'auto', padding: '2.5rem 2.5rem 2rem', scrollbarWidth: 'thin', scrollbarColor: `${BD} transparent` }}>
            {documents.length === 0 && !importing ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '0.6rem' }}>
                <div style={{ fontFamily: NSimSun, fontSize: '1.4rem', color: '#7A6A4A', opacity: 0.65, letterSpacing: '0.04em' }}>No worlds yet</div>
                <div style={{ fontFamily: Mono, fontSize: '0.62rem', color: '#4A4030', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Upload a book to begin</div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.5rem' }}>
                {documents.map(doc => (
                  <div
                    key={doc.id}
                    onMouseEnter={() => setHoveredId(doc.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    style={{
                      background: hoveredId === doc.id ? 'rgba(10,18,34,.92)' : PANEL,
                      border: `1px solid ${hoveredId === doc.id ? BD_HI : BD}`,
                      borderRadius: 10, overflow: 'hidden',
                      display: 'flex', flexDirection: 'column',
                      backdropFilter: 'blur(8px)',
                      transition: 'background 0.2s, border-color 0.2s, box-shadow 0.2s',
                      boxShadow: hoveredId === doc.id
                        ? '0 6px 40px rgba(184,148,58,.14), 0 2px 16px rgba(0,0,0,.6)'
                        : '0 2px 20px rgba(0,0,0,.55)',
                    }}
                  >
                    {/* Gold accent stripe */}
                    <div style={{ height: 2, background: `linear-gradient(90deg, ${BD_HI}, rgba(184,148,58,.04))`, flexShrink: 0 }} />

                    {/* Book info */}
                    <div style={{ padding: '1.5rem 1.75rem 1.1rem', flex: 1 }}>
                      <div style={{ fontFamily: NSimSun, fontSize: '1.3rem', color: '#EAD89C', fontWeight: 400, lineHeight: 1.3, marginBottom: '0.55rem', letterSpacing: '0.02em' }}>
                        {doc.title}
                      </div>
                      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                        {doc.author && <span style={{ fontFamily: Crimson, fontStyle: 'italic', fontSize: '0.9rem', color: '#9A8060' }}>{doc.author}</span>}
                        {doc.year && <span style={{ fontFamily: Mono, fontSize: '0.6rem', color: '#5A5040', letterSpacing: '0.04em' }}>{doc.year}</span>}
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ padding: '0 1.75rem 1.5rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <button type="button" onClick={() => handleOpenDoc(doc)}
                        style={{ flex: '1 1 auto', fontFamily: Mono, fontSize: '0.62rem', letterSpacing: '.10em', textTransform: 'uppercase', padding: '0.55rem 0.75rem', background: 'rgba(184,148,58,.18)', border: `1px solid ${BD_HI}`, borderRadius: 5, color: '#D4B060', cursor: 'pointer', transition: 'background 0.15s' }}>
                        Open Atlas
                      </button>
                      <button type="button" onClick={() => openEdit(doc)}
                        style={{ fontFamily: Mono, fontSize: '0.62rem', letterSpacing: '.06em', textTransform: 'uppercase', padding: '0.55rem 0.75rem', background: 'none', border: `1px solid ${BD}`, borderRadius: 5, color: '#7A6A50', cursor: 'pointer' }}>
                        Edit Metadata
                      </button>
                      <button type="button" onClick={() => handleDelete(doc)}
                        style={{ fontFamily: Mono, fontSize: '0.62rem', letterSpacing: '.06em', textTransform: 'uppercase', padding: '0.55rem 0.75rem', background: 'none', border: '1px solid rgba(150,40,40,.28)', borderRadius: 5, color: 'rgba(190,75,75,.65)', cursor: 'pointer' }}>
                        Burn
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{ position: 'relative', zIndex: 2, padding: '0.75rem 2.5rem', borderTop: `1px solid ${BD}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, background: 'rgba(1,2,5,0.6)', backdropFilter: 'blur(4px)' }}>
            {error && <span style={{ fontFamily: Mono, fontSize: '0.65rem', color: '#C04040', letterSpacing: '0.04em' }}>{error}</span>}
            {!error && <span />}
            <button type="button" onClick={() => { setShowReset(true); setResetInput('') }}
              style={{ fontFamily: Mono, fontSize: '0.6rem', color: 'rgba(160,50,50,.55)', background: 'none', border: 'none', cursor: 'pointer', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              Burn library
            </button>
          </div>

          {/* Sections review modal */}
          {selected && view === 'sections-review' && (
            <div style={{ position: 'fixed', inset: '4vh 10vw', background: PANEL, border: `1px solid ${BD_HI}`, borderRadius: 12, backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', overflow: 'auto', zIndex: 50, padding: '2.5rem 3rem', boxShadow: '0 8px 60px rgba(0,0,0,.5)' }}>
              <button type="button" onClick={() => setSelected(null)}
                style={{ position: 'absolute', top: 18, right: 20, background: 'none', border: 'none', cursor: 'pointer', color: '#6B6352', fontSize: 20, lineHeight: 1, padding: '4px 6px' }}>×</button>
              <p style={{ fontFamily: Mono, fontSize: '0.6rem', color: '#6B6352', marginBottom: '2rem', letterSpacing: '0.08em' }}>
                Confirm metadata and sections before beginning the pipeline.
              </p>
              <div style={{ marginBottom: '1.75rem' }}>
                <h2 style={{ fontFamily: NSimSun, fontSize: '1.8rem', fontWeight: 400, color: '#EAD89C', marginBottom: '0.4rem', lineHeight: 1.2, letterSpacing: '0.02em' }}>{selected.title}</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  {selected.author && <span style={{ fontFamily: Crimson, fontStyle: 'italic', fontSize: '0.9rem', color: '#A89878' }}>{selected.author}</span>}
                  {selected.year && <span style={{ fontFamily: Mono, fontSize: '0.7rem', color: '#6B6352' }}>{selected.year}</span>}
                  <button type="button" onClick={() => openEdit(selected)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: Mono, fontSize: '0.62rem', color: '#6B6352', textDecoration: 'underline', textUnderlineOffset: 3 }}>Edit</button>
                </div>
              </div>
              <p style={{ fontFamily: Mono, fontSize: '0.58rem', color: '#6B6352', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
                {sections.length} section{sections.length !== 1 ? 's' : ''}
              </p>
              <div style={{ border: `1px solid ${BD}`, borderRadius: 6, overflow: 'hidden', marginBottom: '2rem' }}>
                {sections.length === 0
                  ? <div style={{ padding: '1rem 1.25rem', fontFamily: Mono, fontSize: '0.75rem', color: '#6B6352', fontStyle: 'italic' }}>Loading sections…</div>
                  : sections.map((s, i) => {
                      const preview = s.text.split('\n').filter(l => l.trim()).slice(0, 2).map(l => l.length > 120 ? l.slice(0, 120) + '…' : l).join(' ')
                      return (
                        <div key={s.id} style={{ padding: '0.65rem 1.25rem', borderBottom: i < sections.length - 1 ? `1px solid ${BD}` : 'none' }}>
                          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline', marginBottom: preview ? '0.2rem' : 0 }}>
                            <span style={{ fontFamily: Mono, fontSize: '0.55rem', color: '#6B6352', minWidth: '1.6rem', flexShrink: 0 }}>§{s.ordinal + 1}</span>
                            <span style={{ fontFamily: Crimson, fontSize: '0.92rem', color: '#C8BC9E' }}>{s.title || `Section ${s.ordinal + 1}`}</span>
                          </div>
                          {preview && <div style={{ paddingLeft: '2.35rem', fontFamily: Crimson, fontStyle: 'italic', fontSize: '0.75rem', color: '#6B6352', lineHeight: 1.5 }}>{preview}</div>}
                        </div>
                      )
                    })
                }
              </div>
              <button type="button" onClick={() => setView('workflow')}
                style={{ width: '100%', padding: '0.65rem', background: 'rgba(184,148,58,.12)', border: `1px solid ${BD_HI}`, borderRadius: 6, color: '#D4B060', fontFamily: Mono, fontSize: '0.7rem', cursor: 'pointer', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Begin pipeline →
              </button>
              {error && <p style={{ fontFamily: Mono, color: '#C04040', fontSize: '0.7rem', marginTop: '0.75rem' }}>{error}</p>}
            </div>
          )}

        </div>
      )}

      {editingDocOverlay()}
      {resetModal()}

    </div>
  )
}
