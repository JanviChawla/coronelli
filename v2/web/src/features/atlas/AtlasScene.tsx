import { useEffect, useRef, useState, type CSSProperties } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  type AtlasData,
  type Place,
  getAtlas,
  patchPlace,
  addClaim,
  deleteClaim,
} from '../../api/client'
import { geoForKind, tierY, defaultColorForTier } from './geoForKind'

interface NodeData {
  id: string
  group: THREE.Group
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  shadow: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  label: HTMLDivElement
  baseY: number
  phase: number
  rotSpeed: number
  firstOrdinal: number
  radius: number
}

interface Props {
  documentId: string
  onClose: () => void
}

const SPATIAL_PREDICATES = ['CONTAINS', 'LOCATED_IN', 'LEADS_TO', 'PORTAL_TO', 'PART_OF', 'BORDERS', 'FLOWS_THROUGH']

export default function AtlasScene({ documentId, onClose }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)
  const nodesRef = useRef<NodeData[]>([])
  const selectedIdRef = useRef<string | null>(null)

  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null)
  const [atlasData, setAtlasData] = useState<AtlasData | null>(null)
  const [revealUpTo, setRevealUpTo] = useState(9999)
  const [sectionCount, setSectionCount] = useState(1)
  const [error, setError] = useState<string | null>(null)

  // Edit-mode state
  const [editMode, setEditMode] = useState(false)
  const [editName, setEditName] = useState('')
  const [editKind, setEditKind] = useState('')
  const [editTier, setEditTier] = useState('surface')
  const [editNote, setEditNote] = useState('')
  const [saving, setSaving] = useState(false)

  // New-connection form state
  const [newPredicate, setNewPredicate] = useState('CONTAINS')
  const [newTargetId, setNewTargetId] = useState('')

  const reloadAtlas = async () => {
    const fresh = await getAtlas(documentId)
    setAtlasData(fresh)
    const selId = selectedIdRef.current
    if (selId) {
      const updated = fresh.places.find((p) => p.id === selId)
      setSelectedPlace(updated ?? null)
    }
  }

  // Populate edit fields whenever the selected place changes
  useEffect(() => {
    if (selectedPlace) {
      setEditName(selectedPlace.name)
      setEditKind(selectedPlace.kind_descriptor ?? selectedPlace.kind ?? '')
      setEditTier(selectedPlace.tier ?? 'surface')
      setEditNote(selectedPlace.note ?? '')
      setEditMode(false)
    }
  }, [selectedPlace?.id])

  // Load data
  useEffect(() => {
    getAtlas(documentId)
      .then((data) => {
        setAtlasData(data)
        const ordinals = data.places.map((p) => p.first_section_ordinal ?? 0)
        const max = Math.max(...ordinals, 1)
        setSectionCount(max)
        setRevealUpTo(max)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [documentId])

  // Three.js setup + scene population
  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !atlasData) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x060c18)
    scene.fog = new THREE.FogExp2(0x060c18, 0.024)

    const realm = atlasData.places.find((p) => p.spatial_level === 0)
    if (realm?.palette?.[0]) {
      const atmColor = new THREE.Color(0x060c18).lerp(new THREE.Color(realm.palette[0].hex), 0.12)
      scene.background = atmColor
      scene.fog = new THREE.FogExp2(atmColor.getHex(), 0.024)
      renderer.setClearColor(atmColor, 1)
    }

    const camera = new THREE.PerspectiveCamera(60, mount.clientWidth / mount.clientHeight, 0.1, 200)
    camera.position.set(0, 10, 20)

    // Stars
    const starGeo = new THREE.BufferGeometry()
    const sp: number[] = []
    for (let i = 0; i < 900; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const r = 55 + Math.random() * 5
      sp.push(r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi))
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3))
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.18, fog: false })))

    scene.add(new THREE.AmbientLight(0x334477, 0.5))
    const dirLight = new THREE.DirectionalLight(0xfff8e8, 1.2)
    dirLight.position.set(5, 10, 5)
    scene.add(dirLight)

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshBasicMaterial({ color: 0x080e1c, transparent: true, opacity: 0.4 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.03
    scene.add(ground)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.05

    const labelContainer = document.createElement('div')
    labelContainer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;'
    mount.appendChild(labelContainer)

    const nodes: NodeData[] = []
    const placeMap = new Map(atlasData.places.map((p) => [p.id, p]))

    atlasData.places
      .filter((p) => !p.is_edge && p.status === 'confirmed')
      .forEach((place) => {
        const pos = atlasData.positions[place.id]
        if (!pos) return

        const geo = geoForKind(place.kind_descriptor ?? place.kind ?? '')
        const colorHex = place.palette?.[0]?.hex ?? defaultColorForTier(place.tier)
        const color = new THREE.Color(colorHex)

        const mat = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.22,
          roughness: 0.6,
          metalness: 0.15,
          transparent: true,
          opacity: 1,
        })

        const mesh = new THREE.Mesh(geo, mat)
        const group = new THREE.Group()
        group.add(mesh)

        const y = tierY(place.tier)
        group.position.set(pos.x, y, pos.z)

        const shadowMat = new THREE.MeshBasicMaterial({
          color: 0x000000,
          transparent: true,
          opacity: 0.18,
          depthWrite: false,
        })
        const shadowMesh = new THREE.Mesh(new THREE.CircleGeometry(0.8, 12), shadowMat)
        shadowMesh.rotation.x = -Math.PI / 2
        shadowMesh.position.y = -y - 0.016
        group.add(shadowMesh)

        scene.add(group)

        const label = document.createElement('div')
        label.textContent = place.name
        label.style.cssText = `
          position:absolute;
          font-family:'Cinzel',serif;
          font-size:10px;
          color:rgba(200,188,158,0.7);
          text-shadow:0 1px 3px #060C18;
          pointer-events:none;
          white-space:nowrap;
          transform:translate(-50%,-100%);
        `
        labelContainer.appendChild(label)

        nodes.push({
          id: place.id,
          group,
          mesh: mesh as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>,
          shadow: shadowMesh as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>,
          label,
          baseY: y,
          phase: Math.random() * Math.PI * 2,
          rotSpeed: 0.003 + Math.random() * 0.003,
          firstOrdinal: place.first_section_ordinal ?? 0,
          radius: 0.9,
        })
      })
    nodesRef.current = nodes

    // Build edges
    const containmentPoints: number[] = []
    const travelPoints: number[] = []

    for (const claim of atlasData.claims) {
      if (claim.claim_type !== 'spatial' || !claim.object_id) continue
      const subj = atlasData.positions[claim.subject_id]
      const obj = atlasData.positions[claim.object_id]
      if (!subj || !obj) continue

      const subY = tierY(placeMap.get(claim.subject_id)?.tier)
      const objY = tierY(placeMap.get(claim.object_id)?.tier)

      const isTravel = claim.predicate === 'LEADS_TO' || claim.predicate === 'PORTAL_TO'
      const arr = isTravel ? travelPoints : containmentPoints
      arr.push(subj.x, subY, subj.z, obj.x, objY, obj.z)
    }

    if (containmentPoints.length > 0) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(containmentPoints, 3))
      scene.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x8aabca, transparent: true, opacity: 0.25 })))
    }
    if (travelPoints.length > 0) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(travelPoints, 3))
      const mat = new THREE.LineDashedMaterial({ color: 0xd4b060, transparent: true, opacity: 0.45, dashSize: 0.3, gapSize: 0.15 })
      const lines = new THREE.LineSegments(geo, mat)
      lines.computeLineDistances()
      scene.add(lines)
    }

    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()

    const onClick = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      mouse.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(mouse, camera)
      const meshes = nodes.map((n) => n.mesh)
      const hits = raycaster.intersectObjects(meshes)
      if (hits.length > 0) {
        const nd = nodes.find((n) => n.mesh === hits[0].object)
        if (nd) {
          selectedIdRef.current = nd.id
          setSelectedPlace(placeMap.get(nd.id) ?? null)
        }
      } else {
        selectedIdRef.current = null
        setSelectedPlace(null)
      }
    }
    renderer.domElement.addEventListener('click', onClick)

    let t = 0
    const camTarget = new THREE.Vector3()

    const animate = () => {
      rafRef.current = requestAnimationFrame(animate)
      t += 0.016

      for (const nd of nodesRef.current) {
        const dy = Math.sin(t * 0.72 + nd.phase) * 0.07
        nd.group.position.y = nd.baseY + dy

        const isSelected = nd.id === selectedIdRef.current
        if (!isSelected) nd.mesh.rotation.y += nd.rotSpeed

        if (isSelected) {
          nd.mesh.material.emissiveIntensity = 0.52 + Math.sin(t * 2.8) * 0.18
        }

        const heightAboveGround = Math.max(0, nd.baseY)
        nd.shadow.material.opacity = Math.max(0, 0.22 - Math.abs(dy) * 0.5 - heightAboveGround * 0.018)

        const visible = nd.firstOrdinal <= revealUpTo
        nd.mesh.material.opacity = visible ? 1 : 0.15
        nd.label.style.display = visible ? 'block' : 'none'

        const worldPos = new THREE.Vector3()
        nd.group.getWorldPosition(worldPos)
        const projected = worldPos.clone().project(camera)
        if (projected.z < 1) {
          const x = ((projected.x + 1) / 2) * renderer.domElement.clientWidth
          const y = ((-projected.y + 1) / 2) * renderer.domElement.clientHeight
          nd.label.style.left = `${x}px`
          nd.label.style.top = `${y - 10}px`
          nd.label.style.display = visible ? 'block' : 'none'
        } else {
          nd.label.style.display = 'none'
        }
      }

      if (selectedIdRef.current) {
        const nd = nodesRef.current.find((n) => n.id === selectedIdRef.current)
        if (nd) {
          camTarget.lerp(nd.group.position, 0.04)
          controls.target.lerp(camTarget, 0.04)
        }
      }

      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', onResize)
      renderer.domElement.removeEventListener('click', onClick)
      controls.dispose()
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
      if (mount.contains(labelContainer)) mount.removeChild(labelContainer)
      for (const nd of nodesRef.current) {
        nd.group.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose()
            if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose())
            else obj.material.dispose()
          }
        })
      }
      nodesRef.current = []
    }
  }, [atlasData, revealUpTo])

  const connections = atlasData
    ? atlasData.claims.filter(
        (c) => c.claim_type === 'spatial' && (c.subject_id === selectedPlace?.id || c.object_id === selectedPlace?.id),
      )
    : []

  const otherPlaces = atlasData
    ? atlasData.places.filter((p) => !p.is_edge && p.id !== selectedPlace?.id)
    : []

  const handleSave = async () => {
    if (!selectedPlace) return
    setSaving(true)
    try {
      await patchPlace(selectedPlace.id, {
        name: editName || undefined,
        kind_descriptor: editKind || undefined,
        tier: (editTier as Place['tier']) || undefined,
        note: editNote || undefined,
      })
      await reloadAtlas()
      setEditMode(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteClaim = async (claimId: string) => {
    try {
      await deleteClaim(claimId)
      await reloadAtlas()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleAddClaim = async () => {
    if (!selectedPlace || !newTargetId) return
    try {
      await addClaim(documentId, {
        claim_type: 'spatial',
        subject_id: selectedPlace.id,
        predicate: newPredicate,
        object_id: newTargetId,
      })
      setNewTargetId('')
      await reloadAtlas()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const panelStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '300px',
    height: '100%',
    background: 'rgba(8,14,28,0.94)',
    borderRight: '1px solid rgba(184,148,58,0.14)',
    padding: '28px 20px',
    overflowY: 'auto',
    zIndex: 30,
    boxSizing: 'border-box',
  }

  const labelStyle: CSSProperties = {
    fontFamily: "'Space Mono',monospace",
    fontSize: '8px',
    color: '#6B6352',
    letterSpacing: '.1em',
    textTransform: 'uppercase',
    marginBottom: '4px',
  }

  const inputStyle: CSSProperties = {
    width: '100%',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(184,148,58,0.2)',
    color: '#C8BC9E',
    fontFamily: "'Space Mono',monospace",
    fontSize: '11px',
    padding: '5px 8px',
    borderRadius: '2px',
    marginBottom: '10px',
    boxSizing: 'border-box',
  }

  const btnStyle: CSSProperties = {
    background: 'transparent',
    border: '1px solid rgba(184,148,58,0.2)',
    color: '#6B6352',
    fontFamily: "'Space Mono',monospace",
    fontSize: '8px',
    letterSpacing: '.1em',
    padding: '5px 10px',
    borderRadius: '2px',
    cursor: 'pointer',
  }

  const btnGoldStyle: CSSProperties = {
    ...btnStyle,
    borderColor: 'rgba(184,148,58,0.5)',
    color: '#D4B060',
  }

  const dividerStyle: CSSProperties = {
    borderTop: '1px solid rgba(184,148,58,0.1)',
    margin: '14px 0',
  }

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 25 }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />

      {/* Close */}
      <button
        onClick={onClose}
        style={{ position: 'absolute', top: 16, right: 20, background: 'transparent', border: 'none', color: '#6B6352', fontSize: '22px', cursor: 'pointer', zIndex: 30 }}
      >
        ×
      </button>

      {/* Detail / Edit panel */}
      {selectedPlace && (
        <div style={panelStyle}>
          {!editMode ? (
            <>
              {/* View mode */}
              <div style={{ fontFamily: "'Cinzel',serif", fontSize: '16px', color: '#D4B060', marginBottom: '4px' }}>
                {selectedPlace.name}
              </div>
              {selectedPlace.kind_descriptor && (
                <div style={{ fontFamily: "'Space Mono',monospace", fontSize: '9px', color: '#6B6352', marginBottom: '12px' }}>
                  {selectedPlace.kind_descriptor}
                </div>
              )}
              {selectedPlace.tier && (
                <div style={{ fontFamily: "'Space Mono',monospace", fontSize: '9px', color: '#6B6352', marginBottom: '8px' }}>
                  tier: {selectedPlace.tier}
                </div>
              )}
              {selectedPlace.note && (
                <div style={{ fontSize: '13px', color: '#C8BC9E', fontStyle: 'italic', marginBottom: '12px', lineHeight: 1.5 }}>
                  {selectedPlace.note}
                </div>
              )}
              {selectedPlace.palette && selectedPlace.palette.length > 0 && (
                <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
                  {selectedPlace.palette.map((sw) => (
                    <div
                      key={sw.hex}
                      title={sw.label}
                      style={{ width: '20px', height: '20px', borderRadius: '2px', background: sw.hex, border: '1px solid rgba(255,255,255,0.1)' }}
                    />
                  ))}
                </div>
              )}

              {connections.length > 0 && (
                <>
                  <div style={dividerStyle} />
                  <div style={{ ...labelStyle, marginBottom: '8px' }}>Connections</div>
                  {connections.map((c) => {
                    const otherId = c.subject_id === selectedPlace.id ? c.object_id : c.subject_id
                    const other = otherId ? atlasData?.places.find((p) => p.id === otherId) : null
                    return (
                      <div key={c.id} style={{ fontSize: '12px', color: '#C8BC9E', marginBottom: '5px' }}>
                        <span style={{ color: '#6B6352', fontFamily: "'Space Mono',monospace", fontSize: '9px' }}>
                          {c.predicate}
                        </span>{' '}
                        {other?.name ?? otherId}
                      </div>
                    )
                  })}
                </>
              )}

              <div style={dividerStyle} />
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => setEditMode(true)} style={btnGoldStyle}>Edit</button>
                <button
                  onClick={() => { selectedIdRef.current = null; setSelectedPlace(null) }}
                  style={btnStyle}
                >
                  Deselect
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Edit mode */}
              <div style={{ ...labelStyle, marginBottom: '12px', color: '#D4B060' }}>Editing place</div>

              <div style={labelStyle}>Name</div>
              <input
                style={inputStyle}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />

              <div style={labelStyle}>Kind / descriptor</div>
              <input
                style={inputStyle}
                value={editKind}
                onChange={(e) => setEditKind(e.target.value)}
              />

              <div style={labelStyle}>Tier</div>
              <select
                style={{ ...inputStyle, marginBottom: '10px' }}
                value={editTier}
                onChange={(e) => setEditTier(e.target.value)}
              >
                {['peak', 'elevated', 'surface', 'underground', 'deep'].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>

              <div style={labelStyle}>Note</div>
              <textarea
                style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }}
                value={editNote}
                onChange={(e) => setEditNote(e.target.value)}
              />

              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                <button onClick={handleSave} disabled={saving} style={btnGoldStyle}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button onClick={() => setEditMode(false)} style={btnStyle}>Cancel</button>
              </div>

              <div style={dividerStyle} />
              <div style={{ ...labelStyle, marginBottom: '8px' }}>Spatial connections</div>

              {connections.length === 0 && (
                <div style={{ fontSize: '11px', color: '#6B6352', marginBottom: '10px' }}>None</div>
              )}
              {connections.map((c) => {
                const otherId = c.subject_id === selectedPlace.id ? c.object_id : c.subject_id
                const other = otherId ? atlasData?.places.find((p) => p.id === otherId) : null
                return (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontSize: '11px', color: '#C8BC9E' }}>
                      <span style={{ color: '#6B6352', fontFamily: "'Space Mono',monospace", fontSize: '8px' }}>
                        {c.predicate}
                      </span>{' '}
                      {other?.name ?? otherId}
                    </span>
                    <button
                      onClick={() => handleDeleteClaim(c.id)}
                      style={{ ...btnStyle, padding: '2px 7px', fontSize: '10px', color: '#7A3A3A', borderColor: 'rgba(122,58,58,0.3)' }}
                    >
                      ×
                    </button>
                  </div>
                )
              })}

              <div style={{ ...dividerStyle, marginTop: '10px' }} />
              <div style={{ ...labelStyle, marginBottom: '8px' }}>Add connection</div>

              <div style={labelStyle}>Predicate</div>
              <select
                style={{ ...inputStyle }}
                value={newPredicate}
                onChange={(e) => setNewPredicate(e.target.value)}
              >
                {SPATIAL_PREDICATES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>

              <div style={labelStyle}>Target place</div>
              <select
                style={{ ...inputStyle }}
                value={newTargetId}
                onChange={(e) => setNewTargetId(e.target.value)}
              >
                <option value="">— select —</option>
                {otherPlaces.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>

              <button
                onClick={handleAddClaim}
                disabled={!newTargetId}
                style={{ ...btnGoldStyle, opacity: newTargetId ? 1 : 0.4 }}
              >
                Add →
              </button>
            </>
          )}
        </div>
      )}

      {/* Provenance scrubber */}
      <div
        style={{
          position: 'absolute',
          bottom: 16,
          left: selectedPlace ? '316px' : '16px',
          right: '16px',
          background: 'rgba(8,14,28,0.7)',
          borderRadius: '4px',
          padding: '10px 16px',
          zIndex: 30,
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <span style={{ fontFamily: "'Space Mono',monospace", fontSize: '8px', color: '#6B6352', letterSpacing: '.1em', whiteSpace: 'nowrap' }}>
          §1
        </span>
        <input
          type="range"
          min={1}
          max={sectionCount}
          value={revealUpTo}
          onChange={(e) => setRevealUpTo(Number(e.target.value))}
          style={{ flex: 1, accentColor: '#B8943A' }}
        />
        <span style={{ fontFamily: "'Space Mono',monospace", fontSize: '8px', color: '#6B6352', letterSpacing: '.1em', whiteSpace: 'nowrap' }}>
          §{sectionCount}
        </span>
      </div>

      {error && (
        <div style={{ position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)', background: 'rgba(154,74,74,0.9)', padding: '8px 16px', borderRadius: '3px', fontSize: '12px', color: '#fff', zIndex: 40 }}>
          {error}
          <button onClick={() => setError(null)} style={{ marginLeft: '12px', background: 'none', border: 'none', color: '#fff', cursor: 'pointer' }}>×</button>
        </div>
      )}
    </div>
  )
}
