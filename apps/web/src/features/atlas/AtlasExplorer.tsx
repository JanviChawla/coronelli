import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { fetchAtlas, fetchEntityMentions } from './atlasApi'
import type { AtlasResponse, AtlasEntity } from './atlasApi'
import { TIER_Y, TIER_NODE_HEX, CONTAIN_RE, TRAVEL_RE, geoForKind, rForKind, easeOutBack } from './atlasExplorerUtils'
import { AtlasExplorerDetailPanel } from './AtlasExplorerDetailPanel'
import { AtlasExplorerOverlays } from './AtlasExplorerOverlays'

interface Props {
  documentId: string
  sections: Array<{ id: string; title: string }>
  onAtlasLoaded: (entityCount: number) => void
}

// ── Main component ────────────────────────────────────────────────────────────

export function AtlasExplorer({ documentId, onAtlasLoaded }: Props) {
  const canvasRef       = useRef<HTMLCanvasElement>(null)
  const labelsRef       = useRef<HTMLDivElement>(null)
  const selectedIdRef   = useRef<string | null>(null)
  const revealUpToRef   = useRef<number>(9999)
  const ordinalMapRef   = useRef<Map<string, number>>(new Map())

  const [atlas, setAtlas]           = useState<AtlasResponse | null>(null)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [revealUpTo, setRevealUpTo] = useState(9999)
  const [sectionCount, setSectionCount] = useState(1)

  useEffect(() => {
    setLoading(true); setError(null); setAtlas(null)
    Promise.all([
      fetchAtlas(documentId),
      fetchEntityMentions(documentId).catch(() => []),
    ]).then(([atlasData, mentions]) => {
      // Build entity → earliest section ordinal map
      const om = new Map<string, number>()
      for (const m of mentions) {
        const cur = om.get(m.entity_id)
        if (cur === undefined || m.section_ordinal < cur) om.set(m.entity_id, m.section_ordinal)
      }
      ordinalMapRef.current = om
      const maxOrdinal = mentions.length > 0 ? Math.max(...mentions.map(m => m.section_ordinal)) : 1
      setSectionCount(maxOrdinal)
      setRevealUpTo(maxOrdinal)
      revealUpToRef.current = maxOrdinal
      setAtlas(atlasData)
      onAtlasLoaded(atlasData.entity_count)
    }).catch(e => { setError(String(e)) })
      .finally(() => setLoading(false))
  }, [documentId, onAtlasLoaded])

  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  // ── Three.js scene ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!atlas || !canvasRef.current || !labelsRef.current) return

    const canvas   = canvasRef.current
    const labelsEl = labelsRef.current
    let animFrame: number
    let t = 0

    // ── Renderer (placeholder color — updated after L0 palette is known) ──────
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x060C18, 1)

    const scene  = new THREE.Scene()
    scene.fog    = new THREE.FogExp2(0x060C18, 0.024)
    const camera = new THREE.PerspectiveCamera(44, canvas.clientWidth / canvas.clientHeight, 0.1, 80)

    // ── Lighting (permanent) ──────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0x0A1828, 1.2))
    const sun = new THREE.PointLight(0xD4B060, 1.4, 45); sun.position.set(4, 10, 5); scene.add(sun)
    const fill = new THREE.PointLight(0x3A608A, 0.6, 28); fill.position.set(-5, -3, -4); scene.add(fill)

    // ── Elevation planes (permanent) ─────────────────────────────────────────
    for (const { y, c, o } of [
      { y: 4.2, c: 0x1A2A40, o: 0.10 }, { y: 2.5, c: 0x281A08, o: 0.11 },
      { y: 0.0, c: 0x0A180A, o: 0.14 }, { y: -2., c: 0x0A0A18, o: 0.12 },
      { y: -4.5,c: 0x100008, o: 0.09 },
    ]) {
      const g = new THREE.PlaneGeometry(32, 32); g.rotateX(-Math.PI / 2)
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, side: THREE.DoubleSide, depthWrite: false }))
      m.position.y = y; scene.add(m)
    }

    // ── Star field (permanent, fog:false so stars stay sharp) ────────────────
    ;(() => {
      const n = 900, v = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), r = 52 + Math.random() * 8
        v[i*3] = r*Math.sin(ph)*Math.cos(th); v[i*3+1] = r*Math.sin(ph)*Math.sin(th); v[i*3+2] = r*Math.cos(ph)
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
      scene.add(new THREE.Points(g, new THREE.PointsMaterial({
        color: 0xE8E8FF, size: 0.07, transparent: true, opacity: 0.75,
        sizeAttenuation: true, fog: false,
      })))
    })()

    // ── Entity data ───────────────────────────────────────────────────────────
    const entities  = atlas.entities
    const entityMap = new Map(entities.map(e => [e.id, e]))

    // ── Spatial-level classification ──────────────────────────────────────────
    function getSL(id: string) { return (entityMap.get(id)?.payload.spatial_level as number) ?? 2 }
    const l0Set = new Set(entities.filter(e => getSL(e.id) === 0).map(e => e.id))
    const l1Set = new Set(entities.filter(e => getSL(e.id) === 1).map(e => e.id))
    const l3Set = new Set(entities.filter(e => getSL(e.id) === 3).map(e => e.id))

    // ── Topology layout — positions from tier + containment hierarchy ─────────
    const edges: Array<{ sid: string; oid: string; pred: string }> = []
    const edgeSeen = new Set<string>()
    for (const entity of entities) {
      for (const claim of entity.claims) {
        if (!claim.predicate || !claim.subject_ref || !claim.object_refs?.length) continue
        const sid = claim.subject_ref, oid = claim.object_refs[0]
        if (!entityMap.has(sid) || !entityMap.has(oid) || sid === oid) continue
        const key = `${sid}|${claim.predicate}|${oid}`
        if (edgeSeen.has(key)) continue; edgeSeen.add(key)
        edges.push({ sid, oid, pred: claim.predicate })
      }
    }

    // Build containment hierarchy (LOCATED_IN / CONTAINS), skip cycles
    const parentOf = new Map<string, string>()
    const childrenOf = new Map<string, string[]>()
    for (const e of entities) childrenOf.set(e.id, [])

    const wouldCycle = (childId: string, newParentId: string): boolean => {
      let cur: string | undefined = newParentId
      while (cur) { if (cur === childId) return true; cur = parentOf.get(cur) }
      return false
    }
    for (const edge of edges) {
      if (/LOCATED_IN/.test(edge.pred) && !parentOf.has(edge.sid) && !wouldCycle(edge.sid, edge.oid)) {
        parentOf.set(edge.sid, edge.oid); childrenOf.get(edge.oid)?.push(edge.sid)
      } else if (/CONTAINS/.test(edge.pred) && !parentOf.has(edge.oid) && !wouldCycle(edge.oid, edge.sid)) {
        parentOf.set(edge.oid, edge.sid); childrenOf.get(edge.sid)?.push(edge.oid)
      }
    }

    const positions = new Map<string, THREE.Vector3>()

    // Walk up parentOf to find the first ancestor with an explicit tier
    const resolvedTier = (id: string): string => {
      let cur: string | undefined = id
      while (cur) {
        const t = (entityMap.get(cur)?.payload.tier as string) ?? ''
        if (t) return t
        cur = parentOf.get(cur)
      }
      return 'surface'
    }

    // Children at a different tier from their parent snap to parent X/Z (appear directly above/below).
    // Children at the same tier spread on a radial ring as before.
    const placeSubtree = (ids: string[], ox: number, oz: number, radius: number, phaseOff: number, parentTier: string | null = null) => {
      const sameTier = ids.filter(id => parentTier === null || resolvedTier(id) === parentTier)
      const diffTier = ids.filter(id => parentTier !== null && resolvedTier(id) !== parentTier)

      const recurse = (id: string, px: number, pz: number) => {
        const tier = resolvedTier(id)
        positions.set(id, new THREE.Vector3(px, TIER_Y[tier] ?? 0, pz))
        const children = childrenOf.get(id) ?? []
        if (children.length) {
          const level = getSL(id)
          const childR = level >= 2
            ? Math.max(1.1, radius * 0.38)
            : Math.max(2.5, radius * 0.52)
          placeSubtree(children, px, pz, childR, phaseOff + 0.45, tier)
        }
      }

      // Same-tier: spread radially
      sameTier.forEach((id, i) => {
        const angle = (i / Math.max(sameTier.length, 1)) * Math.PI * 2 + phaseOff
        recurse(id, ox + Math.cos(angle) * radius, oz + Math.sin(angle) * radius)
      })

      // Different-tier: snap to parent X/Z; tiny spread only when multiple
      const diffR = diffTier.length > 1 ? 0.5 : 0
      diffTier.forEach((id, i) => {
        const angle = (i / Math.max(diffTier.length, 1)) * Math.PI * 2 + phaseOff
        recurse(id, ox + (diffR > 0 ? Math.cos(angle) * diffR : 0), oz + (diffR > 0 ? Math.sin(angle) * diffR : 0))
      })
    }

    const rootIds = entities.filter(e => !parentOf.has(e.id)).map(e => e.id)
    const rootRadius = Math.max(3.5, rootIds.length * 0.95)
    placeSubtree(rootIds, 0, 0, rootRadius, 0, null)

    // Entities orphaned by cycle removal → outer ring
    let oi = 0
    for (const e of entities) {
      if (positions.has(e.id)) continue
      const angle = (oi++ / Math.max(entities.length, 1)) * Math.PI * 2
      const tier = resolvedTier(e.id)
      positions.set(e.id, new THREE.Vector3(Math.cos(angle) * (rootRadius + 2), TIER_Y[tier] ?? 0, Math.sin(angle) * (rootRadius + 2)))
    }

    // Bounding centre + max radius after layout
    let cx = 0, cz = 0
    for (const e of entities) { const p = positions.get(e.id)!; cx += p.x; cz += p.z }
    cx = entities.length ? cx / entities.length : 0
    cz = entities.length ? cz / entities.length : 0
    let maxR = 0
    for (const e of entities) { const p = positions.get(e.id)!; const r = Math.sqrt((p.x-cx)**2 + (p.z-cz)**2); if (r > maxR) maxR = r }

    // ── L0 atmosphere — tint background/fog with realm palette ───────────────
    const atmBase = new THREE.Color(0x060C18)
    let atmColor = atmBase.clone()
    for (const l0e of entities.filter(e => l0Set.has(e.id))) {
      const vcCols = l0e.claims
        .filter(c => c.claim_type === 'visual')
        .flatMap(c => (c.payload.palette as Array<{ color?: string; hex?: string; c?: string }> | null) ?? [])
      const hex = vcCols[0]?.color ?? vcCols[0]?.hex ?? vcCols[0]?.c
      if (hex) { try { atmColor = atmBase.clone().lerp(new THREE.Color(hex), 0.12) } catch { /* skip */ } break }
    }
    renderer.setClearColor(atmColor, 1)
    scene.fog = new THREE.FogExp2(atmColor.getHex(), 0.024)

    // ── Ground pad ────────────────────────────────────────────────────────────
    const padW = (maxR + 2) * 2, padD = padW
    const padGeo = new THREE.PlaneGeometry(padW, padD); padGeo.rotateX(-Math.PI / 2)
    const padMesh = new THREE.Mesh(padGeo, new THREE.MeshBasicMaterial({ color: 0x0A100A, transparent: true, opacity: 0.20, depthWrite: false, side: THREE.DoubleSide }))
    padMesh.position.set(cx, -0.03, cz); scene.add(padMesh)

    // ── L1 territory planes ───────────────────────────────────────────────────
    const l1Colliders: THREE.Mesh[] = []

    function getDescendants(id: string): string[] {
      const result: string[] = []
      const q = [...(childrenOf.get(id) ?? [])]
      while (q.length) {
        const c = q.shift()!
        result.push(c)
        ;(childrenOf.get(c) ?? []).forEach(x => q.push(x))
      }
      return result
    }

    for (const entity of entities.filter(e => l1Set.has(e.id))) {
      const center = positions.get(entity.id)
      if (!center) continue
      const desc = getDescendants(entity.id)
      let hullR = 2.5
      for (const cid of desc) {
        const p = positions.get(cid)
        if (!p) continue
        const d = Math.sqrt((p.x - center.x) ** 2 + (p.z - center.z) ** 2)
        if (d + 2.0 > hullR) hullR = d + 2.0
      }
      const vcCols = entity.claims
        .filter(c => c.claim_type === 'visual')
        .flatMap(c => (c.payload.palette as Array<{ color?: string; hex?: string; c?: string }> | null) ?? [])
      const rawHex = vcCols[0]?.color ?? vcCols[0]?.hex ?? vcCols[0]?.c ?? TIER_NODE_HEX[(entity.payload.tier as string)] ?? '#C8BC9E'
      const planeColor = new THREE.Color(rawHex)

      // Fill circle
      const fillGeo = new THREE.CircleGeometry(hullR, 48); fillGeo.rotateX(-Math.PI / 2)
      const fillMesh = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: planeColor, transparent: true, opacity: 0.11, depthWrite: false, side: THREE.DoubleSide }))
      fillMesh.position.set(center.x, -0.02, center.z)
      scene.add(fillMesh)

      // Rim ring
      const rimGeo = new THREE.RingGeometry(hullR - 0.08, hullR + 0.35, 48); rimGeo.rotateX(-Math.PI / 2)
      const rimMesh = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({ color: planeColor, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }))
      rimMesh.position.set(center.x, -0.015, center.z)
      scene.add(rimMesh)

      // Invisible collider for raycasting
      const colGeo = new THREE.CylinderGeometry(hullR, hullR, 0.12, 32)
      const colMesh = new THREE.Mesh(colGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
      colMesh.position.set(center.x, -0.02, center.z)
      colMesh.userData = { id: entity.id, isL1: true }
      scene.add(colMesh)
      l1Colliders.push(colMesh)
    }

    // ── Node groups ───────────────────────────────────────────────────────────
    interface NodeData {
      id: string; group: THREE.Group; shadow: THREE.Mesh
      phase: number; rotSpeed: number; baseY: number
      coreMat: THREE.MeshPhongMaterial; r: number
      provenanceOrdinal: number
      baseOpacity: number
    }
    const nodeData: NodeData[] = []
    const nodeById = new Map<string, NodeData>()
    const activeMeshes: THREE.Mesh[] = []   // invisible colliders for raycasting

    const sortedByR = [...entities].sort((a, b) => rForKind((b.payload.kind_descriptor as string) ?? '') - rForKind((a.payload.kind_descriptor as string) ?? ''))
    const topIds = new Set(sortedByR.slice(0, 4).map(e => e.id))

    const GROW_DUR = 0.42
    let isGrowing = true; const growStart = performance.now() / 1000

    for (const entity of entities) {
      // L0 realms color the atmosphere; L1 territories are ground planes — neither gets a node
      if (l0Set.has(entity.id) || l1Set.has(entity.id)) continue

      const kindDesc    = (entity.payload.kind_descriptor as string) ?? entity.place_kind ?? 'building'
      const tier        = resolvedTier(entity.id)
      const directChildren = childrenOf.get(entity.id) ?? []
      const hasChildren = directChildren.length > 0
      const descCount   = getDescendants(entity.id).length
      const isL3        = l3Set.has(entity.id)
      // Containers grow proportionally to how much they hold (capped at 2×)
      const containerBoost = descCount > 0 ? Math.min(1 + descCount * 0.14, 2.0) : 1

      // Palette lives on visual claims (claim_type='visual'), not on the entity payload
      const vcColors   = entity.claims
        .filter(c => c.claim_type === 'visual')
        .flatMap(c => (c.payload.palette as Array<{ color?: string; hex?: string; c?: string }> | null) ?? [])
      const rawHex     = vcColors[0]?.color ?? vcColors[0]?.hex ?? vcColors[0]?.c ?? TIER_NODE_HEX[tier] ?? '#C8BC9E'
      const col        = new THREE.Color(rawHex)
      const r          = rForKind(kindDesc)
      const effectiveR = (isL3 ? r * 0.65 : r) * containerBoost
      const pos        = positions.get(entity.id)!

      // Shadow blob — smaller and subtler for L3 features; reduced opacity for L2 containers
      const shadowR  = isL3 ? r * 1.0 : r * 1.5
      const shadowOp = isL3 ? 0.10 : hasChildren ? 0.12 : 0.18
      const sg = new THREE.CircleGeometry(shadowR, 14); sg.rotateX(-Math.PI / 2)
      const shadow = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: shadowOp, depthWrite: false }))
      shadow.position.set(pos.x, -0.016, pos.z); scene.add(shadow)

      // Node group
      const group = new THREE.Group()
      group.position.set(pos.x, pos.y, pos.z)
      group.userData = { id: entity.id }
      group.scale.setScalar(0)   // grow-in starts at 0

      // Core: use entity palette color; fall back to tier color when no visual claims
      const coreMat = new THREE.MeshPhongMaterial({
        color: col, emissive: col, emissiveIntensity: 0.18, shininess: 55,
        transparent: hasChildren && !isL3,
        opacity: hasChildren && !isL3 ? 0.38 : 1.0,
        side: hasChildren && !isL3 ? THREE.DoubleSide : THREE.FrontSide,
      })
      group.add(new THREE.Mesh(geoForKind(kindDesc), coreMat))

      // Inner halo
      group.add(new THREE.Mesh(new THREE.SphereGeometry(1.9, 12, 12),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide })))

      // Outer halo
      group.add(new THREE.Mesh(new THREE.SphereGeometry(3.0, 10, 10),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.04, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide })))

      // Cage wireframe for L2 container nodes (signals "this holds things")
      if (hasChildren && !isL3) {
        group.add(new THREE.Mesh(
          new THREE.SphereGeometry(1.65, 7, 7),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.10, wireframe: true, depthWrite: false })
        ))
      }

      // Invisible collider — raycasting hits this, then reads parent.userData.id
      const cl = new THREE.Mesh(
        new THREE.SphereGeometry(1.55, 6, 6),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      )
      group.add(cl); activeMeshes.push(cl)

      scene.add(group)

      // Local point light on top-4 nodes (uses palette[0] colour, not node colour)
      if (topIds.has(entity.id)) {
        const lc = new THREE.Color(rawHex)
        const pl = new THREE.PointLight(lc, 0.42, r * 18)
        pl.position.copy(pos); scene.add(pl)
      }

      const nd: NodeData = {
        id: entity.id, group, shadow,
        phase: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() * 0.28 + 0.06) * (Math.random() < 0.5 ? 1 : -1),
        baseY: pos.y, coreMat, r: effectiveR,
        provenanceOrdinal: ordinalMapRef.current.get(entity.id) ?? 0,
        baseOpacity: hasChildren && !isL3 ? 0.38 : 1.0,
      }
      nodeData.push(nd); nodeById.set(entity.id, nd)
    }

    // ── Labels (imperative DOM, positioned every frame) ───────────────────────
    labelsEl.innerHTML = ''
    const labelEls = new Map<string, HTMLElement>()

    // L2/L3 node labels
    for (const entity of entities) {
      if (l0Set.has(entity.id) || l1Set.has(entity.id)) continue   // L0/L1 handled separately below
      const kindDesc = (entity.payload.kind_descriptor as string) ?? entity.place_kind ?? ''
      const d = document.createElement('div')
      d.style.cssText = 'position:absolute;transform:translate(-50%,calc(-100% - 10px));pointer-events:auto;cursor:pointer;white-space:nowrap;user-select:none;'
      d.innerHTML = `
        <span class="coronelli-pl-name" style="display:block;font-family:'Cinzel',serif;font-size:10px;letter-spacing:.06em;color:#C8BC9E;text-align:center;text-shadow:0 1px 6px #000,0 0 14px rgba(0,0,0,.9);transition:color .15s;">${entity.name}</span>
        <span style="display:block;font-family:'Space Mono',monospace;font-size:7.5px;color:#6B6352;text-align:center;text-transform:uppercase;letter-spacing:.05em;text-shadow:0 1px 4px #000;">${kindDesc}</span>
      `
      d.addEventListener('click', () => handleSelect(entity.id))
      labelsEl.appendChild(d); labelEls.set(entity.id, d)
    }

    // L1 territory labels — positioned at plane centre, all-caps with faded gold
    for (const entity of entities.filter(e => l1Set.has(e.id))) {
      const center = positions.get(entity.id)
      if (!center) continue
      const d = document.createElement('div')
      d.style.cssText = 'position:absolute;transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer;white-space:nowrap;user-select:none;'
      d.innerHTML = `
        <span class="coronelli-pl-name" style="display:block;font-family:'Cinzel',serif;font-size:9px;letter-spacing:.18em;color:#B8943A;text-align:center;text-shadow:0 1px 6px #000,0 0 14px rgba(0,0,0,.9);text-transform:uppercase;opacity:0.72;transition:color .15s,opacity .15s;">${entity.name}</span>
        <span style="display:block;font-family:'Space Mono',monospace;font-size:6.5px;color:#6B6352;text-align:center;text-transform:uppercase;letter-spacing:.10em;text-shadow:0 1px 4px #000;opacity:0.50;">territory</span>
      `
      d.addEventListener('click', () => handleSelect(entity.id))
      labelsEl.appendChild(d)
      labelEls.set(entity.id, d)
    }

    // ── Edge lines ────────────────────────────────────────────────────────────
    const travelEdges: THREE.Line[] = []
    const containEdges: THREE.Line[] = []
    const drawnEdge = new Set<string>()

    // YW edge palette; for a real multi-book system, key by book id
    const ep = [0xA89030, 0.42, 0x9A9030, 0.35, 0x5A5A6A, 0.20]

    for (const e of edges) {
      const key = [e.sid, e.oid].sort().join('||')
      if (drawnEdge.has(key)) continue; drawnEdge.add(key)
      const pa = positions.get(e.sid), pb = positions.get(e.oid)
      if (!pa || !pb) continue
      const isC = CONTAIN_RE.test(e.pred), isT = TRAVEL_RE.test(e.pred)
      const lc = (isC ? ep[0] : isT ? ep[2] : ep[4]) as number
      const lo = (isC ? ep[1] : isT ? ep[3] : ep[5]) as number
      const geo = new THREE.BufferGeometry().setFromPoints([pa.clone(), pb.clone()])
      if (isT) {
        const mat = new THREE.LineDashedMaterial({ color: lc, transparent: true, opacity: lo * 1.15, dashSize: 0.32, gapSize: 0.16 })
        const ln = new THREE.Line(geo, mat); ln.computeLineDistances()
        scene.add(ln); travelEdges.push(ln)
      } else {
        const mat = new THREE.LineBasicMaterial({ color: lc, transparent: true, opacity: lo })
        mat.userData = { baseOp: lo }
        const ln = new THREE.Line(geo, mat); scene.add(ln)
        if (isC) containEdges.push(ln)
      }
    }

    // ── Ambient motes ─────────────────────────────────────────────────────────
    const MC = 52
    // Derive mote color from aggregate entity palettes — gives a per-book tint
    let mR = 0, mG = 0, mB = 0, moteCount = 0
    for (const entity of entities) {
      const vcCols = entity.claims
        .filter(c => c.claim_type === 'visual')
        .flatMap(c => (c.payload.palette as Array<{ color?: string; hex?: string; c?: string }> | null) ?? [])
      const hex = vcCols[0]?.color ?? vcCols[0]?.hex ?? vcCols[0]?.c
      if (!hex) continue
      try { const c = new THREE.Color(hex); mR += c.r; mG += c.g; mB += c.b; moteCount++ } catch { /* skip */ }
    }
    const moteColor = moteCount > 0 ? new THREE.Color(mR / moteCount, mG / moteCount, mB / moteCount) : new THREE.Color(0xA8B858)
    const moteGeo = new THREE.BufferGeometry()
    const motePos = new Float32Array(MC * 3)
    const moteVel = new Float32Array(MC * 3)
    // Spread ±5 units from scene centre (matches artifact's fixed ±5 around camTarget)
    for (let i = 0; i < MC; i++) {
      motePos[i*3]   = cx + (Math.random() - 0.5) * 10
      motePos[i*3+1] = Math.random() * 7 - 1
      motePos[i*3+2] = cz + (Math.random() - 0.5) * 10
      moteVel[i*3]   = (Math.random() - 0.5) * 0.014
      moteVel[i*3+2] = (Math.random() - 0.5) * 0.014
    }
    moteGeo.setAttribute('position', new THREE.Float32BufferAttribute(motePos, 3))
    const moteMesh = new THREE.Points(moteGeo, new THREE.PointsMaterial({
      color: moteColor, size: 0.065, transparent: true, opacity: 0.50,
      sizeAttenuation: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }))
    scene.add(moteMesh)

    // ── Camera — close to scene like artifact ────────────────────────────────
    let az = 0.50, po = 1.05
    let dist = Math.max(6, maxR * 2.5 + 5)   // stays close; yw ~8, larger books ~12–15
    const camTarget = new THREE.Vector3(cx, 0, cz)

    function refreshCam() {
      camera.position.set(
        camTarget.x + dist * Math.sin(po) * Math.sin(az),
        camTarget.y + dist * Math.cos(po),
        camTarget.z + dist * Math.sin(po) * Math.cos(az),
      )
      camera.lookAt(camTarget)
    }
    refreshCam()

    // ── Selection / hover ─────────────────────────────────────────────────────
    let selId: string | null = null
    let hovId: string | null = null

    function setEmissive(id: string, v: number) {
      // L1 territory planes have no emissive material — skip
      if (l1Set.has(id)) return
      const nd = nodeById.get(id); if (nd) nd.coreMat.emissiveIntensity = v
    }
    function setLabelState(id: string, state: 'idle' | 'sel' | 'hov') {
      const nameSpan = labelEls.get(id)?.querySelector('.coronelli-pl-name') as HTMLElement | null
      if (!nameSpan) return
      if (l1Set.has(id)) {
        nameSpan.style.color = state === 'sel' ? '#D4B060' : state === 'hov' ? '#E8C87A' : '#B8943A'
        nameSpan.style.opacity = state === 'idle' ? '0.72' : '1'
      } else {
        nameSpan.style.color = state === 'sel' ? '#D4B060' : state === 'hov' ? '#ffffff' : '#C8BC9E'
      }
    }

    function handleSelect(id: string) {
      if (selId) { setEmissive(selId, 0.22); setLabelState(selId, hovId === selId ? 'hov' : 'idle') }
      selId = id; selectedIdRef.current = id
      setEmissive(id, 0.80)
      setLabelState(id, 'sel')
      setSelectedId(id)
    }
    function handleDeselect() {
      if (selId) { setEmissive(selId, 0.22); setLabelState(selId, hovId === selId ? 'hov' : 'idle') }
      selId = null; selectedIdRef.current = null; setSelectedId(null)
    }

    // ── Mouse events ──────────────────────────────────────────────────────────
    let pressing = false, dragging = false, lastMx = 0, lastMy = 0
    const ray = new THREE.Raycaster(), mpos = new THREE.Vector2()

    // Resolve hit id: L1 colliders store id on the mesh itself; node colliders on parent group
    function resolveHit(obj: THREE.Object3D): string {
      const direct = obj.userData.id as string | undefined
      return direct ?? (obj.parent!.userData.id as string)
    }

    function onMouseDown(e: MouseEvent) { pressing = true; dragging = false; lastMx = e.clientX; lastMy = e.clientY }
    function onMouseMove(e: MouseEvent) {
      if (!pressing) {
        const rect = canvas.getBoundingClientRect()
        mpos.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
        mpos.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
        ray.setFromCamera(mpos, camera)
        const allColliders = [...activeMeshes, ...l1Colliders]
        const hits = ray.intersectObjects(allColliders)
        const nh   = hits.length ? resolveHit(hits[0].object) : null
        if (nh !== hovId) {
          if (hovId) {
            setEmissive(hovId, hovId === selId ? 0.80 : 0.22)
            setLabelState(hovId, hovId === selId ? 'sel' : 'idle')
          }
          hovId = nh
          if (hovId) { setEmissive(hovId, 1.2); setLabelState(hovId, hovId === selId ? 'sel' : 'hov') }
          canvas.style.cursor = hovId ? 'pointer' : 'grab'
        }
        return
      }
      const dx = e.clientX - lastMx, dy = e.clientY - lastMy
      if (Math.abs(dx) + Math.abs(dy) > 4) dragging = true
      az -= dx * 0.005; po = Math.max(0.15, Math.min(Math.PI - 0.15, po + dy * 0.005))
      lastMx = e.clientX; lastMy = e.clientY; refreshCam()
    }
    function onMouseUp(e: MouseEvent) {
      if (!dragging) {
        const rect = canvas.getBoundingClientRect()
        mpos.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
        mpos.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
        ray.setFromCamera(mpos, camera)
        const allColliders = [...activeMeshes, ...l1Colliders]
        const hits = ray.intersectObjects(allColliders)
        if (hits.length) {
          handleSelect(resolveHit(hits[0].object))
        } else {
          const target = e.target as HTMLElement
          if (!target.closest('[data-dp]') && !target.closest('.coronelli-pl-name'))
            handleDeselect()
        }
      }
      pressing = false; dragging = false
    }
    function onWheel(e: WheelEvent) { dist = Math.max(3, Math.min(35, dist + e.deltaY * 0.022)); refreshCam() }

    canvas.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('wheel', onWheel, { passive: true })

    // ── Resize ────────────────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth, h = canvas.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix()
    })
    ro.observe(canvas)

    // ── Label update — exact artifact approach ────────────────────────────────
    const tmpV = new THREE.Vector3()
    function updateLabels() {
      const w = canvas.clientWidth, h = canvas.clientHeight
      // L2/L3 node labels — projected from group position
      for (const nd of nodeData) {
        const curY = nd.group.position.y
        tmpV.set(nd.group.position.x, curY + nd.r * 1.5 + 0.10, nd.group.position.z)
        tmpV.project(camera)
        const el = labelEls.get(nd.id)
        if (!el) continue
        if (tmpV.z > 1) { el.style.display = 'none'; continue }
        el.style.display = 'block'
        el.style.left = `${(tmpV.x + 1) / 2 * w}px`
        el.style.top  = `${(-tmpV.y + 1) / 2 * h}px`
      }
      // L1 territory labels — projected from plane centre, slightly elevated
      for (const entity of entities.filter(e => l1Set.has(e.id))) {
        const el = labelEls.get(entity.id)
        const center = positions.get(entity.id)
        if (!el || !center) continue
        tmpV.set(center.x, 0.5, center.z)
        tmpV.project(camera)
        if (tmpV.z > 1) { el.style.display = 'none'; continue }
        el.style.display = 'block'
        el.style.left = `${(tmpV.x + 1) / 2 * w}px`
        el.style.top  = `${(-tmpV.y + 1) / 2 * h}px`
      }
    }

    // ── Animation loop ────────────────────────────────────────────────────────
    function loop() {
      animFrame = requestAnimationFrame(loop)
      t += 0.016

      // Grow-in
      if (isGrowing) {
        const elapsed = performance.now() / 1000 - growStart
        const progress = Math.min(1, elapsed / GROW_DUR)
        const s = Math.max(0, easeOutBack(progress))
        for (const nd of nodeData) nd.group.scale.setScalar(nd.r * s)
        if (progress >= 1) { isGrowing = false; for (const nd of nodeData) nd.group.scale.setScalar(nd.r) }
      }

      // Float + shadow + idle rotation (skipped during grow)
      if (!isGrowing) {
        for (const nd of nodeData) {
          const visible = nd.provenanceOrdinal <= revealUpToRef.current
          const dy = Math.sin(t * 0.72 + nd.phase) * 0.07
          nd.group.position.y = nd.baseY + dy
          if (nd.id !== selId) nd.group.rotation.y += nd.rotSpeed * 0.016
          const gs = nd.group.scale.x
          const heightAboveGround = Math.max(0, nd.baseY + dy + 0.016)
          ;(nd.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.22 - Math.abs(dy) * 0.5 - heightAboveGround * 0.018) * gs * (visible ? 1 : 0)
          const sc = (1 + Math.abs(dy) * 0.3) * gs; nd.shadow.scale.set(sc, 1, sc)
          // Provenance fade
          nd.coreMat.opacity = visible ? nd.baseOpacity : 0.07
          const labelEl = labelEls.get(nd.id)
          if (labelEl) labelEl.style.opacity = visible ? '1' : '0'
        }
      }

      // Traversal edges: dashes flow along path
      for (const ln of travelEdges) { ;(ln.material as any).dashOffset -= 0.007 }

      // Containment edges: gentle opacity pulse
      containEdges.forEach((ln, i) => {
        const mat = ln.material as THREE.LineBasicMaterial
        mat.opacity = (mat.userData.baseOp as number) * (0.80 + 0.20 * Math.sin(t * 1.1 + i * 0.7))
      })

      // Motes drift upward, wrap at ceiling
      const mpa = moteGeo.attributes.position.array as Float32Array
      for (let i = 0; i < MC; i++) {
        mpa[i*3] += moteVel[i*3]; mpa[i*3+1] += 0.007; mpa[i*3+2] += moteVel[i*3+2]
        if (mpa[i*3+1] > 6.5) {
          mpa[i*3+1] = -1
          mpa[i*3]   = cx + (Math.random() - 0.5) * 10
          mpa[i*3+2] = cz + (Math.random() - 0.5) * 10
        }
      }
      moteGeo.attributes.position.needsUpdate = true
      ;(moteMesh.material as THREE.PointsMaterial).opacity = 0.42 + 0.12 * Math.sin(t * 1.5)

      // Selected node emissive pulse
      if (selId && nodeById.has(selId) && !isGrowing) {
        nodeById.get(selId)!.coreMat.emissiveIntensity = 0.70 + 0.18 * Math.sin(t * 2.8)
      }

      renderer.render(scene, camera)
      updateLabels()
    }
    loop()

    // ── Cleanup ───────────────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(animFrame)
      canvas.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('wheel', onWheel)
      ro.disconnect(); renderer.dispose(); labelsEl.innerHTML = ''
    }
  }, [atlas]) // eslint-disable-line react-hooks/exhaustive-deps

  const entityMap      = atlas ? new Map(atlas.entities.map(e => [e.id, e])) : new Map<string, AtlasEntity>()
  const selectedEntity = selectedId ? entityMap.get(selectedId) ?? null : null

  return (
    <div style={{ position: 'relative', width: '100%', flex: 1, minHeight: 0, background: '#060C18', overflow: 'hidden' }}>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', cursor: 'grab' }} />

      {/* Imperative label layer */}
      <div ref={labelsRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }} />

      {/* Detail panel — data-dp used to prevent click-deselect */}
      {selectedEntity && (
        <div data-dp="">
          <AtlasExplorerDetailPanel
            entity={selectedEntity}
            entityMap={entityMap}
            onClose={() => { setSelectedId(null); selectedIdRef.current = null }}
          />
        </div>
      )}

      <AtlasExplorerOverlays
        loading={loading}
        error={error}
        atlas={atlas}
        selectedId={selectedId}
        sectionCount={sectionCount}
        revealUpTo={revealUpTo}
        onRevealChange={v => { setRevealUpTo(v); revealUpToRef.current = v }}
      />
    </div>
  )
}
