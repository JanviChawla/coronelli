import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import * as THREE from 'three'
import { SectionEditor } from './SectionEditor'
import { SourceWorkflow } from './SourceWorkflow'
import {
  deleteDocument, fetchDocuments, fetchSections, importDocument,
  patchDocument, resetLibrary, updateSections,
  type Document, type Section, type SectionUpdate,
} from './sourceApi'

type View = 'workflow' | 'edit-sections' | 'sections-review'

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function planetColor(id: string): THREE.Color {
  const h = hashStr(id)
  const hues = [0.06, 0.12, 0.55, 0.68, 0.78, 0.35, 0.92, 0.45]
  return new THREE.Color().setHSL(hues[h % hues.length], 0.62, 0.40)
}

function clamp255(v: number): number { return Math.max(0, Math.min(255, v | 0)) }

function makePlanetTexture(baseColor: THREE.Color, seed: number): THREE.CanvasTexture {
  const sz = 256
  const cv = document.createElement('canvas'); cv.width = cv.height = sz
  const ctx = cv.getContext('2d')!
  const [r, g, b] = [baseColor.r * 255 | 0, baseColor.g * 255 | 0, baseColor.b * 255 | 0]
  ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(0, 0, sz, sz)
  let s = seed >>> 0
  const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296 }
  for (let i = 0; i < 80; i++) {
    const x = rand() * sz, y = rand() * sz, rad = 6 + rand() * sz * 0.22
    const bright = rand() > 0.5, a = 0.04 + rand() * 0.13, d = bright ? 55 : -45
    const gr = ctx.createRadialGradient(x, y, 0, x, y, rad)
    gr.addColorStop(0, `rgba(${clamp255(r+d)},${clamp255(g+d)},${clamp255(b+d)},${a})`)
    gr.addColorStop(1, `rgba(${r},${g},${b},0)`)
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill()
  }
  for (let i = 0; i < 5; i++) {
    const y = rand() * sz, bh = 2 + rand() * 18, a = 0.05 + rand() * 0.09
    const d = rand() > 0.5 ? 38 : -32
    ctx.fillStyle = `rgba(${clamp255(r+d)},${clamp255(g+d)},${clamp255(b+d)},${a})`
    ctx.fillRect(0, y, sz, bh)
  }
  return new THREE.CanvasTexture(cv)
}

interface PlanetData {
  mesh: THREE.Mesh
  ring?: THREE.Mesh
  glow?: THREE.Mesh
  moon?: THREE.Mesh
  moonDist: number
  orbitAngle: number
  orbitSpeed: number
  docId: string
  phase: number
  baseY: number
  radius: number
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SourceLibrary() {
  const [documents, setDocuments]   = useState<Document[]>([])
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
  const burnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileRef      = useRef<HTMLInputElement>(null)

  // Three.js
  const canvasRef        = useRef<HTMLCanvasElement>(null)
  const rendererRef      = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef         = useRef<THREE.Scene | null>(null)
  const cameraRef        = useRef<THREE.PerspectiveCamera | null>(null)
  const animFrameRef     = useRef<number>(0)
  const planetsRef       = useRef<PlanetData[]>([])
  const documentsRef     = useRef<Document[]>([])
  const mouseRef         = useRef(new THREE.Vector2(-9, -9))
  const raycasterRef     = useRef(new THREE.Raycaster())
  const camAngleRef      = useRef(0)
  const hoverIdRef       = useRef<string | null>(null)
  const rawHoverIdRef    = useRef<string | null>(null)
  const hoverTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverOverlayRef  = useRef<HTMLDivElement | null>(null)
  const labelRefsMap     = useRef<Map<string, HTMLDivElement>>(new Map())
  const selectDocRef     = useRef<(doc: Document) => void>()
  const [hoveredDoc, setHoveredDoc] = useState<Document | null>(null)

  documentsRef.current = documents

  // ── Data handlers ─────────────────────────────────────────────────────────

  useEffect(() => { fetchDocuments().then(setDocuments).catch(() => {}) }, [])

  async function handleSelectDoc(doc: Document) {
    setSelected(doc); setView('workflow'); setError(null); setSections([])
    try { setSections(await fetchSections(doc.id)) } catch { setError('Could not load sections.') }
  }
  selectDocRef.current = handleSelectDoc

  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setImporting(true); setError(null)
    try {
      const result = await importDocument(file, 'demo')
      setDocuments(prev => [...prev, result.document])
      setSelected(result.document); setSections(result.sections); setView('sections-review')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import failed.')
    } finally { setImporting(false); if (fileRef.current) fileRef.current.value = '' }
  }

