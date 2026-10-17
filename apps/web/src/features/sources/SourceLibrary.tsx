import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { SectionEditor } from './SectionEditor'
import { SourceWorkflow } from './SourceWorkflow'
import {
  deleteDocument, fetchDocuments, fetchSections, importDocument,
  patchDocument, resetLibrary, updateSections,
  type Document, type Section, type SectionUpdate,
} from './sourceApi'

type View = 'workflow' | 'edit-sections' | 'sections-review'

// ── Canvas / layout helpers ───────────────────────────────────────────────────

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

const PALETTES = [
  ['#FF9DE2', '#C4B5FD', '#93C5FD', '#6EE7B7'],
  ['#FDE68A', '#FCA5A5', '#C4B5FD', '#93C5FD'],
  ['#6EE7B7', '#67E8F9', '#A78BFA', '#F9A8D4'],
  ['#FDE68A', '#FB923C', '#F472B6', '#A78BFA'],
  ['#86EFAC', '#67E8F9', '#FDE68A', '#A78BFA'],
  ['#F9A8D4', '#FBBF24', '#A78BFA', '#93C5FD'],
]

function bubblePalette(id: string): string[] { return PALETTES[hashStr(id) % PALETTES.length] }

function blobRadius(id: string): string {
  const h = hashStr(id)
  const v = (sh: number) => 40 + ((h >> sh) & 0x1F) % 28
  const a = v(0), b = v(5), c = v(10), d = v(15)
  return `${a}% ${100-a}% ${b}% ${100-b}% / ${c}% ${d}% ${100-d}% ${100-c}%`
}

function hexRgba(hex: string, a: number): string {
  const r = parseInt(hex.slice(1,3), 16)
  const g = parseInt(hex.slice(3,5), 16)
  const b = parseInt(hex.slice(5,7), 16)
  return `rgba(${r},${g},${b},${a})`
}

function drawBubble(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  pal: string[], t: number, seed: number,
): void {
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2
  const rng = (n: number) => { const x = Math.sin(n * 9301 + seed * 49297) * 10000; return x - Math.floor(x) }

  ctx.clearRect(0, 0, w, h)

  // Base radial gradient
  const bg = ctx.createRadialGradient(cx * 0.75, cy * 0.8, 0, cx, cy, r * 1.1)
  bg.addColorStop(0, hexRgba(pal[0], 0.72))
  bg.addColorStop(0.3, hexRgba(pal[1], 0.45))
  bg.addColorStop(0.65, hexRgba(pal[2], 0.22))
  bg.addColorStop(1, 'rgba(3,1,18,0.95)')
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h)

  // Secondary offset glow for depth
  const bg2 = ctx.createRadialGradient(cx * 1.3, cy * 0.45, 0, cx * 1.15, cy * 0.55, r * 0.65)
  bg2.addColorStop(0, hexRgba(pal[3] ?? pal[0], 0.32))
  bg2.addColorStop(1, 'transparent')
  ctx.fillStyle = bg2; ctx.fillRect(0, 0, w, h)

  // Swirling ribbons
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (let s = 0; s < 8; s++) {
    const col = pal[s % pal.length]
    const phase = rng(s * 11) * Math.PI * 2
    const speed = 0.07 + s * 0.013
    ctx.strokeStyle = hexRgba(col, 0.16 + rng(s) * 0.18)
    ctx.lineWidth = 1.0 + rng(s * 3) * 2.6
    ctx.shadowBlur = 10 + rng(s * 7) * 16
    ctx.shadowColor = col
    ctx.beginPath()
    for (let i = 0; i <= 110; i++) {
      const p = i / 110
      const angle = p * Math.PI * (3 + rng(s * 5) * 2.5) + phase + t * speed
      const wobble = Math.sin(p * Math.PI * 4 + t * 0.35 + s) * r * 0.07
      const sr = p * r * (0.72 + rng(s * 9) * 0.18) + wobble
      const x = cx + Math.cos(angle) * sr
      const y = cy + Math.sin(angle) * sr * (0.5 + rng(s * 13) * 0.35)
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.restore()

  // Sparkles
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < 100; i++) {
    const sr = (0.05 + rng(i * 3.3) * 0.8) * r
    const sa = rng(i * 7.1) * Math.PI * 2 + t * 0.022 * (i % 5 - 2)
    const sx = cx + Math.cos(sa) * sr
    const sy = cy + Math.sin(sa) * sr * 0.8
    const sz = 0.3 + rng(i * 2.7) * 2.1
    const twinkle = Math.max(0, Math.sin(t * (1.2 + rng(i) * 2) + i * 2.1))
    ctx.globalAlpha = twinkle * 0.9
    ctx.fillStyle = i % 8 === 0 ? '#FFFFFF' : pal[i % pal.length]
    ctx.shadowBlur = 4; ctx.shadowColor = '#FFFFFF'
    ctx.beginPath(); ctx.arc(sx, sy, sz, 0, Math.PI * 2); ctx.fill()
  }
  ctx.restore()
  ctx.globalAlpha = 1; ctx.shadowBlur = 0
}

