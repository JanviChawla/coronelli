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

// ── Droplet helpers ───────────────────────────────────────────────────────────

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

const DROPLET_VARIANTS = ['pink', 'blue', 'green', 'peach', 'amber', 'aqua'] as const
type Variant = typeof DROPLET_VARIANTS[number]

const DROPLET_GLOW: Record<Variant, string> = {
  pink:  'rgba(230, 140, 200, 0.6)',
  blue:  'rgba( 90, 140, 255, 0.6)',
  green: 'rgba( 60, 200, 175, 0.6)',
  peach: 'rgba(235, 155, 110, 0.6)',
  amber: 'rgba(235, 180,  75, 0.6)',
  aqua:  'rgba( 65, 200, 220, 0.6)',
}

function dropletVariant(id: string): Variant {
  return DROPLET_VARIANTS[hashStr(id) % DROPLET_VARIANTS.length]
}

// Bubble layout: cx/cy = center %, size in vh
const BUBBLE_LAYOUT = [
  { cx: '23%', cy: '47%', size: '60vh' },
  { cx: '56%', cy: '45%', size: '44vh' },
  { cx: '80%', cy: '44%', size: '31vh' },
  { cx: '95%', cy: '44%', size: '22vh' },
]

// Small decorative plain glass drops
const DECO = [
  { cx: '46%', cy: '70%', size: '5.5vh', dur: 3.6, delay: 0   },
  { cx: '63%', cy: '74%', size: '3.6vh', dur: 4.2, delay: 0.8 },
  { cx:  '9%', cy: '26%', size: '4.2vh', dur: 3.9, delay: 1.1 },
  { cx: '37%', cy: '16%', size: '3.0vh', dur: 4.8, delay: 0.4 },
  { cx: '67%', cy: '20%', size: '2.6vh', dur: 3.4, delay: 1.5 },
]

// ── Component ─────────────────────────────────────────────────────────────────

