import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { type Document, type Section, listDocuments, createDocument, deleteDocument } from '../../api/client'

const GOLDEN_ANGLE = 2.39996323

interface Props {
  onExplore: (docId: string) => void
  onImport: (file: File, meta: { title: string; author?: string }) => void
}

function hashDocId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) >>> 0
  }
  return h
}

function docColor(id: string): THREE.Color {
  const hue = (hashDocId(id) % 360) / 360
  return new THREE.Color().setHSL(hue, 0.65, 0.55)
}

interface PlanetData {
  group: THREE.Group
  mesh: THREE.Mesh
  glow: THREE.Sprite
  glowBase: number
  orbitalGroups: THREE.Group[]
  orbitSpeeds: number[]
  doc: Document
  baseY: number
  phase: number
  rotSpeed: number
}

function makeGlowTexture(): THREE.Texture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0,   'rgba(255,255,255,0.85)')
  grad.addColorStop(0.25,'rgba(255,255,255,0.40)')
  grad.addColorStop(0.6, 'rgba(255,255,255,0.10)')
  grad.addColorStop(1,   'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

export default function LibraryScene({ onExplore, onImport }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const planetsRef = useRef<PlanetData[]>([])
  const stableRef  = useRef<Map<string, { phase: number; rotSpeed: number; orbitSpeeds: number[] }>>(new Map())
  const rafRef = useRef<number>(0)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const hoveredDocRef = useRef<Document | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [documents, setDocuments] = useState<Document[]>([])
  const [showImportModal, setShowImportModal] = useState(false)
  const [importStep, setImportStep] = useState<'form' | 'review'>('form')
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importTitle, setImportTitle] = useState('')
  const [importAuthor, setImportAuthor] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<(Document & { sections: Section[] }) | null>(null)

  const fetchDocs = useCallback(async () => {
    try {
      const docs = await listDocuments()
      setDocuments(docs)
    } catch {
      // silently ignore — API may not be running yet
    }
  }, [])

  useEffect(() => {
    fetchDocs()
    const interval = setInterval(fetchDocs, 5000)
    return () => clearInterval(interval)
  }, [fetchDocs])

  // Sync planet meshes when documents change
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    // Remove old planets
    for (const pd of planetsRef.current) {
      scene.remove(pd.group)
      pd.group.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose()
        if ((obj as THREE.Mesh).material) {
          const m = (obj as THREE.Mesh).material
          if (Array.isArray(m)) m.forEach((x) => x.dispose())
          else (m as THREE.Material).dispose()
        }
      })
      ;(pd.glow.material as THREE.SpriteMaterial).map?.dispose()
      pd.glow.material.dispose()
    }
    planetsRef.current = []

    const glowTex = makeGlowTexture()

    // Evict stable data for deleted docs
    const liveIds = new Set(documents.map((d) => d.id))
    for (const id of stableRef.current.keys()) {
      if (!liveIds.has(id)) stableRef.current.delete(id)
    }

    documents.forEach((doc, i) => {
      const h = hashDocId(doc.id)
      const radius = 0.5 + (h % 30) / 100
      const color = docColor(doc.id)
      const hue   = (h % 360) / 360
      const group = new THREE.Group()

      // ── Stable per-doc animation data (survives re-polls) ──
      if (!stableRef.current.has(doc.id)) {
        stableRef.current.set(doc.id, {
          phase:       Math.random() * Math.PI * 2,
          rotSpeed:    0.003 + Math.random() * 0.005,
          orbitSpeeds: [
            (Math.random() > 0.5 ? 1 : -1) * (0.005 + Math.random() * 0.004),
            (Math.random() > 0.5 ? 1 : -1) * (0.003 + Math.random() * 0.003),
          ],
        })
      }
      const stable = stableRef.current.get(doc.id)!

      // ── Planet mesh — 3 types keyed by hash ──
      const planetType = h % 3
      let mesh: THREE.Mesh

      if (planetType === 0) {
        // Gas giant: smooth sphere + transparent atmosphere shell + optional storm spot
        const geo = new THREE.SphereGeometry(radius, 40, 40)
        const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.22, roughness: 0.45, metalness: 0.1 })
        mesh = new THREE.Mesh(geo, mat)
        group.add(mesh)

        // Atmosphere shell (rendered from inside → BackSide)
        const atmColor = color.clone().offsetHSL(0.05, 0, 0.15)
        const atmGeo = new THREE.SphereGeometry(radius * 1.2, 24, 24)
        const atmMat = new THREE.MeshBasicMaterial({ color: atmColor, transparent: true, opacity: 0.18, side: THREE.BackSide, depthWrite: false })
        group.add(new THREE.Mesh(atmGeo, atmMat))

        // Storm spot on ~40% of gas giants
        if (h % 5 < 2) {
          const spotHue = (hue + 0.15) % 1
          const spotColor = new THREE.Color().setHSL(spotHue, 0.9, 0.65)
          const spotGeo = new THREE.SphereGeometry(radius * 0.22, 8, 8)
          const spotMat = new THREE.MeshBasicMaterial({ color: spotColor })
          const spot = new THREE.Mesh(spotGeo, spotMat)
          const theta = (h % 90) * (Math.PI / 180) - Math.PI / 4
          spot.position.set(Math.cos(theta) * radius * 0.97, Math.sin(theta) * radius * 0.97 * 0.3, radius * 0.82)
          group.add(spot)
        }

      } else if (planetType === 1) {
        // Rocky/barren: displaced icosahedron, no atmosphere, rough dark surface
        const geo = new THREE.IcosahedronGeometry(radius, 4)
        const pos = geo.attributes.position as THREE.BufferAttribute
        for (let vi = 0; vi < pos.count; vi++) {
          const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi)
          const noise = Math.sin(x * 11.3 + h * 0.01) * Math.cos(y * 8.7 + h * 0.02) * Math.sin(z * 13.1 + h * 0.03)
          const d = 1 + noise * 0.13
          pos.setXYZ(vi, x * d, y * d, z * d)
        }
        geo.computeVertexNormals()
        const darkColor = color.clone().multiplyScalar(0.72)
        const mat = new THREE.MeshStandardMaterial({ color: darkColor, emissive: color, emissiveIntensity: 0.14, roughness: 0.92, metalness: 0.05 })
        mesh = new THREE.Mesh(geo, mat)
        group.add(mesh)

      } else {
        // Ringed planet: sphere + torus ring system + thin atmosphere
        const geo = new THREE.SphereGeometry(radius, 36, 36)
        const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.22, roughness: 0.55, metalness: 0.2 })
        mesh = new THREE.Mesh(geo, mat)
        group.add(mesh)

        // Thin atmosphere
        const atmGeo = new THREE.SphereGeometry(radius * 1.12, 20, 20)
        const atmMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.BackSide, depthWrite: false })
        group.add(new THREE.Mesh(atmGeo, atmMat))

        // Ring disc
        const ringInner = radius * 1.45
        const ringOuter = radius * 2.55
        const ringGeo = new THREE.RingGeometry(ringInner, ringOuter, 52)
        const ringColor = color.clone().offsetHSL(0, -0.15, 0.1)
        const ringMat = new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false })
        const ring = new THREE.Mesh(ringGeo, ringMat)
        // tilt so rings are visible from above
        ring.rotation.x = Math.PI / 2 - (0.28 + (h % 12) * 0.03)
        ring.rotation.z = (h % 180) * (Math.PI / 180)
        group.add(ring)
      }

      mesh.userData = { docId: doc.id }

      // ── Glow sprite ──
      const glowBase = radius * 3.8
      const glowMat = new THREE.SpriteMaterial({
        map: glowTex,
        color,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.55,
      })
      const glow = new THREE.Sprite(glowMat)
      glow.scale.set(glowBase, glowBase, 1)
      group.add(glow)

      // ── Orbital light strings (2 rings) ──
      const orbitalGroups: THREE.Group[] = []
      const orbitSpeeds: number[] = []

      for (let ri = 0; ri < 2; ri++) {
        const orbit = new THREE.Group()
        orbit.rotation.x = ((h * (ri + 1) * 37) % 180) * (Math.PI / 180)
        orbit.rotation.z = ((h * (ri + 1) * 53) % 360) * (Math.PI / 180)

        const nDots = 5 + ((h + ri * 13) % 5)          // 5–9 dots
        const ringR  = radius * (2.1 + ri * 0.65)
        const dotR   = 0.028 + (ri * 0.012)

        // Adjust hue slightly per ring
        const ringColor = color.clone()
        ringColor.offsetHSL(ri * 0.06, 0, ri * 0.12)

        const linePositions: number[] = []
        for (let j = 0; j < nDots; j++) {
          const a = (j / nDots) * Math.PI * 2
          const px = Math.cos(a) * ringR
          const pz = Math.sin(a) * ringR
          linePositions.push(px, 0, pz)

          // vary dot size subtly
          const dotSize = dotR * (0.8 + (j % 3) * 0.25)
          const dotGeo = new THREE.SphereGeometry(dotSize, 5, 5)
          const dotMat = new THREE.MeshBasicMaterial({ color: ringColor })
          const dot = new THREE.Mesh(dotGeo, dotMat)
          dot.position.set(px, 0, pz)
          orbit.add(dot)
        }
        // close the loop for the line
        linePositions.push(linePositions[0], linePositions[1], linePositions[2])

        const lineGeo = new THREE.BufferGeometry()
        lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3))
        const lineMat = new THREE.LineBasicMaterial({ color: ringColor, transparent: true, opacity: 0.18 })
        orbit.add(new THREE.Line(lineGeo, lineMat))

        group.add(orbit)
        orbitalGroups.push(orbit)
        // alternate rotation direction, slightly different speeds
        orbitSpeeds.push(stable.orbitSpeeds[ri] ?? ((ri % 2 === 0 ? 0.006 : -0.004) + (h % 5) * 0.0005))
      }

      const angle = i * GOLDEN_ANGLE
      const dist  = 4 + i * 1.2
      group.position.set(dist * Math.cos(angle), 0, dist * Math.sin(angle))

      scene.add(group)
      planetsRef.current.push({
        group, mesh, glow, glowBase, orbitalGroups, orbitSpeeds,
        doc,
        baseY: group.position.y,
        phase:    stable.phase,
        rotSpeed: stable.rotSpeed,
      })
    })
  }, [documents])

  // Three.js setup
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    mount.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x060c18)
    scene.fog = new THREE.FogExp2(0x060c18, 0.024)
    sceneRef.current = scene

    const camera = new THREE.PerspectiveCamera(60, mount.clientWidth / mount.clientHeight, 0.1, 200)
    camera.position.set(0, 8, 18)
    cameraRef.current = camera

    // Stars
    const starGeo = new THREE.BufferGeometry()
    const starPositions: number[] = []
    for (let i = 0; i < 900; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const r = 55 + Math.random() * 5
      starPositions.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      )
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3))
    const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.18, fog: false })
    scene.add(new THREE.Points(starGeo, starMat))

    // Lights
    scene.add(new THREE.AmbientLight(0x334477, 0.5))
    const dirLight = new THREE.DirectionalLight(0xfff8e8, 1.2)
    dirLight.position.set(5, 10, 5)
    scene.add(dirLight)

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.05
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.3
    controls.minDistance = 3
    controls.maxDistance = 40
    controlsRef.current = controls

    // Overlay element
    const overlay = document.createElement('div')
    overlay.style.cssText = `
      position: absolute;
      background: rgba(14,21,37,0.92);
      border: 1px solid rgba(184,148,58,0.3);
      border-radius: 6px;
      padding: 12px 16px;
      pointer-events: auto;
      display: none;
      min-width: 160px;
      z-index: 10;
    `
    mount.style.position = 'relative'
    mount.appendChild(overlay)
    overlayRef.current = overlay

    // Raycasting
    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()

    let lastHoveredPd: PlanetData | null = null

    const setHoverState = (pd: PlanetData | null) => {
      if (lastHoveredPd && lastHoveredPd !== pd) {
        ;(lastHoveredPd.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.22
        lastHoveredPd.glow.scale.set(lastHoveredPd.glowBase, lastHoveredPd.glowBase, 1)
        ;(lastHoveredPd.glow.material as THREE.SpriteMaterial).opacity = 0.55
      }
      if (pd) {
        ;(pd.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.75
        const hs = pd.glowBase * 2.4
        pd.glow.scale.set(hs, hs, 1)
        ;(pd.glow.material as THREE.SpriteMaterial).opacity = 0.85
      }
      lastHoveredPd = pd
    }

    const onMouseMove = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      mouse.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(mouse, camera)
      const meshes = planetsRef.current.map((pd) => pd.mesh)
      const hits = raycaster.intersectObjects(meshes)

      if (hits.length > 0) {
        const hit = hits[0]
        const pd = planetsRef.current.find((p) => p.mesh === hit.object)
        if (pd) {
          setHoverState(pd)
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
          hoveredDocRef.current = pd.doc
          // Position overlay
          const pos = hit.object.position.clone().project(camera)
          const x = ((pos.x + 1) / 2) * renderer.domElement.clientWidth
          const y = ((-pos.y + 1) / 2) * renderer.domElement.clientHeight
          overlay.style.left = `${x + 12}px`
          overlay.style.top = `${y - 20}px`
          overlay.style.display = 'block'
          overlay.innerHTML = `
            <div style="font-family:'Cinzel',serif;font-size:13px;color:#D4B060;margin-bottom:4px">${pd.doc.title}</div>
            ${pd.doc.author ? `<div style="font-family:'Space Mono',monospace;font-size:9px;color:#6B6352;margin-bottom:10px">${pd.doc.author}</div>` : '<div style="margin-bottom:10px"></div>'}
            <div style="display:flex;gap:8px">
              <button id="explore-btn" style="background:rgba(184,148,58,0.15);border:1px solid rgba(184,148,58,0.4);color:#D4B060;font-size:9px;letter-spacing:.08em;text-transform:uppercase;padding:5px 12px;border-radius:2px;cursor:pointer">
                Explore →
              </button>
              <button id="delete-btn" style="background:rgba(154,74,74,0.12);border:1px solid rgba(154,74,74,0.3);color:#C87878;font-size:9px;letter-spacing:.08em;text-transform:uppercase;padding:5px 10px;border-radius:2px;cursor:pointer">
                Delete
              </button>
            </div>
          `
          overlay.querySelector('#explore-btn')?.addEventListener('click', () => {
            if (hoveredDocRef.current) onExplore(hoveredDocRef.current.id)
          })
          overlay.querySelector('#delete-btn')?.addEventListener('click', async () => {
            const doc = hoveredDocRef.current
            if (!doc) return
            if (!confirm(`Delete "${doc.title}"? This cannot be undone.`)) return
            overlay.style.display = 'none'
            hoveredDocRef.current = null
            await deleteDocument(doc.id)
            await fetchDocs()
          })
        }
      } else {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
        hideTimerRef.current = setTimeout(() => {
          overlay.style.display = 'none'
          hoveredDocRef.current = null
          setHoverState(null)
        }, 280)
      }
    }

    renderer.domElement.addEventListener('mousemove', onMouseMove)

    // Animation loop
    let t = 0
    const animate = () => {
      rafRef.current = requestAnimationFrame(animate)
      t += 0.016

      for (const pd of planetsRef.current) {
        const dy = Math.sin(t * 0.72 + pd.phase) * 0.07
        pd.group.position.y = pd.baseY + dy
        pd.mesh.rotation.y += pd.rotSpeed

        // Rotate orbital rings
        for (let ri = 0; ri < pd.orbitalGroups.length; ri++) {
          pd.orbitalGroups[ri].rotation.y += pd.orbitSpeeds[ri]
        }

        // Pulse idle glow (only when not hovered)
        if (lastHoveredPd !== pd) {
          const pulse = pd.glowBase * (0.92 + Math.sin(t * 1.1 + pd.phase) * 0.08)
          pd.glow.scale.set(pulse, pulse, 1)
        }
      }

      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const onResize = () => {
      if (!mount) return
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', onResize)
      renderer.domElement.removeEventListener('mousemove', onMouseMove)
      controls.dispose()
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
      if (mount.contains(overlay)) mount.removeChild(overlay)
    }
  }, [onExplore])

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: '9px', fontFamily: "'Space Mono',monospace",
    color: '#6B6352', letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: '6px',
  }
  const inputStyle: React.CSSProperties = {
    width: '100%', background: '#141E30', border: '1px solid rgba(184,148,58,0.2)',
    borderRadius: '3px', color: '#C8BC9E', padding: '8px 10px', fontSize: '14px',
    fontFamily: "'Crimson Pro',serif", boxSizing: 'border-box',
  }
  const cancelBtnStyle: React.CSSProperties = {
    background: 'transparent', border: '1px solid rgba(184,148,58,0.2)', color: '#6B6352',
    fontFamily: "'Space Mono',monospace", fontSize: '9px', letterSpacing: '.1em',
    padding: '8px 16px', borderRadius: '2px', cursor: 'pointer',
  }
  const actionBtnStyle: React.CSSProperties = {
    background: 'rgba(184,148,58,0.15)', border: '1px solid rgba(184,148,58,0.4)', color: '#D4B060',
    fontFamily: "'Space Mono',monospace", fontSize: '9px', letterSpacing: '.1em',
    padding: '8px 16px', borderRadius: '2px', cursor: 'pointer',
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setImportFile(file)
      setImportTitle(file.name.replace(/\.[^.]+$/, ''))
      setShowImportModal(true)
    }
  }

  const handleImportSubmit = async () => {
    if (!importFile || !importTitle) return
    setImporting(true)
    try {
      const result = await createDocument(importFile, { title: importTitle, author: importAuthor || undefined })
      setImportResult(result)
      setImportStep('review')
      await fetchDocs()
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setImporting(false)
    }
  }

  const closeImportModal = () => {
    setShowImportModal(false)
    setImportStep('form')
    setImportFile(null)
    setImportTitle('')
    setImportAuthor('')
    setImportResult(null)
  }

  return (
    <>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />

      {/* Import button */}
      <button
        onClick={() => fileInputRef.current?.click()}
        style={{
          position: 'absolute',
          bottom: 24,
          right: 24,
          background: 'rgba(14,21,37,0.9)',
          border: '1px solid rgba(184,148,58,0.4)',
          color: '#D4B060',
          fontFamily: "'Space Mono', monospace",
          fontSize: '9px',
          letterSpacing: '.12em',
          textTransform: 'uppercase',
          padding: '10px 18px',
          borderRadius: '3px',
          cursor: 'pointer',
          zIndex: 20,
        }}
      >
        + Import Book
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.epub"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* Import modal */}
      {showImportModal && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(6,12,24,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 30 }}>

          {/* Step 1 — form */}
          {importStep === 'form' && (
            <div style={{ background: '#0E1525', border: '1px solid rgba(184,148,58,0.2)', borderRadius: '6px', padding: '32px', width: '380px' }}>
              <div style={{ fontFamily: "'Cinzel',serif", fontSize: '16px', color: '#D4B060', marginBottom: '24px' }}>
                Import Book
              </div>
              <div style={{ marginBottom: '14px' }}>
                <label style={labelStyle}>Title *</label>
                <input value={importTitle} onChange={(e) => setImportTitle(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ marginBottom: '24px' }}>
                <label style={labelStyle}>Author</label>
                <input value={importAuthor} onChange={(e) => setImportAuthor(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button onClick={closeImportModal} style={cancelBtnStyle}>Cancel</button>
                <button onClick={handleImportSubmit} disabled={!importTitle || importing} style={{ ...actionBtnStyle, opacity: !importTitle || importing ? 0.5 : 1 }}>
                  {importing ? 'Importing…' : 'Import →'}
                </button>
              </div>
            </div>
          )}

          {/* Step 2 — section review */}
          {importStep === 'review' && importResult && (
            <div style={{ background: '#0E1525', border: '1px solid rgba(184,148,58,0.2)', borderRadius: '6px', padding: '32px', width: '520px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
              <div style={{ marginBottom: '6px', fontFamily: "'Cinzel',serif", fontSize: '16px', color: '#D4B060' }}>
                {importResult.title}
              </div>
              {importResult.author && (
                <div style={{ fontFamily: "'Space Mono',monospace", fontSize: '9px', color: '#6B6352', letterSpacing: '.1em', marginBottom: '20px' }}>
                  {importResult.author}
                </div>
              )}

              <div style={{ fontFamily: "'Space Mono',monospace", fontSize: '8px', letterSpacing: '.14em', textTransform: 'uppercase', color: '#B8943A', marginBottom: '12px' }}>
                {importResult.sections.length} sections detected
              </div>

              {/* Section list */}
              <div style={{ flex: 1, overflowY: 'auto', marginBottom: '20px', borderTop: '1px solid rgba(184,148,58,0.1)' }}>
                {importResult.sections.map((sec) => (
                  <div key={sec.id} style={{ display: 'flex', alignItems: 'baseline', gap: '12px', padding: '8px 0', borderBottom: '1px solid rgba(184,148,58,0.06)' }}>
                    <span style={{ fontFamily: "'Space Mono',monospace", fontSize: '9px', color: '#6B6352', minWidth: '28px', flexShrink: 0 }}>
                      §{sec.ordinal}
                    </span>
                    <span style={{ flex: 1, color: '#C8BC9E', fontSize: '14px' }}>
                      {sec.title ?? `Section ${sec.ordinal}`}
                    </span>
                    {sec.word_count != null && (
                      <span style={{ fontFamily: "'Space Mono',monospace", fontSize: '8px', color: '#6B6352', flexShrink: 0 }}>
                        {sec.word_count.toLocaleString()} w
                      </span>
                    )}
                  </div>
                ))}
              </div>

              <div style={{ fontSize: '12px', color: '#6B6352', fontStyle: 'italic', marginBottom: '20px' }}>
                You can rename or split sections inside the workflow before extraction runs.
              </div>

              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button onClick={closeImportModal} style={cancelBtnStyle}>Close</button>
                <button
                  onClick={() => { closeImportModal(); onExplore(importResult.id) }}
                  style={actionBtnStyle}
                >
                  Begin pipeline →
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}