  async function handleDelete(doc: Document) {
    try {
      await deleteDocument(doc.id)
      setDocuments(prev => prev.filter(d => d.id !== doc.id))
      if (selected?.id === doc.id) { setSelected(null); setSections([]) }
      if (hoverIdRef.current === doc.id) {
        hoverIdRef.current = null
        setHoveredDoc(null)
        if (hoverOverlayRef.current) hoverOverlayRef.current.style.display = 'none'
      }
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
      setEditingDoc(null)
    } catch { setError('Could not update metadata.') }
    finally { setEditSaving(false) }
  }

  async function handleReset() {
    setResetting(true)
    try { await resetLibrary(); setDocuments([]); setSelected(null); setSections([]); setError(null) }
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

  // ── Three.js scene (mount once) ───────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const w = canvas.clientWidth || window.innerWidth
    const h = canvas.clientHeight || window.innerHeight

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h)
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x030A18)
    scene.fog = new THREE.FogExp2(0x030A18, 0.007)
    sceneRef.current = scene

    const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 300)
    camera.position.set(0, 18, 38); camera.lookAt(0, 0, 0)
    cameraRef.current = camera

    // Lights
    scene.add(new THREE.AmbientLight(0x334477, 0.6))
    const sun = new THREE.PointLight(0xFFD580, 4, 160); sun.position.set(0, 8, 0); scene.add(sun)
    const rim = new THREE.DirectionalLight(0x8899CC, 0.35); rim.position.set(-20, 5, -10); scene.add(rim)

    // Stars
    ;(() => {
      const n = 1400, v = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), r = 75 + Math.random() * 22
        v[i*3] = r*Math.sin(ph)*Math.cos(th); v[i*3+1] = r*Math.sin(ph)*Math.sin(th); v[i*3+2] = r*Math.cos(ph)
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
      scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xDDE8FF, size: 0.13, transparent: true, opacity: 0.85, sizeAttenuation: true, fog: false })))
    })()

    // Dust (larger, very faint second layer)
    ;(() => {
      const n = 400, v = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), r = 30 + Math.random() * 45
        v[i*3] = r*Math.sin(ph)*Math.cos(th); v[i*3+1] = r*Math.sin(ph)*Math.sin(th)*0.3; v[i*3+2] = r*Math.cos(ph)
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
      scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xAABBDD, size: 0.32, transparent: true, opacity: 0.18, sizeAttenuation: true, fog: true })))
    })()

    // Nebula clouds
    const nebColors = [0x110A2A, 0x0A1530, 0x1E0818, 0x081808, 0x1A1A08, 0x0A180A, 0x120820]
    for (let i = 0; i < 9; i++) {
      const geo = new THREE.SphereGeometry(8 + Math.random() * 16, 7, 7)
      const mat = new THREE.MeshBasicMaterial({ color: nebColors[i % nebColors.length], transparent: true, opacity: 0.045 + Math.random() * 0.055, side: THREE.BackSide, depthWrite: false })
      const m = new THREE.Mesh(geo, mat)
      const ang = (i / 9) * Math.PI * 2
      m.position.set(Math.cos(ang) * (16 + Math.random() * 20), (Math.random() - 0.5) * 24, Math.sin(ang) * (16 + Math.random() * 20))
      m.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0); scene.add(m)
    }

    // Resize
    const onResize = () => {
      const W = canvas.clientWidth, H = canvas.clientHeight
      if (!W || !H) return
      renderer.setSize(W, H); camera.aspect = W / H; camera.updateProjectionMatrix()
    }
    const resObs = new ResizeObserver(onResize); resObs.observe(canvas)

    // Mouse
    const onMouseMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect()
      mouseRef.current.x = ((e.clientX - r.left) / r.width) * 2 - 1
      mouseRef.current.y = -((e.clientY - r.top) / r.height) * 2 + 1
    }
    canvas.addEventListener('mousemove', onMouseMove)

    // Click = Explore
    const onCanvasClick = () => {
      const hid = hoverIdRef.current; if (!hid) return
      const doc = documentsRef.current.find(d => d.id === hid)
      if (doc && selectDocRef.current) selectDocRef.current(doc)
    }
    canvas.addEventListener('click', onCanvasClick)

    // Animation loop
    let t = 0
    const animate = () => {
      animFrameRef.current = requestAnimationFrame(animate)
      t += 0.003
      camAngleRef.current += 0.0007
      camera.position.set(Math.sin(camAngleRef.current) * 38, 18, Math.cos(camAngleRef.current) * 38)
      camera.lookAt(0, 0, 0)

      // Bob planets + update labels
      const rect = canvas.getBoundingClientRect()
      for (const p of planetsRef.current) {
        p.mesh.position.y = p.baseY + Math.sin(t * 0.6 + p.phase) * 0.28
        p.mesh.rotation.y += 0.0045
        if (p.ring) p.ring.position.y = p.mesh.position.y
        if (p.glow) p.glow.position.y = p.mesh.position.y
        if (p.moon) {
          p.orbitAngle += p.orbitSpeed
          p.moon.position.set(
            p.mesh.position.x + Math.cos(p.orbitAngle) * p.moonDist,
            p.mesh.position.y + Math.sin(p.orbitAngle * 0.4) * p.moonDist * 0.15,
            p.mesh.position.z + Math.sin(p.orbitAngle) * p.moonDist,
          )
        }

        const el = labelRefsMap.current.get(p.docId)
        if (el && rect.width > 0) {
          const v3 = p.mesh.position.clone().project(camera)
          const sx = (v3.x * 0.5 + 0.5) * rect.width
          const sy = (-v3.y * 0.5 + 0.5) * rect.height + p.radius * 30 + 12
          el.style.left = `${sx}px`; el.style.top = `${sy}px`
          el.style.display = (v3.z > -1 && v3.z < 1) ? 'block' : 'none'
        }
      }

      // Raycasting
      raycasterRef.current.setFromCamera(mouseRef.current, camera)
      const hits = raycasterRef.current.intersectObjects(planetsRef.current.map(p => p.mesh))
      const hitId: string | null = hits.length > 0 ? (hits[0].object as THREE.Mesh).userData.docId as string : null
      rawHoverIdRef.current = hitId

      // Emissive + scale
      for (const p of planetsRef.current) {
        const mat = p.mesh.material as THREE.MeshStandardMaterial
        const isH = p.docId === hoverIdRef.current
        mat.emissiveIntensity += ((isH ? 0.55 : 0.08) - mat.emissiveIntensity) * 0.12
        const ts = isH ? 1.10 : 1.0
        p.mesh.scale.setScalar(p.mesh.scale.x + (ts - p.mesh.scale.x) * 0.10)
      }

      canvas.style.cursor = hoverIdRef.current ? 'pointer' : 'default'

      // Hover state management (with grace period so user can reach buttons)
      if (hitId !== null && hitId !== hoverIdRef.current) {
        if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null }
        hoverIdRef.current = hitId
        const planet = planetsRef.current.find(p => p.docId === hitId)
        if (planet && hoverOverlayRef.current && rect.width > 0) {
          const v3 = planet.mesh.position.clone().project(camera)
          const sx = (v3.x * 0.5 + 0.5) * rect.width
          const sy = (-v3.y * 0.5 + 0.5) * rect.height - planet.radius * 30 - 48
          hoverOverlayRef.current.style.left = `${sx}px`
          hoverOverlayRef.current.style.top = `${sy}px`
          hoverOverlayRef.current.style.display = 'flex'
        }
        setHoveredDoc(documentsRef.current.find(d => d.id === hitId) ?? null)
      } else if (hitId === null && hoverIdRef.current !== null && !hoverTimerRef.current) {
        hoverTimerRef.current = setTimeout(() => {
          hoverTimerRef.current = null
          if (rawHoverIdRef.current === null) {
            hoverIdRef.current = null
            setHoveredDoc(null)
            if (hoverOverlayRef.current) hoverOverlayRef.current.style.display = 'none'
          }
        }, 800)
      }

      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(animFrameRef.current)
      resObs.disconnect()
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('click', onCanvasClick)
      renderer.dispose()
      rendererRef.current = null; sceneRef.current = null; cameraRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Planets (rebuild on documents change) ─────────────────────────────────

  useEffect(() => {
    const scene = sceneRef.current; if (!scene) return
    for (const p of planetsRef.current) {
      scene.remove(p.mesh)
      const mat = p.mesh.material as THREE.MeshStandardMaterial
      if (mat.map) mat.map.dispose()
      mat.dispose(); p.mesh.geometry.dispose()
      if (p.ring) { scene.remove(p.ring); p.ring.geometry.dispose(); (p.ring.material as THREE.Material).dispose() }
      if (p.glow) { scene.remove(p.glow); p.glow.geometry.dispose(); (p.glow.material as THREE.Material).dispose() }
      if (p.moon) { scene.remove(p.moon); p.moon.geometry.dispose(); (p.moon.material as THREE.Material).dispose() }
    }
    planetsRef.current = []

    const GOLDEN = 2.399963229
    documents.forEach((doc, i) => {
      const h = hashStr(doc.id)
      const radius = 1.1 + (h % 10) / 10 * 1.1
      const color = planetColor(doc.id)
      const tex = makePlanetTexture(color, h)
      const geo = new THREE.SphereGeometry(radius, 48, 32)
      const mat = new THREE.MeshStandardMaterial({ map: tex, color, roughness: 0.65 + (h % 4) / 20, metalness: 0.05, emissive: color, emissiveIntensity: 0.08 })
      const mesh = new THREE.Mesh(geo, mat); mesh.userData.docId = doc.id
      const angle = i * GOLDEN, orbitR = 8 + i * 5.5 + ((h % 5) - 2), baseY = ((h % 7) - 3) * 1.2
      mesh.position.set(Math.cos(angle) * orbitR, baseY, Math.sin(angle) * orbitR)
      scene.add(mesh)

      // Atmospheric glow
      const glowGeo = new THREE.SphereGeometry(radius * 1.28, 16, 16)
      const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.13, side: THREE.BackSide, depthWrite: false })
      const glow = new THREE.Mesh(glowGeo, glowMat); glow.position.copy(mesh.position); scene.add(glow)

      // Ring (every planet — varying tilt and opacity)
      const ringInner = radius * 1.4 + (h % 4) * 0.12
      const ringOuter = ringInner + radius * 0.65 + (h % 6) * 0.15
      const rg = new THREE.RingGeometry(ringInner, ringOuter, 48)
      rg.rotateX(-(Math.PI / 3 + ((h % 7) / 7) * (Math.PI / 3.5)))
      const rm = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(((h * 37 + 60) % 360) / 360, 0.55, 0.38), transparent: true, opacity: 0.18 + (h % 5) * 0.05, side: THREE.DoubleSide, depthWrite: false })
      const ring = new THREE.Mesh(rg, rm); ring.position.copy(mesh.position); scene.add(ring)

      // Orbiting moon
      const moonDist = radius * 2.3 + (h % 5) * 0.25
      const moonR = radius * 0.17 + (h % 4) * 0.04
      const moonColor = new THREE.Color().setHSL(((h * 53 + 180) % 360) / 360, 0.75, 0.68)
      const moonGeo = new THREE.SphereGeometry(moonR, 10, 10)
      const moonMat = new THREE.MeshStandardMaterial({ color: moonColor, emissive: moonColor, emissiveIntensity: 1.4, roughness: 0.4 })
      const moon = new THREE.Mesh(moonGeo, moonMat); scene.add(moon)

      planetsRef.current.push({
        mesh, ring, glow, moon,
        moonDist,
        orbitAngle: (h % 73) / 73 * Math.PI * 2,
        orbitSpeed: 0.009 + (h % 8) * 0.001,
        docId: doc.id,
        phase: (h % 100) / 100 * Math.PI * 2,
        baseY, radius,
      })
    })
  }, [documents])

  // ── Overlays / modals ─────────────────────────────────────────────────────

  function editingDocOverlay() {
    if (!editingDoc) return null
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
        <div style={{ background: 'rgba(8,14,28,0.97)', border: '1px solid rgba(212,188,138,0.2)', borderRadius: '8px', padding: '2rem 2.25rem', width: '380px', maxWidth: '90vw', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
          <p style={{ fontSize: '1rem', fontWeight: 400, color: '#D4B060', marginBottom: '1.25rem', fontFamily: "'Cinzel', serif" }}>Edit metadata</p>
          {[{ label: 'Title', value: editTitle, set: setEditTitle, type: 'text' }, { label: 'Author', value: editAuthor, set: setEditAuthor, type: 'text' }, { label: 'Year', value: editYear, set: setEditYear, type: 'number' }].map(({ label, value, set, type }) => (
            <div key={label} style={{ marginBottom: '0.9rem' }}>
              <label style={{ display: 'block', fontSize: '0.68rem', color: 'rgba(212,188,138,0.55)', marginBottom: '0.25rem', letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: "'Space Mono', monospace" }}>{label}</label>
              <input type={type} value={value} onChange={e => set(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveEdit() }}
                style={{ width: '100%', boxSizing: 'border-box', padding: '0.45rem 0.75rem', fontSize: '0.85rem', border: '1px solid rgba(212,188,138,0.2)', borderRadius: '4px', background: 'rgba(255,255,255,0.05)', color: '#E8DFC8', outline: 'none' }} />
            </div>
          ))}
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
            <button type="button" onClick={() => setEditingDoc(null)} disabled={editSaving} style={{ fontSize: '0.8rem', padding: '0.45rem 1rem', background: 'none', border: '1px solid rgba(212,188,138,0.2)', borderRadius: '4px', cursor: 'pointer', color: 'rgba(212,188,138,0.6)' }}>Cancel</button>
            <button type="button" onClick={saveEdit} disabled={editSaving} style={{ fontSize: '0.8rem', padding: '0.45rem 1.1rem', background: '#B8943A', border: 'none', borderRadius: '4px', cursor: 'pointer', color: '#0A0806', fontWeight: 600, opacity: editSaving ? 0.6 : 1 }}>{editSaving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    )
  }

  function resetModal() {
    if (!showReset) return null
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
        <div style={{ background: 'rgba(8,14,28,0.97)', border: '1px solid rgba(212,188,138,0.2)', borderRadius: '8px', padding: '2rem 2.25rem', width: '360px', maxWidth: '90vw', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
          <p style={{ fontSize: '1rem', color: '#D4B060', marginBottom: '0.4rem', fontFamily: "'Cinzel', serif" }}>Reset the library?</p>
          <p style={{ fontSize: '0.8rem', color: 'rgba(212,188,138,0.55)', marginBottom: '1.5rem', lineHeight: 1.55 }}>Permanently deletes every document, section, candidate, and atlas entity. No undo.</p>
          <p style={{ fontSize: '0.75rem', color: 'rgba(212,188,138,0.5)', marginBottom: '0.5rem' }}>Type <strong style={{ color: 'rgba(212,188,138,0.8)' }}>reset</strong> to confirm:</p>
          <input type="text" value={resetInput} onChange={e => setResetInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && resetInput === 'reset') handleReset() }} placeholder="reset" autoFocus
            style={{ width: '100%', boxSizing: 'border-box', padding: '0.5rem 0.75rem', fontSize: '0.85rem', border: '1px solid rgba(212,188,138,0.2)', borderRadius: '4px', background: 'rgba(255,255,255,0.05)', color: '#E8DFC8', marginBottom: '1.25rem', outline: 'none' }} />
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => { setShowReset(false); setResetInput('') }} disabled={resetting} style={{ fontSize: '0.8rem', padding: '0.45rem 1rem', background: 'none', border: '1px solid rgba(212,188,138,0.2)', borderRadius: '4px', cursor: 'pointer', color: 'rgba(212,188,138,0.6)' }}>Cancel</button>
            <button type="button" onClick={handleReset} disabled={resetInput !== 'reset' || resetting}
              style={{ fontSize: '0.8rem', padding: '0.45rem 1rem', background: resetInput === 'reset' ? '#7f1d1d' : 'rgba(255,255,255,0.06)', border: 'none', borderRadius: '4px', cursor: resetInput === 'reset' ? 'pointer' : 'not-allowed', color: resetInput === 'reset' ? '#fef2f2' : 'rgba(255,255,255,0.3)', opacity: resetting ? 0.6 : 1, transition: 'background 0.15s' }}>
              {resetting ? 'Resetting…' : 'Reset everything'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const SM = "'Space Mono', monospace"
  const Cinzel = "'Cinzel', serif"

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#030A18', overflow: 'hidden' }}>

      {/* Three.js canvas — always present */}
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />

      {/* Planet labels — imperatively positioned, always rendered */}
      {documents.map(doc => (
        <div key={doc.id}
          ref={el => { if (el) labelRefsMap.current.set(doc.id, el); else labelRefsMap.current.delete(doc.id) }}
          style={{ position: 'absolute', pointerEvents: 'none', textAlign: 'center', transform: 'translateX(-50%)', fontFamily: Cinzel, fontSize: '0.65rem', color: 'rgba(212,188,138,0.55)', letterSpacing: '0.12em', textShadow: '0 0 12px rgba(0,0,0,0.9)', whiteSpace: 'nowrap', display: 'none' }}>
          {doc.title}
        </div>
      ))}

      {/* Hover overlay — imperatively shown/hidden, buttons are React */}
      <div
        ref={hoverOverlayRef}
        onMouseEnter={() => { if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null } }}
        onMouseLeave={() => {
          if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
          hoverTimerRef.current = setTimeout(() => {
            hoverTimerRef.current = null
            if (rawHoverIdRef.current === null) {
              hoverIdRef.current = null; setHoveredDoc(null)
              if (hoverOverlayRef.current) hoverOverlayRef.current.style.display = 'none'
            }
          }, 600)
        }}
        style={{ position: 'absolute', display: 'none', flexDirection: 'column', alignItems: 'center', gap: '0.55rem', transform: 'translate(-50%, -100%)', zIndex: 10 }}>
        <div style={{ fontFamily: Cinzel, fontSize: '0.88rem', color: '#D4B060', letterSpacing: '0.12em', textShadow: '0 0 24px rgba(0,0,0,0.95)', whiteSpace: 'nowrap' }}>
          {hoveredDoc?.title}
        </div>
        {hoveredDoc?.author && (
          <div style={{ fontFamily: SM, fontSize: '0.6rem', color: 'rgba(212,188,138,0.4)', letterSpacing: '0.08em', marginTop: '-0.3rem' }}>{hoveredDoc.author}</div>
        )}
        <div style={{ display: 'flex', gap: '0.45rem', marginTop: '0.15rem' }}>
          <button type="button" onClick={() => hoveredDoc && handleSelectDoc(hoveredDoc)}
            style={{ padding: '0.38rem 1.1rem', background: 'rgba(184,148,58,0.12)', border: '1px solid rgba(184,148,58,0.5)', borderRadius: '4px', color: '#D4AF37', fontSize: '0.72rem', cursor: 'pointer', letterSpacing: '0.1em', fontFamily: SM, backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', transition: 'background 0.15s' }}>
            Explore
          </button>
          <button type="button" onClick={() => hoveredDoc && triggerBurn(hoveredDoc)}
            style={{ padding: '0.38rem 0.85rem', background: confirmingBurnId === hoveredDoc?.id ? 'rgba(160,40,40,0.2)' : 'rgba(255,255,255,0.04)', border: `1px solid ${confirmingBurnId === hoveredDoc?.id ? 'rgba(160,40,40,0.5)' : 'rgba(255,255,255,0.15)'}`, borderRadius: '4px', color: confirmingBurnId === hoveredDoc?.id ? '#c07070' : 'rgba(255,255,255,0.38)', fontSize: '0.68rem', cursor: 'pointer', letterSpacing: '0.08em', fontFamily: SM, backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', transition: 'all 0.15s' }}>
            {confirmingBurnId === hoveredDoc?.id ? 'Sure?' : 'Burn'}
          </button>
        </div>
      </div>

      {/* Library UI — brand + add button (no book open) */}
      {!selected && (
        <>
          <div style={{ position: 'absolute', top: '2.2rem', left: '50%', transform: 'translateX(-50%)', textAlign: 'center', pointerEvents: 'none', userSelect: 'none' }}>
            <div style={{ fontSize: '1.7rem', letterSpacing: '0.28em', color: 'rgba(212,175,55,0.9)', textTransform: 'uppercase', fontWeight: 400, fontFamily: Cinzel }}>Coronelli</div>
            <div style={{ fontSize: '0.55rem', color: 'rgba(212,188,138,0.35)', letterSpacing: '0.24em', textTransform: 'uppercase', marginTop: '0.35rem', fontFamily: SM }}>Texts for places</div>
          </div>

          <label style={{ position: 'absolute', bottom: '2.2rem', right: '2.2rem', cursor: importing ? 'wait' : 'pointer' }}>
            <input ref={fileRef} type="file" accept=".txt,.md,.pdf" style={{ display: 'none' }} onChange={handleImportFile} disabled={importing} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', border: '1px solid rgba(184,148,58,0.45)', borderRadius: '5px', padding: '0.5rem 1.15rem', color: 'rgba(184,148,58,0.8)', fontSize: '0.72rem', opacity: importing ? 0.5 : 1, userSelect: 'none', letterSpacing: '0.1em', fontFamily: SM, backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', background: 'rgba(184,148,58,0.06)' }}>
              {importing ? 'Importing…' : '+ New World'}
            </span>
          </label>

          {documents.length === 0 && !importing && (
            <div style={{ position: 'absolute', top: '54%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', pointerEvents: 'none' }}>
              <div style={{ fontSize: '0.7rem', color: 'rgba(212,188,138,0.22)', letterSpacing: '0.15em', fontFamily: SM }}>No worlds yet.</div>
            </div>
          )}

          {error && (
            <div style={{ position: 'absolute', top: '5.5rem', left: '50%', transform: 'translateX(-50%)', color: '#e87070', fontSize: '0.75rem', background: 'rgba(0,0,0,0.65)', padding: '0.4rem 1rem', borderRadius: '4px', fontFamily: SM }}>{error}</div>
          )}

          <button type="button" onClick={() => { setShowReset(true); setResetInput('') }}
            style={{ position: 'absolute', bottom: '2.2rem', left: '2.2rem', fontSize: '0.58rem', color: 'rgba(212,188,138,0.2)', background: 'none', border: '1px solid rgba(212,188,138,0.1)', borderRadius: '3px', padding: '0.22rem 0.65rem', cursor: 'pointer', letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: SM }}>
            Burn library
          </button>
        </>
      )}

      {/* Sections review — modal over space */}
      {selected && view === 'sections-review' && (
        <div style={{ position: 'absolute', inset: '4vh 10vw', background: 'rgba(5,10,22,0.94)', border: '1px solid rgba(212,188,138,0.12)', borderRadius: '8px', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', overflow: 'auto', zIndex: 20, padding: '3rem 3rem 2.5rem', boxShadow: '0 0 100px rgba(0,0,0,0.8)' }}>
          <p style={{ fontSize: '0.65rem', color: 'rgba(212,188,138,0.35)', marginBottom: '2rem', fontStyle: 'italic', fontFamily: SM, letterSpacing: '0.06em' }}>
            Confirm metadata and sections before beginning the pipeline.
          </p>

          <div style={{ marginBottom: '1.75rem' }}>
            <h2 style={{ fontSize: '1.8rem', fontWeight: 400, color: '#D4B060', marginBottom: '0.3rem', lineHeight: 1.2, fontFamily: Cinzel }}>{selected.title}</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              {selected.author && <span style={{ fontSize: '0.82rem', color: 'rgba(212,188,138,0.55)', fontFamily: SM }}>{selected.author}</span>}
              {selected.year && <span style={{ fontSize: '0.75rem', color: 'rgba(212,188,138,0.35)', fontFamily: SM }}>{selected.year}</span>}
              <button type="button" onClick={() => openEdit(selected)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '0.68rem', color: 'rgba(212,188,138,0.4)', textDecoration: 'underline', textUnderlineOffset: '3px', fontFamily: SM }}>✎ Edit</button>
            </div>
          </div>

          <p style={{ fontSize: '0.58rem', color: 'rgba(212,188,138,0.35)', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.5rem', fontFamily: SM }}>
            {sections.length} section{sections.length !== 1 ? 's' : ''}
          </p>

          <div style={{ border: '1px solid rgba(212,188,138,0.1)', borderRadius: '6px', overflow: 'hidden', marginBottom: '2rem' }}>
            {sections.length === 0
              ? <div style={{ padding: '1rem 1.1rem', fontSize: '0.82rem', color: 'rgba(212,188,138,0.3)', fontStyle: 'italic', fontFamily: SM }}>Loading sections…</div>
              : sections.map((s, i) => {
                  const lines = s.text.split('\n').filter(l => l.trim())
                  const preview = lines.slice(0, 2).map(l => l.length > 120 ? l.slice(0, 120) + '…' : l).join(' ')
                  return (
                    <div key={s.id} style={{ padding: '0.6rem 1.1rem', borderBottom: i < sections.length - 1 ? '1px solid rgba(212,188,138,0.07)' : 'none' }}>
                      <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'baseline', marginBottom: preview ? '0.15rem' : 0 }}>
                        <span style={{ fontSize: '0.55rem', color: 'rgba(184,148,58,0.6)', minWidth: '1.6rem', fontFamily: SM, flexShrink: 0 }}>§{s.ordinal + 1}</span>
                        <span style={{ fontSize: '0.85rem', color: 'rgba(212,188,138,0.8)', fontWeight: 500, fontFamily: Cinzel }}>{s.title || `Section ${s.ordinal + 1}`}</span>
                      </div>
                      {preview && <div style={{ paddingLeft: '2.3rem', fontSize: '0.72rem', color: 'rgba(212,188,138,0.3)', fontStyle: 'italic', lineHeight: 1.45, fontFamily: SM }}>{preview}</div>}
                    </div>
                  )
                })
            }
          </div>

          <button type="button" onClick={() => setView('workflow')}
            style={{ width: '100%', padding: '0.65rem', background: 'rgba(184,148,58,0.15)', border: '1px solid rgba(184,148,58,0.4)', borderRadius: '5px', color: '#D4AF37', fontSize: '0.8rem', cursor: 'pointer', letterSpacing: '0.1em', fontFamily: SM }}>
            Begin pipeline →
          </button>
          {error && <p style={{ color: '#e87070', fontSize: '0.75rem', marginTop: '0.75rem', fontFamily: SM }}>{error}</p>}
        </div>
      )}

      {/* Workflow / edit-sections — full screen */}
      {selected && (view === 'workflow' || view === 'edit-sections') && (
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', zIndex: 20 }}>
          {view === 'edit-sections' ? (
            <div style={{ height: '100%', background: 'var(--parchment)', display: 'flex', flexDirection: 'column', padding: '3.5rem 4rem', overflowY: 'auto' }}>
              <button type="button" onClick={() => setView('workflow')} style={{ fontSize: '0.8rem', marginBottom: '1.25rem', color: 'var(--ink-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}>
                ← Back to workflow
              </button>
              <SectionEditor documentId={selected.id} sections={sections} onSave={handleSave} />
            </div>
          ) : (
            <SourceWorkflow
              document={selected}
              sections={sections}
              onBack={() => setSelected(null)}
              onEditSections={() => setView('edit-sections')}
              onEdit={() => openEdit(selected)}
              onDelete={() => { handleDelete(selected); setSelected(null) }}
            />
          )}
        </div>
      )}

      {editingDocOverlay()}
      {resetModal()}
    </div>
  )
}