export function SourceLibrary() {
  const [documents, setDocuments]   = useState<Document[]>([])
  const [focused, setFocused]       = useState<Document | null>(null)
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
  const [confirmingBurnId, setConfirmingBurnId] = useState<string | null>(null)

  const fileRef      = useRef<HTMLInputElement>(null)
  const burnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { fetchDocuments().then(setDocuments).catch(() => {}) }, [])

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function handleOpenDoc(doc: Document) {
    setSelected(doc); setView('workflow'); setError(null); setSections([])
    try { setSections(await fetchSections(doc.id)) } catch { setError('Could not load sections.') }
  }

  function handleClickBubble(doc: Document) {
    setFocused(prev => prev?.id === doc.id ? null : doc)
  }

  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setImporting(true); setError(null)
    try {
      const result = await importDocument(file, 'demo')
      setDocuments(prev => [...prev, result.document])
      setFocused(result.document); setSelected(result.document)
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
      if (focused?.id === doc.id) setFocused(null)
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
      if (focused?.id === updated.id) setFocused(updated)
      setEditingDoc(null)
    } catch { setError('Could not update metadata.') }
    finally { setEditSaving(false) }
  }

  async function handleReset() {
    setResetting(true)
    try { await resetLibrary(); setDocuments([]); setSelected(null); setFocused(null); setError(null) }
    catch { setError('Reset failed.') }
    finally { setResetting(false); setShowReset(false); setResetInput('') }
  }

  function triggerBurn(doc: Document) {
    if (confirmingBurnId === doc.id) {
      if (burnTimerRef.current) clearTimeout(burnTimerRef.current)
      setConfirmingBurnId(null); handleDelete(doc)
    } else {
      if (burnTimerRef.current) clearTimeout(burnTimerRef.current)
      setConfirmingBurnId(doc.id)
      burnTimerRef.current = setTimeout(() => setConfirmingBurnId(null), 5000)
    }
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
          <div style={{ position: 'absolute', inset: 0, backgroundImage: "url('/bg/background.png')", backgroundSize: 'cover', backgroundPosition: 'center bottom' }} />

          {/* ── Header ──────────────────────────────────────────────────── */}
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.5rem 2rem', zIndex: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
              <span style={{ fontSize: '0.9rem', color: 'rgba(20,35,80,0.6)', lineHeight: 1 }}>✦</span>
              <div>
                <div style={{ fontSize: '1.5rem', color: 'rgba(12,22,60,0.9)', fontFamily: Cinzel, letterSpacing: '0.05em', fontWeight: 400, lineHeight: 1 }}>Coronelli</div>
                <div style={{ fontSize: '0.44rem', color: 'rgba(12,22,60,0.4)', letterSpacing: '0.22em', textTransform: 'uppercase', fontFamily: Mono, marginTop: '0.22rem' }}>Literary Atlases for Curious Minds</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '2rem' }}>
              {['Your worlds', 'Journal', 'Settings'].map((label, i) => (
                <button key={label} type="button"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', color: i === 0 ? 'rgba(12,22,60,0.88)' : 'rgba(12,22,60,0.42)', fontFamily: Cinzel, letterSpacing: '0.03em', padding: '0 0 4px', borderBottom: i === 0 ? '1px solid rgba(12,22,60,0.45)' : 'none' }}>
                  {label}
                </button>
              ))}
              <div style={{ width: '31px', height: '31px', borderRadius: '50%', border: '1.5px solid rgba(12,22,60,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'rgba(12,22,60,0.5)', fontSize: '0.85rem' }}>✦</div>
            </div>
          </div>

          {/* ── Decorative glass drops ────────────────────────────────────── */}
          {DECO.map((d, i) => (
            <div key={i} style={{
              position: 'absolute', left: d.cx, top: d.cy,
              width: d.size, height: d.size, borderRadius: '50%',
              background: 'rgba(255,255,255,0.16)',
              border: '1px solid rgba(255,255,255,0.62)',
              backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
              animation: `decoFloat ${d.dur}s ease-in-out ${d.delay}s infinite alternate`,
              boxShadow: '0 4px 16px rgba(160,185,235,0.22)',
              pointerEvents: 'none', zIndex: 2,
            }} />
          ))}

          {/* ── World bubbles ─────────────────────────────────────────────── */}
          {documents.slice(0, 4).map((doc, i) => {
            const layout   = BUBBLE_LAYOUT[i]!
            const variant  = dropletVariant(doc.id)
            const glow     = DROPLET_GLOW[variant]
            const isFocused = focused?.id === doc.id
            const h        = hashStr(doc.id)
            const floatDur   = 3.8 + (h % 10) * 0.28
            const floatDelay = (h % 20) * 0.14
            // text area is the upper-left clear zone of the droplet image
            const titleSize  = `calc(${layout.size} * 0.125)`
            const authorSize = `calc(${layout.size} * 0.052)`
            const badgeSize  = `calc(${layout.size} * 0.048)`
            const dotSize    = `calc(${layout.size} * 0.026)`

            return (
              <div
                key={doc.id}
                onClick={() => handleClickBubble(doc)}
                style={{
                  position: 'absolute',
                  left: layout.cx, top: layout.cy,
                  width: layout.size, height: layout.size,
                  // centering + float animation in one transform chain via wrapper
                  transform: 'translate(-50%, -50%)',
                  zIndex: isFocused ? 15 : 8 - i,
                  cursor: 'pointer',
                }}
              >
                {/* Float + glow wrapper */}
                <div style={{
                  width: '100%', height: '100%',
                  animation: `bubbleFloat ${floatDur}s ease-in-out ${floatDelay}s infinite alternate`,
                  filter: isFocused
                    ? `drop-shadow(0 0 38px ${glow}) drop-shadow(0 22px 55px rgba(80,100,180,0.28))`
                    : `drop-shadow(0 14px 42px rgba(80,100,180,0.18))`,
                  transition: 'filter 0.45s ease',
                  position: 'relative',
                }}>
                  {/* Droplet image */}
                  <img
                    src={`/bg/droplet-${variant}.png`}
                    alt=""
                    draggable={false}
                    style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', userSelect: 'none', pointerEvents: 'none' }}
                  />

                  {/* Text — placed in the clear upper zone of the droplet */}
                  <div style={{
                    position: 'absolute',
                    top: '10%', left: '9%', right: '28%',
                    pointerEvents: 'none',
                  }}>
                    <div style={{ fontSize: titleSize, fontFamily: Cinzel, color: '#0E1535', fontWeight: 400, lineHeight: 1.2 }}>
                      {doc.title}
                    </div>
                    {doc.author && (
                      <div style={{ fontSize: authorSize, letterSpacing: '0.13em', textTransform: 'uppercase', color: '#0E1535', opacity: 0.58, marginTop: '0.3em', fontFamily: Mono }}>
                        {doc.author}
                      </div>
                    )}
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.38em', marginTop: '0.55em', background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', borderRadius: '20px', padding: '0.18em 0.75em' }}>
                      <div style={{ width: dotSize, height: dotSize, minWidth: '5px', minHeight: '5px', maxWidth: '10px', maxHeight: '10px', borderRadius: '50%', background: '#D97706', flexShrink: 0 }} />
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

          {/* ── Bottom info panel ──────────────────────────────────────────── */}
          {focused && (
            <div style={{
              position: 'absolute', bottom: '4%', left: '50%', transform: 'translateX(-50%)',
              background: 'rgba(255,255,255,0.44)',
              backdropFilter: 'blur(26px)', WebkitBackdropFilter: 'blur(26px)',
              border: '1px solid rgba(255,255,255,0.74)',
              borderRadius: '18px',
              padding: '1.4rem 2rem',
              display: 'flex', alignItems: 'center', gap: '2.5rem',
              boxShadow: '0 8px 44px rgba(130,155,220,0.2)',
              zIndex: 20,
              minWidth: '420px', maxWidth: '620px',
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.52rem', color: 'rgba(12,22,60,0.38)', letterSpacing: '0.24em', textTransform: 'uppercase', fontFamily: Mono, marginBottom: '0.3rem' }}>Selected world</div>
                <div style={{ fontSize: '1.7rem', fontFamily: Cinzel, color: '#0E1535', fontWeight: 400, lineHeight: 1.15, marginBottom: '0.1rem' }}>{focused.title}</div>
                {focused.author && (
                  <div style={{ fontSize: '0.6rem', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(12,22,60,0.48)', fontFamily: Mono, marginBottom: '0.6rem' }}>{focused.author}</div>
                )}
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4em', background: 'rgba(255,255,255,0.6)', borderRadius: '20px', padding: '0.2em 0.8em' }}>
                  <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#D97706', flexShrink: 0 }} />
                  <span style={{ fontSize: '0.62rem', color: '#0E1535', fontFamily: Mono }}>Catalog · In progress</span>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem', flexShrink: 0 }}>
                <button type="button" onClick={() => handleOpenDoc(focused)}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(100,120,200,0.2)', border: '1px solid rgba(100,120,200,0.36)', borderRadius: '10px', padding: '0.65rem 1.4rem', color: '#0E1535', fontSize: '0.82rem', cursor: 'pointer', fontFamily: Cinzel, letterSpacing: '0.03em', whiteSpace: 'nowrap', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
                  Open Atlas Editor →
                </button>
                <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'center' }}>
                  <button type="button" onClick={() => openEdit(focused)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.64rem', color: 'rgba(12,22,60,0.36)', fontFamily: Mono, padding: '0.1rem 0.4rem' }}>
                    Edit
                  </button>
                  <button type="button" onClick={() => triggerBurn(focused)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.64rem', color: confirmingBurnId === focused.id ? '#c06060' : 'rgba(12,22,60,0.28)', fontFamily: Mono, padding: '0.1rem 0.4rem' }}>
                    {confirmingBurnId === focused.id ? 'Sure?' : 'Burn'}
                  </button>
                </div>
              </div>
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