// Bubble positions (cx/cy = center as %, size in vh)
const BUBBLE_LAYOUT = [
  { cx: '21%',  cy: '46%', size: '52vh' },
  { cx: '53%',  cy: '44%', size: '38vh' },
  { cx: '78%',  cy: '45%', size: '27vh' },
  { cx: '93%',  cy: '44%', size: '20vh' },
]

const DECO = [
  { cx: '47%', cy: '68%', size: '5.5vh', dur: 3.6, delay: 0 },
  { cx: '63%', cy: '73%', size: '3.8vh', dur: 4.2, delay: 0.8 },
  { cx: '9%',  cy: '27%', size: '4.4vh', dur: 3.9, delay: 1.1 },
  { cx: '37%', cy: '17%', size: '3.2vh', dur: 4.8, delay: 0.4 },
  { cx: '67%', cy: '21%', size: '2.8vh', dur: 3.4, delay: 1.5 },
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

  const fileRef       = useRef<HTMLInputElement>(null)
  const burnTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canvasMapRef  = useRef<Map<string, HTMLCanvasElement>>(new Map())
  const animFrameRef  = useRef<number>(0)

  useEffect(() => { fetchDocuments().then(setDocuments).catch(() => {}) }, [])

  // Animation loop
  useEffect(() => {
    let t = 0
    const loop = () => {
      t += 0.005
      for (const [docId, canvas] of canvasMapRef.current) {
        const ctx = canvas.getContext('2d')
        if (!ctx || !canvas.width || !canvas.height) continue
        drawBubble(ctx, canvas.width, canvas.height, bubblePalette(docId), t, hashStr(docId))
      }
      animFrameRef.current = requestAnimationFrame(loop)
    }
    animFrameRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [])

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
    try { const updated = await updateSections(selected.id, updates); setSections(updated); setView('workflow') }
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

  const setCanvasRef = useCallback((docId: string) => (el: HTMLCanvasElement | null) => {
    if (el) {
      canvasMapRef.current.set(docId, el)
      const parent = el.parentElement
      if (parent) {
        const sync = () => { el.width = parent.clientWidth || 300; el.height = parent.clientHeight || 300 }
        sync()
        const ro = new ResizeObserver(sync)
        ro.observe(parent)
        ;(el as HTMLCanvasElement & { _ro?: ResizeObserver })._ro = ro
      }
    } else {
      const prev = canvasMapRef.current.get(docId) as (HTMLCanvasElement & { _ro?: ResizeObserver }) | undefined
      prev?._ro?.disconnect()
      canvasMapRef.current.delete(docId)
    }
  }, [])

  // ── Font shorthands ───────────────────────────────────────────────────────
  const Cinzel = "'Cinzel', serif"
  const Mono   = "'Space Mono', monospace"
  const inWorkflow = selected && (view === 'workflow' || view === 'edit-sections')

  // ── Modals ────────────────────────────────────────────────────────────────

  function editingDocOverlay() {
    if (!editingDoc) return null
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(200,215,240,0.45)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
        <div style={{ background: 'rgba(248,250,255,0.96)', border: '1px solid rgba(180,200,235,0.55)', borderRadius: '14px', padding: '2rem 2.25rem', width: '380px', maxWidth: '90vw' }}>
          <p style={{ fontSize: '1rem', fontWeight: 400, color: '#0F1937', marginBottom: '1.25rem', fontFamily: Cinzel }}>Edit metadata</p>
          {[
            { label: 'Title', value: editTitle, set: setEditTitle, type: 'text' },
            { label: 'Author', value: editAuthor, set: setEditAuthor, type: 'text' },
            { label: 'Year', value: editYear, set: setEditYear, type: 'number' },
          ].map(({ label, value, set, type }) => (
            <div key={label} style={{ marginBottom: '0.9rem' }}>
              <label style={{ display: 'block', fontSize: '0.65rem', color: 'rgba(15,25,55,0.45)', marginBottom: '0.25rem', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: Mono }}>{label}</label>
              <input type={type} value={value} onChange={e => set(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveEdit() }}
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
        <div style={{ background: 'rgba(248,250,255,0.96)', border: '1px solid rgba(180,200,235,0.55)', borderRadius: '14px', padding: '2rem 2.25rem', width: '360px', maxWidth: '90vw' }}>
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

      {/* ── Workflow view ────────────────────────────────────────────────── */}
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

      {/* ── Home page ────────────────────────────────────────────────────── */}
      {!inWorkflow && (
        <div style={{ position: 'absolute', inset: 0, background: '#cdd6e8' }}>

          {/* CSS keyframes */}
          <style>{`
            @keyframes bubbleFloat {
              from { transform: translateY(0px); }
              to   { transform: translateY(-16px); }
            }
            @keyframes decoFloat {
              from { transform: translate(-50%, -50%) translateY(0px); }
              to   { transform: translate(-50%, -50%) translateY(-9px); }
            }
          `}</style>

          {/* Background image */}
          <div style={{ position: 'absolute', inset: 0, backgroundImage: "url('/bg/background.png')", backgroundSize: 'cover', backgroundPosition: 'center bottom', opacity: 0.92 }} />

          {/* Header */}
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.5rem 2rem', zIndex: 20, pointerEvents: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', pointerEvents: 'auto' }}>
              <span style={{ fontSize: '1rem', color: 'rgba(20,35,80,0.65)', lineHeight: 1 }}>✦</span>
              <div>
                <div style={{ fontSize: '1.5rem', color: 'rgba(12,22,60,0.88)', fontFamily: Cinzel, letterSpacing: '0.05em', fontWeight: 400, lineHeight: 1 }}>Coronelli</div>
                <div style={{ fontSize: '0.44rem', color: 'rgba(12,22,60,0.42)', letterSpacing: '0.22em', textTransform: 'uppercase', fontFamily: Mono, marginTop: '0.22rem' }}>Literary Atlases for Curious Minds</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '2rem', pointerEvents: 'auto' }}>
              {['Your worlds', 'Journal', 'Settings'].map((label, i) => (
                <button key={label} type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', color: i === 0 ? 'rgba(12,22,60,0.88)' : 'rgba(12,22,60,0.45)', fontFamily: Cinzel, letterSpacing: '0.03em', padding: '0 0 4px', position: 'relative', borderBottom: i === 0 ? '1px solid rgba(12,22,60,0.5)' : 'none' }}>
                  {label}
                </button>
              ))}
              <div style={{ width: '31px', height: '31px', borderRadius: '50%', border: '1.5px solid rgba(12,22,60,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'rgba(12,22,60,0.55)', fontSize: '0.9rem' }}>✦</div>
            </div>
          </div>

          {/* Small decorative bubbles */}
          {DECO.map((d, i) => (
            <div key={i} style={{
              position: 'absolute', left: d.cx, top: d.cy,
              width: d.size, height: d.size,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.18)',
              border: '1px solid rgba(255,255,255,0.65)',
              backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
              animation: `decoFloat ${d.dur}s ease-in-out ${d.delay}s infinite alternate`,
              boxShadow: '0 4px 18px rgba(180,200,240,0.25)',
              pointerEvents: 'none',
              zIndex: 2,
            }} />
          ))}

          {/* World bubbles */}
          {documents.slice(0, 4).map((doc, i) => {
            const layout = BUBBLE_LAYOUT[i]!
            const pal = bubblePalette(doc.id)
            const isFocused = focused?.id === doc.id
            const h = hashStr(doc.id)
            const floatDur = 3.8 + (h % 10) * 0.28
            const floatDelay = (h % 20) * 0.14

            return (
              <div
                key={doc.id}
                onClick={() => handleClickBubble(doc)}
                style={{
                  position: 'absolute',
                  left: layout.cx, top: layout.cy,
                  width: layout.size, height: layout.size,
                  transform: 'translate(-50%, -50%)',
                  zIndex: isFocused ? 15 : 8 - i,
                  filter: isFocused
                    ? `drop-shadow(0 0 38px ${hexRgba(pal[0], 0.55)}) drop-shadow(0 22px 55px rgba(80,100,180,0.3))`
                    : 'drop-shadow(0 14px 38px rgba(80,100,180,0.18))',
                  cursor: 'pointer',
                  transition: 'filter 0.4s ease',
                }}
              >
                {/* Animated inner blob */}
                <div style={{
                  width: '100%', height: '100%',
                  borderRadius: blobRadius(doc.id),
                  overflow: 'hidden',
                  position: 'relative',
                  animation: `bubbleFloat ${floatDur}s ease-in-out ${floatDelay}s infinite alternate`,
                }}>
                  {/* Galaxy canvas */}
                  <canvas
                    ref={setCanvasRef(doc.id)}
                    style={{ display: 'block', width: '100%', height: '100%' }}
                  />

                  {/* Glass highlight */}
                  <div style={{
                    position: 'absolute', inset: 0, pointerEvents: 'none',
                    background: `
                      radial-gradient(ellipse 62% 42% at 28% 18%, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0.06) 55%, transparent 80%),
                      radial-gradient(ellipse 32% 22% at 72% 78%, rgba(255,255,255,0.1) 0%, transparent 100%)
                    `,
                  }} />

                  {/* Iridescent rim tint */}
                  <div style={{
                    position: 'absolute', inset: 0, pointerEvents: 'none',
                    background: 'linear-gradient(135deg, rgba(255,190,230,0.12) 0%, rgba(190,215,255,0.12) 33%, rgba(190,255,220,0.1) 66%, rgba(255,220,170,0.08) 100%)',
                  }} />

                  {/* Glass border */}
                  <div style={{
                    position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none',
                    border: '1.5px solid rgba(255,255,255,0.74)',
                    boxSizing: 'border-box',
                  }} />

                  {/* Text labels */}
                  <div style={{
                    position: 'absolute',
                    bottom: `calc(${layout.size} * 0.14)`,
                    left: `calc(${layout.size} * 0.1)`,
                    right: `calc(${layout.size} * 0.1)`,
                    pointerEvents: 'none',
                  }}>
                    <div style={{ fontSize: `calc(${layout.size} * 0.125)`, fontFamily: Cinzel, color: '#0F1937', fontWeight: 400, lineHeight: 1.15, textShadow: '0 1px 14px rgba(255,255,255,0.6)' }}>
                      {doc.title}
                    </div>
                    {doc.author && (
                      <div style={{ fontSize: `calc(${layout.size} * 0.052)`, letterSpacing: '0.13em', color: '#0F1937', opacity: 0.62, textTransform: 'uppercase', marginTop: '0.28em', fontFamily: Mono }}>
                        {doc.author}
                      </div>
                    )}
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.38em', marginTop: '0.5em', background: 'rgba(255,255,255,0.72)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', borderRadius: '20px', padding: '0.18em 0.72em' }}>
                      <div style={{ width: `calc(${layout.size} * 0.028)`, height: `calc(${layout.size} * 0.028)`, minWidth: '5px', minHeight: '5px', maxWidth: '10px', maxHeight: '10px', borderRadius: '50%', background: '#D97706', flexShrink: 0 }} />
                      <span style={{ fontSize: `calc(${layout.size} * 0.048)`, color: '#0F1937', fontFamily: Mono, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>In progress</span>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}

          {/* Empty state */}
          {documents.length === 0 && !importing && (
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', pointerEvents: 'none', zIndex: 5 }}>
              <div style={{ fontSize: '0.78rem', color: 'rgba(12,22,60,0.38)', letterSpacing: '0.14em', fontFamily: Mono }}>No worlds yet — add one →</div>
            </div>
          )}

          {/* Bottom info panel */}
          {focused && (
            <div style={{
              position: 'absolute', bottom: '4%', left: '50%', transform: 'translateX(-50%)',
              background: 'rgba(255,255,255,0.44)',
              backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
              border: '1px solid rgba(255,255,255,0.72)',
              borderRadius: '16px',
              padding: '1.4rem 2rem',
              display: 'flex', alignItems: 'center', gap: '2.5rem',
              boxShadow: '0 8px 44px rgba(130,155,220,0.22)',
              zIndex: 20,
              minWidth: '400px', maxWidth: '600px',
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.55rem', color: 'rgba(12,22,60,0.4)', letterSpacing: '0.22em', textTransform: 'uppercase', fontFamily: Mono, marginBottom: '0.32rem' }}>Selected world</div>
                <div style={{ fontSize: '1.65rem', fontFamily: Cinzel, color: '#0F1937', fontWeight: 400, lineHeight: 1.15, marginBottom: '0.12rem' }}>{focused.title}</div>
                {focused.author && (
                  <div style={{ fontSize: '0.62rem', letterSpacing: '0.13em', textTransform: 'uppercase', color: 'rgba(12,22,60,0.5)', fontFamily: Mono, marginBottom: '0.6rem' }}>{focused.author}</div>
                )}
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4em', background: 'rgba(255,255,255,0.6)', borderRadius: '20px', padding: '0.2em 0.8em' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#D97706', flexShrink: 0 }} />
                  <span style={{ fontSize: '0.65rem', color: '#0F1937', fontFamily: Mono }}>Catalog · In progress</span>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem', alignItems: 'stretch', flexShrink: 0 }}>
                <button type="button" onClick={() => handleOpenDoc(focused)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem', background: 'rgba(100,120,195,0.22)', border: '1px solid rgba(100,120,195,0.38)', borderRadius: '10px', padding: '0.65rem 1.4rem', color: '#0F1937', fontSize: '0.82rem', cursor: 'pointer', fontFamily: Cinzel, letterSpacing: '0.03em', whiteSpace: 'nowrap', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
                  Open Atlas Editor →
                </button>
                <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'center' }}>
                  <button type="button" onClick={() => openEdit(focused)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.64rem', color: 'rgba(12,22,60,0.38)', fontFamily: Mono, padding: '0.15rem 0.4rem' }}>
                    Edit
                  </button>
                  <button type="button" onClick={() => triggerBurn(focused)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.64rem', color: confirmingBurnId === focused.id ? '#c06060' : 'rgba(12,22,60,0.3)', fontFamily: Mono, padding: '0.15rem 0.4rem' }}>
                    {confirmingBurnId === focused.id ? 'Sure?' : 'Burn'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* New world bubble */}
          <label style={{
            position: 'absolute', bottom: '8%', right: '4%',
            width: '13vh', height: '13vh', minWidth: '90px', minHeight: '90px',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.2)',
            backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
            border: '1.5px solid rgba(255,255,255,0.68)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.15rem',
            cursor: importing ? 'wait' : 'pointer',
            boxShadow: '0 8px 32px rgba(140,165,225,0.2)',
            animation: 'decoFloat 4.6s ease-in-out 0.3s infinite alternate',
            zIndex: 15,
          }}>
            <input ref={fileRef} type="file" accept=".txt,.md,.pdf" style={{ display: 'none' }} onChange={handleImportFile} disabled={importing} />
            <div style={{ fontSize: '1.6rem', color: 'rgba(12,22,60,0.5)', lineHeight: 1, fontWeight: 300 }}>{importing ? '…' : '+'}</div>
            <div style={{ fontSize: '0.6rem', color: 'rgba(12,22,60,0.48)', fontFamily: Cinzel, letterSpacing: '0.04em', textAlign: 'center' }}>New world</div>
          </label>

          {/* Burn library */}
          <button type="button" onClick={() => { setShowReset(true); setResetInput('') }}
            style={{ position: 'absolute', bottom: '2rem', left: '2rem', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: '0.45rem', zIndex: 15 }}>
            <div style={{ fontSize: '1.05rem', lineHeight: 1.25 }}>🔥</div>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: '0.7rem', color: 'rgba(190,55,35,0.8)', fontFamily: Cinzel, letterSpacing: '0.04em' }}>Burn library</div>
              <div style={{ fontSize: '0.48rem', color: 'rgba(190,55,35,0.42)', letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: Mono }}>Erase all worlds and their data</div>
            </div>
          </button>

          {error && (
            <div style={{ position: 'absolute', top: '5rem', left: '50%', transform: 'translateX(-50%)', color: '#b04040', fontSize: '0.75rem', background: 'rgba(255,255,255,0.88)', padding: '0.4rem 1rem', borderRadius: '6px', fontFamily: Mono, zIndex: 25 }}>{error}</div>
          )}

          {/* Sections review modal */}
          {selected && view === 'sections-review' && (
            <div style={{ position: 'fixed', inset: '4vh 10vw', background: 'rgba(242,246,255,0.97)', border: '1px solid rgba(175,200,235,0.45)', borderRadius: '14px', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', overflow: 'auto', zIndex: 50, padding: '3rem 3rem 2.5rem', boxShadow: '0 8px 60px rgba(100,125,210,0.18)' }}>
              <p style={{ fontSize: '0.63rem', color: 'rgba(12,22,60,0.38)', marginBottom: '2rem', fontStyle: 'italic', fontFamily: Mono, letterSpacing: '0.06em' }}>
                Confirm metadata and sections before beginning the pipeline.
              </p>
              <div style={{ marginBottom: '1.75rem' }}>
                <h2 style={{ fontSize: '1.8rem', fontWeight: 400, color: '#0F1937', marginBottom: '0.3rem', lineHeight: 1.2, fontFamily: Cinzel }}>{selected.title}</h2>
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
                style={{ width: '100%', padding: '0.65rem', background: 'rgba(100,120,195,0.15)', border: '1px solid rgba(100,120,195,0.32)', borderRadius: '8px', color: '#0F1937', fontSize: '0.8rem', cursor: 'pointer', letterSpacing: '0.1em', fontFamily: Mono }}>
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
