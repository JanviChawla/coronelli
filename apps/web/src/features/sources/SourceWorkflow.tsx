import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { CandidatesTable } from '../candidates/CandidatesTable'
import { type Candidate, fetchCandidates, fetchDocumentEntityCandidates, patchCandidateReviewState } from '../candidates/candidateApi'
import { fetchPreflight, triggerDocumentCatalog, getDocumentCatalogStatus, confirmDocumentCatalog, triggerEvidenceExtraction, getExtractionProgress, fetchPlaceSuggestions, addManualCandidate, triggerDocumentCatalogGap, getDocumentCatalogGapStatus } from './extractionApi'
import type { Document, Section } from './sourceApi'
import { fetchAtlas } from '../atlas/atlasApi'
import type { AtlasEntity, AtlasTravelRule } from '../atlas/atlasApi'
import { triggerSynthesis, getSynthesisProgress } from '../synthesis/synthesisApi'

interface Props {
  document: Document
  sections: Section[]
  onEditSections: () => void
  onSectionsChanged?: (sections: Section[]) => void
  onAtlasChanged?: () => void
  onViewAtlas?: () => void
  onEdit?: () => void
  onDelete?: () => void
}

type Phase =
  | 'preflight'
  | 'ready'
  | 'cataloging'
  | 'catalog-review'
  | 'evidence-ready'
  | 'extracting'
  | 'inspecting'
  | 'synthesizing'
  | 'done'
  | 'error'

// ── Step chrome ───────────────────────────────────────────────────────────────

const CIRCLE: CSSProperties = {
  width: '2.25rem',
  height: '2.25rem',
  borderRadius: '50%',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '0.88rem',
  fontWeight: 700,
}

function StepDone({ label, detail, action }: {
  label: string
  detail: string
  action?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'flex-start' }}>
      <div className="wax-seal">✦</div>
      <div style={{ flex: 1, paddingTop: '0.35rem' }}>
        <div style={{ fontWeight: 600, fontSize: '1.1rem', color: 'var(--ink)' }}>{label}</div>
        <div style={{ fontSize: '0.88rem', color: 'var(--ink-muted)', marginTop: '0.45rem' }}>{detail}</div>
        {action && <div style={{ marginTop: '1rem' }}>{action}</div>}
      </div>
    </div>
  )
}

function StepActive({ n, label, children, processing = false }: {
  n: number
  label: string
  children: ReactNode
  processing?: boolean
}) {
  return (
    <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'flex-start' }}>
      <div style={{ ...CIRCLE, background: 'var(--step-active-circle)', color: '#fff' }} className={processing ? 'step-processing' : ''}>{n}</div>
      <div style={{ flex: 1, paddingTop: '0.3rem' }}>
        <div style={{
          fontWeight: 600, fontSize: '1.25rem',
          color: 'var(--step-active-label)', marginBottom: '0.45rem',
        }}>
          {label}
        </div>
        {children}
      </div>
    </div>
  )
}

function StepLocked({ n, label, detail }: { n: number; label: string; detail: string }) {
  return (
    <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'flex-start', opacity: 0.38 }}>
      <div style={{ ...CIRCLE, border: '2px solid var(--step-locked)', color: 'var(--step-locked)' }}>{n}</div>
      <div style={{ flex: 1, paddingTop: '0.35rem' }}>
        <div style={{ fontWeight: 500, fontSize: '1.05rem', color: 'var(--ink-muted)' }}>{label}</div>
        <div style={{ fontSize: '0.85rem', color: 'var(--ink-faint)', marginTop: '0.45rem' }}>{detail}</div>
      </div>
    </div>
  )
}

function StepConnector() {
  return (
    <div style={{ display: 'flex', gap: '1.25rem', height: '2.5rem', margin: '0.15rem 0' }}>
      <div style={{ width: '2.25rem', flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ width: '1px', flex: 1, background: 'var(--gold)', opacity: 0.3 }} />
        <span style={{ color: 'var(--gold)', opacity: 0.38, fontSize: '0.4rem', lineHeight: 1 }}>◆</span>
        <div style={{ width: '1px', flex: 1, background: 'var(--gold)', opacity: 0.3 }} />
      </div>
    </div>
  )
}

function Ornament() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '1.5rem 0 2.75rem' }}>
      <div style={{ flex: 1, height: '1px', background: 'var(--gold)', opacity: 0.3 }} />
      <span style={{ fontSize: '0.6rem', color: 'var(--gold)', opacity: 0.6 }}>◆</span>
      <div style={{ flex: 1, height: '1px', background: 'var(--gold)', opacity: 0.3 }} />
    </div>
  )
}

// Shared rerun bar used by re-harvest and re-synthesize — full-width horizontal
function RerunCard({ label, costLo, costHi, meta, action, onAction }: {
  label: string
  costLo: number
  costHi: number
  meta: string
  action: string
  onAction: () => void
}) {
  return (
    <div style={{
      border: '1px solid var(--border-warm)',
      borderRadius: '6px',
      background: 'var(--parchment-card)',
      padding: '0.85rem 1.1rem',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '1rem',
    }}>
      <div>
        <p style={{
          fontSize: '0.56rem', color: 'var(--ink-muted)',
          letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: '0.2rem',
        }}>
          {label}
        </p>
        <p>
          {costLo === 0 && costHi === 0 ? (
            <span style={{ fontSize: '1.05rem', color: 'var(--ink-muted)', fontWeight: 400 }}>Free</span>
          ) : (
            <span style={{ fontSize: '1.05rem', color: 'var(--ink)', fontWeight: 400 }}>
              ${costLo.toFixed(2)} – ${costHi.toFixed(2)}
            </span>
          )}
          <span style={{
            fontSize: '0.66rem', color: 'var(--ink-faint)',
            fontFamily: 'monospace', marginLeft: '0.55rem',
          }}>
            {meta}
          </span>
        </p>
      </div>
      <button
        className="btn-rerun"
        type="button"
        onClick={onAction}
      >
        {action}
      </button>
    </div>
  )
}

// Sub-pass dot indicator used in both evidence-extracting and synthesis progress
function SubPassDot({ done, active }: { done: boolean; active: boolean }) {
  return (
    <div style={{
      width: '1.35rem', height: '1.35rem', borderRadius: '50%', flexShrink: 0, marginTop: '0.05rem',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.45rem',
      ...(done
        ? { background: 'radial-gradient(circle at 40% 35%, #7a3528, #3d1208)', boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.3)', color: 'rgba(240,215,190,0.8)' }
        : active
          ? { background: 'var(--step-active-circle)', color: '#fff' }
          : { border: '1.5px solid var(--gold)', color: 'var(--gold)' }
      ),
    }} className={active ? 'step-processing' : ''}>
      {done ? '✦' : ''}
    </div>
  )
}

// ── Evidence sub-passes definition ────────────────────────────────────────────
const EVIDENCE_SUBPASSES: Array<{ key: string; label: string; detail: string }> = [
  { key: 'spatial',     label: 'Spatial claims',     detail: 'LOCATED_IN, CONTAINS, NEAR, ADJACENT_TO' },
  { key: 'visual',      label: 'Visual observations', detail: 'Appearance, atmosphere, color, material, scale' },
  { key: 'routes',      label: 'Travel rules',        detail: 'Traversal routes and paths' },
  { key: 'movement',    label: 'Movement',            detail: 'Narrated journeys and travel arcs' },
  { key: 'access',      label: 'Access rules',        detail: 'Permitted, prohibited, conditional entry' },
  { key: 'containment', label: 'Containment sweep',   detail: 'Hierarchical parent–child topology' },
  { key: 'dedup',       label: 'Entity dedup',        detail: 'SAME_AS merge hints between aliases' },
]

const SPATIAL_LEVEL_LABELS: Record<number, string> = { 0: 'Realm', 1: 'Territory', 2: 'Place', 3: 'Feature' }

// ── Main component ────────────────────────────────────────────────────────────

export function SourceWorkflow({ document, sections, onEditSections, onSectionsChanged, onAtlasChanged, onViewAtlas, onEdit, onDelete }: Props) {
  const [phase, setPhase] = useState<Phase>('preflight')
  const [errorInStep, setErrorInStep] = useState<3 | 4 | 5>(3)
  const [totalCost, setTotalCost] = useState<number | null>(null)
  const [cachedCount, setCachedCount] = useState(0)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [currentTitle, setCurrentTitle] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [candidatesSoFar, setCandidatesSoFar] = useState(0)
  const [totalCandidates, setTotalCandidates] = useState(0)
  const [totalElapsedMs, setTotalElapsedMs] = useState(0)
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  const [allCandidates, setAllCandidates] = useState<Record<string, Candidate[]>>({})
  const [canonicalEntityCount, setCanonicalEntityCount] = useState(0)
  const [canonicalClaimCount, setCanonicalClaimCount] = useState(0)
  const [atlasEntities, setAtlasEntities] = useState<AtlasEntity[]>([])
  const [atlasTravelRules, setAtlasTravelRules] = useState<AtlasTravelRule[]>([])
  const [synthElapsedMs, setSynthElapsedMs] = useState(0)
  const [synthPhase, setSynthPhase] = useState<string | null>(null)
  const [entityCandidates, setEntityCandidates] = useState<Candidate[]>([])
  const [rejectedCandidateIds, setRejectedCandidateIds] = useState<Set<string>>(new Set())
  const [placeSuggestions, setPlaceSuggestions] = useState<string[]>([])
  const [addPlaceInput, setAddPlaceInput] = useState('')
  const [showAddSuggestions, setShowAddSuggestions] = useState(false)
  const [addingPlace, setAddingPlace] = useState(false)
  const addPlaceRef = useRef<HTMLDivElement>(null)
  const [runningGapPass, setRunningGapPass] = useState(false)
  const gapPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [evidenceSubPhase, setEvidenceSubPhase] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [confirmingCatalog, setConfirmingCatalog] = useState(false)
  // Staleness flags: set when a preceding step is re-run, cleared when the stale step starts.
  const [evidenceStale, setEvidenceStale] = useState(false)
  const [synthesisStale, setSynthesisStale] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const synthPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const evidencePollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const catalogPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!sections.length) return
    initWorkflow()
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (catalogPollRef.current) clearInterval(catalogPollRef.current)
      if (evidencePollRef.current) clearInterval(evidencePollRef.current)
      if (synthPollRef.current) clearInterval(synthPollRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id, sections.length])

  async function initWorkflow() {
    setPhase('preflight')

    // Always fetch catalog status first — confirmation state governs all routing decisions.
    let catalogStatus: Awaited<ReturnType<typeof getDocumentCatalogStatus>> | null = null
    try { catalogStatus = await getDocumentCatalogStatus(document.id) } catch { /* unavailable */ }

    const catalogConfirmed = catalogStatus?.catalog_confirmed ?? false
    const catalogDone = catalogStatus != null && catalogStatus.status === 'completed' && catalogStatus.sections_done > 0

    // ── Catalog still running — re-attach ──────────────────────────────────────
    if (catalogStatus?.status === 'running') {
      setPhase('cataloging')
      setCurrentIdx(catalogStatus.sections_done)
      await loadPreflight()
      await new Promise<void>((resolve, reject) => {
        catalogPollRef.current = setInterval(async () => {
          try {
            const s = await getDocumentCatalogStatus(document.id)
            setCurrentIdx(s.sections_done)
            if (s.status === 'completed' || s.sections_done === s.sections_total) {
              clearInterval(catalogPollRef.current!)
              catalogPollRef.current = null
              resolve()
            }
          } catch (e) {
            clearInterval(catalogPollRef.current!)
            catalogPollRef.current = null
            reject(e)
          }
        }, 2000)
      })
      await _finishCatalogAndReview()
      return
    }

    // ── Catalog confirmed → check for atlas (done) or evidence (inspecting/stale) ──
    if (catalogConfirmed) {
      try {
        const atlas = await fetchAtlas(document.id)
        if (atlas.entity_count > 0) {
          const bySection: Record<string, Candidate[]> = {}
          let total = 0
          await Promise.all(sections.map(async (s) => {
            bySection[s.id] = await fetchCandidates(s.id)
            total += bySection[s.id].length
          }))
          if (total > 0) {
            setCanonicalEntityCount(atlas.entity_count)
            setCanonicalClaimCount(atlas.claim_count)
            setAtlasEntities(atlas.entities)
            setAtlasTravelRules(atlas.travel_rules)
            setAllCandidates(bySection)
            setTotalCandidates(total)
            try {
              const preflightResults = await Promise.all(sections.map((s) => fetchPreflight(s.id)))
              const cost = preflightResults.reduce((sum, r) => sum + (r.estimated_cost_usd ?? 0), 0)
              setTotalCost(cost)
            } catch { /* preflight optional in done state */ }
            try {
              const entities = await fetchDocumentEntityCandidates(document.id)
              setEntityCandidates(entities)
              setRejectedCandidateIds(new Set(entities.filter(e => e.review_state === 'rejected').map(e => e.id)))
            } catch { /* non-critical */ }
            setPhase('done')
            return
          }
        }
      } catch { /* no atlas yet */ }

      // Atlas not ready — check for evidence candidates mid-flight
      try {
        const bySection: Record<string, Candidate[]> = {}
        let total = 0
        await Promise.all(sections.map(async (s) => {
          bySection[s.id] = await fetchCandidates(s.id)
          total += bySection[s.id].length
        }))
        const evidenceCount = Object.values(bySection).reduce(
          (sum, cands) => sum + cands.filter(c => c.kind !== 'entity').length, 0
        )
        if (evidenceCount > 0) {
          setAllCandidates(bySection)
          setTotalCandidates(total)
          setPhase('inspecting')
          return
        }
      } catch { /* no candidates yet */ }
    }

    // ── Catalog done but not confirmed (or confirmed but no evidence yet) ──────
    if (catalogDone) {
      const [entities, suggestions] = await Promise.all([
        fetchDocumentEntityCandidates(document.id),
        fetchPlaceSuggestions(document.id),
      ])
      setEntityCandidates(entities)
      setRejectedCandidateIds(new Set(entities.filter(e => e.review_state === 'rejected').map(e => e.id)))
      setPlaceSuggestions(suggestions)
      // If evidence candidates already exist from a previous run, mark them stale.
      try {
        const bySection: Record<string, Candidate[]> = {}
        await Promise.all(sections.map(async (s) => { bySection[s.id] = await fetchCandidates(s.id) }))
        const evidenceCount = Object.values(bySection).reduce(
          (sum, cands) => sum + cands.filter(c => c.kind !== 'entity').length, 0
        )
        if (evidenceCount > 0 && !catalogConfirmed) {
          setEvidenceStale(true)
          setSynthesisStale(true)
        }
      } catch { /* non-critical */ }
      await loadPreflight()
      setPhase(catalogConfirmed ? 'evidence-ready' : 'catalog-review')
      return
    }

    await loadPreflight()
  }

  async function loadPreflight() {
    setPhase('preflight')
    try {
      const results = await Promise.all(sections.map((s) => fetchPreflight(s.id)))
      const cost = results.reduce((sum, r) => sum + (r.cache_valid ? 0 : (r.estimated_cost_usd ?? 0)), 0)
      setTotalCost(cost)
      setCachedCount(results.filter((r) => r.cache_valid).length)
    } catch {
      setTotalCost(null)
    }
    setPhase('ready')
  }

  // Shared: once catalog is done on the server, fetch entities and move to review.
  async function _finishCatalogAndReview() {
    const [entities, suggestions] = await Promise.all([
      fetchDocumentEntityCandidates(document.id),
      fetchPlaceSuggestions(document.id),
    ])
    setEntityCandidates(entities)
    setPlaceSuggestions(suggestions)
    setAddPlaceInput('')
    setPhase('catalog-review')
  }

  // Pass 1: fire a document-level batch job, poll until done, then show entity review.
  async function handleHarvest(force = false) {
    setPhase('cataloging')
    setCurrentIdx(0)
    setWorkflowError(null)
    setEntityCandidates([])
    setRejectedCandidateIds(new Set())
    // Re-cataloging invalidates all downstream results.
    if (force) { setEvidenceStale(true); setSynthesisStale(true) }


    const startTime = Date.now()
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - startTime), 100)

    try {
      const job = await triggerDocumentCatalog(document.id, force)

      if (job.status === 'completed') {
        if (timerRef.current) clearInterval(timerRef.current)
        await _finishCatalogAndReview()
        return
      }

      // Poll progress every 2 s — non-blocking, so the user can navigate away freely.
      setCurrentIdx(job.sections_done)
      await new Promise<void>((resolve, reject) => {
        catalogPollRef.current = setInterval(async () => {
          try {
            const status = await getDocumentCatalogStatus(document.id)
            setCurrentIdx(status.sections_done)
            if (status.status === 'completed' || status.sections_done === status.sections_total) {
              clearInterval(catalogPollRef.current!)
              catalogPollRef.current = null
              resolve()
            }
          } catch (e) {
            clearInterval(catalogPollRef.current!)
            catalogPollRef.current = null
            reject(e)
          }
        }, 2000)
      })

      if (timerRef.current) clearInterval(timerRef.current)
      await _finishCatalogAndReview()
    } catch (e) {
      if (timerRef.current) clearInterval(timerRef.current)
      if (catalogPollRef.current) { clearInterval(catalogPollRef.current); catalogPollRef.current = null }
      setWorkflowError(e instanceof Error ? e.message : 'Catalog extraction failed.')
      setErrorInStep(3)
      setPhase('error')
    }
  }

  function toggleReject(id: string) {
    setRejectedCandidateIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Gate between catalog and evidence: persist rejections, mark confirmed, then wait for evidence.
  async function handleConfirmCatalog() {
    setConfirmingCatalog(true)
    setWorkflowError(null)
    try {
      if (rejectedCandidateIds.size > 0) {
        await Promise.all(
          [...rejectedCandidateIds].map(id => patchCandidateReviewState(id, 'rejected'))
        )
      }
      await confirmDocumentCatalog(document.id)
      setPhase('evidence-ready')
    } catch (e) {
      setWorkflowError(e instanceof Error ? e.message : 'Failed to confirm catalog.')
    } finally {
      setConfirmingCatalog(false)
    }
  }

  // Pass 2: run the 7 evidence sub-passes for every section.
  async function handleStartEvidence(force = false) {
    setEvidenceStale(false)
    setSynthesisStale(true)  // evidence re-run always invalidates synthesis until it completes
    setPhase('extracting')
    setCurrentIdx(0)
    setCandidatesSoFar(0)
    setEvidenceSubPhase(null)
    setAllCandidates({})

    const startTime = Date.now()
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - startTime), 100)

    try {
      let total = 0
      for (let i = 0; i < sections.length; i++) {
        setCurrentIdx(i + 1)
        setCurrentTitle(sections[i].title)
        setEvidenceSubPhase(null)

        const sectionId = sections[i].id
        evidencePollRef.current = setInterval(async () => {
          try {
            const prog = await getExtractionProgress(sectionId)
            if (prog.current_phase) setEvidenceSubPhase(prog.current_phase)
          } catch { /* ignore transient poll errors */ }
        }, 1500)

        await triggerEvidenceExtraction(sectionId, force)
        if (evidencePollRef.current) clearInterval(evidencePollRef.current)
        const sectionCandidates = await fetchCandidates(sectionId)
        total += sectionCandidates.filter(c => c.kind !== 'entity').length
        setCandidatesSoFar(total)
      }

      if (timerRef.current) clearInterval(timerRef.current)
      setTotalElapsedMs(Date.now() - startTime)

      const bySection: Record<string, Candidate[]> = {}
      let grandTotal = 0
      await Promise.all(sections.map(async (s) => {
        bySection[s.id] = await fetchCandidates(s.id)
        grandTotal += bySection[s.id].length
      }))
      setAllCandidates(bySection)
      setTotalCandidates(grandTotal)
      // Auto-chain synthesis immediately after evidence is harvested
      await handleSynthesize(force)
    } catch (e) {
      if (timerRef.current) clearInterval(timerRef.current)
      if (evidencePollRef.current) clearInterval(evidencePollRef.current)
      setWorkflowError(e instanceof Error ? e.message : 'Evidence extraction failed.')
      setErrorInStep(4)
      setPhase('error')
    }
  }

  async function handleSynthesize(force = false) {
    setSynthesisStale(false)
    setPhase('synthesizing')
    setSynthElapsedMs(0)
    setSynthPhase(null)
    const synthStart = Date.now()
    timerRef.current = setInterval(() => setSynthElapsedMs(Date.now() - synthStart), 100)
    // Poll the progress endpoint every 2s so phase labels update in real time
    synthPollRef.current = setInterval(async () => {
      try {
        const prog = await getSynthesisProgress(document.id)
        if (prog.current_phase) setSynthPhase(prog.current_phase)
      } catch { /* ignore transient poll errors */ }
    }, 2000)
    try {
      await triggerSynthesis(document.id, force)
      if (timerRef.current) clearInterval(timerRef.current)
      if (synthPollRef.current) clearInterval(synthPollRef.current)
      const atlas = await fetchAtlas(document.id)
      setCanonicalEntityCount(atlas.entity_count)
      setCanonicalClaimCount(atlas.claim_count)
      setAtlasEntities(atlas.entities)
      setAtlasTravelRules(atlas.travel_rules)
      setPhase('done')
      onAtlasChanged?.()
    } catch (e) {
      if (timerRef.current) clearInterval(timerRef.current)
      if (synthPollRef.current) clearInterval(synthPollRef.current)
      setWorkflowError(e instanceof Error ? e.message : 'Synthesis failed.')
      setErrorInStep(5)
      setPhase('error')
    }
  }


  // Step 3 = Catalog places
  const step3Done = phase === 'evidence-ready' || phase === 'extracting' || phase === 'inspecting' || phase === 'synthesizing' || phase === 'done' || (phase === 'error' && errorInStep >= 4)
  const step3Error = phase === 'error' && errorInStep === 3
  // Step 4 = Harvest evidence
  const step4Done = phase === 'inspecting' || phase === 'synthesizing' || phase === 'done' || (phase === 'error' && errorInStep === 5)
  const step4Error = phase === 'error' && errorInStep === 4
  // Step 5 = Synthesize atlas
  const step5Done = phase === 'done'
  const step5Error = phase === 'error' && errorInStep === 5

  // Cost estimates — catalog is ~1 call/section, evidence is ~7 calls/section
  const totalCostBase = totalCost ?? sections.length * 0.0020
  const catalogCostBase = totalCostBase / 8
  const catalogCostLo = catalogCostBase * 0.85
  const catalogCostHi = catalogCostBase * 1.15
  const evidenceCostBase = (totalCostBase * 7) / 8
  const evidenceCostLo = evidenceCostBase * 0.85
  const evidenceCostHi = evidenceCostBase * 1.15

  const synthInputTokens = totalCandidates * 350 + 1500
  const synthOutputTokens = Math.min(totalCandidates * 100, 8000)
  const synthCostBase = (synthInputTokens / 1_000_000) * 0.15 + (synthOutputTokens / 1_000_000) * 0.60
  const synthCostLo = synthCostBase * 0.85
  const synthCostHi = synthCostBase * 1.15

  // Entity review helpers
  const uniqueEntityCandidates = entityCandidates.filter((c, idx, self) =>
    idx === self.findIndex(x => (x.payload as Record<string, unknown>).name === (c.payload as Record<string, unknown>).name)
  )
  const rejectedCount = rejectedCandidateIds.size
  const approvedCount = uniqueEntityCandidates.length - rejectedCount

  // Add-missing-place helpers
  const existingCandidateNames = new Set(uniqueEntityCandidates.map(c => String((c.payload as Record<string, unknown>).name ?? '').toLowerCase()))
  const filteredSuggestions = addPlaceInput.length >= 1
    ? placeSuggestions.filter(s =>
        s.toLowerCase().includes(addPlaceInput.toLowerCase()) &&
        !existingCandidateNames.has(s.toLowerCase())
      ).slice(0, 8)
    : []

  async function handleGapPass() {
    if (runningGapPass) return
    setRunningGapPass(true)
    try {
      await triggerDocumentCatalogGap(document.id)
      // Poll until completed
      gapPollRef.current = setInterval(async () => {
        try {
          const status = await getDocumentCatalogGapStatus(document.id)
          if (status.status === 'completed') {
            if (gapPollRef.current) clearInterval(gapPollRef.current)
            gapPollRef.current = null
            setRunningGapPass(false)
            // Reload entity candidates
            const entities = await fetchDocumentEntityCandidates(document.id)
            setEntityCandidates(entities)
          }
        } catch { /* keep polling */ }
      }, 2000)
    } catch {
      setRunningGapPass(false)
    }
  }

  async function handleAddManualPlace(name: string) {
    if (!name.trim() || addingPlace) return
    setAddingPlace(true)
    setShowAddSuggestions(false)
    setAddPlaceInput('')
    try {
      await addManualCandidate(document.id, name.trim())
      const entities = await fetchDocumentEntityCandidates(document.id)
      setEntityCandidates(entities)
    } catch { /* ignore */ }
    setAddingPlace(false)
  }

  // Candidate kind counts for inspection panel
  const allCandidatesList = Object.values(allCandidates).flat()
  const kindCounts = allCandidatesList.reduce<Record<string, number>>((acc, c) => {
    acc[c.kind] = (acc[c.kind] ?? 0) + 1
    return acc
  }, {})

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto' }}>
      {/* Document header */}
      <p style={{
        fontSize: '0.72rem', color: 'var(--ink-muted)',
        textTransform: 'uppercase', letterSpacing: '0.18em', marginBottom: '0.55rem',
      }}>
        Source work
      </p>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
          <h2 style={{ flex: 1, fontSize: '2.4rem', fontWeight: 400, color: 'var(--ink)', lineHeight: 1.15, margin: 0 }}>
            {document.title}
          </h2>
          {onDelete && (
            <button
              type="button"
              title={confirmingDelete ? 'Click again to confirm removal' : 'Remove from library'}
              onClick={() => {
                if (confirmingDelete) {
                  if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
                  setConfirmingDelete(false)
                  onDelete?.()
                } else {
                  setConfirmingDelete(true)
                  deleteTimerRef.current = setTimeout(() => setConfirmingDelete(false), 3000)
                }
              }}
              style={{
                marginTop: '0.4rem', background: 'none', cursor: 'pointer', lineHeight: 1,
                border: confirmingDelete ? '1px solid rgba(180,60,60,0.5)' : 'none',
                borderRadius: '3px',
                padding: confirmingDelete ? '0.2rem 0.5rem' : '0 0.1rem',
                color: confirmingDelete ? 'var(--error-text)' : 'var(--ink-faint)',
                fontSize: confirmingDelete ? '0.78rem' : '1.1rem',
                opacity: confirmingDelete ? 1 : 0.45,
                transition: 'all 0.15s',
              }}
            >
              {confirmingDelete ? 'Remove?' : '×'}
            </button>
          )}
        </div>
      {document.author && (
        <p style={{ fontSize: '1rem', color: 'var(--ink-muted)', marginTop: '0.35rem' }}>
          {document.author}{document.year ? `, ${document.year}` : ''}
        </p>
      )}
      <Ornament />

      {/* ── Step 1 ──────────────────────────────────────────────────── */}
      <StepDone
        label="Import source"
        detail={document.original_filename}
        action={
          <details>
            <summary style={{ fontSize: '0.88rem', color: 'var(--ink-muted)', cursor: 'pointer', listStyle: 'none' }}>
              Inspect metadata
            </summary>
            <div style={{ marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.18rem' }}>
              {[
                ['Title',  document.title],
                ['Author', document.author || '—'],
                ['Year',   document.year != null ? String(document.year) : 'N/A'],
              ].map(([label, value]) => (
                <div key={label} style={{ display: 'flex', gap: '0.5rem', fontSize: '0.88rem' }}>
                  <span style={{ color: 'var(--ink-faint)', minWidth: '3.5rem' }}>{label}</span>
                  <span style={{ color: 'var(--ink)' }}>{value}</span>
                </div>
              ))}
              {onEdit && (
                <button type="button" onClick={onEdit} style={{
                  marginTop: '0.55rem', alignSelf: 'flex-start',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  fontSize: '0.78rem', color: 'var(--ink-muted)',
                  textDecoration: 'underline', textDecorationColor: 'rgba(140,120,80,0.35)',
                  textUnderlineOffset: '3px',
                }}>
                  ✎ Edit metadata
                </button>
              )}
            </div>
          </details>
        }
      />
      <StepConnector />

      {/* ── Step 2 ──────────────────────────────────────────────────── */}
      <StepDone
        label="Prepare sections"
        detail={`${sections.length} section${sections.length !== 1 ? 's' : ''} ready`}
        action={
          <details>
            <summary style={{ fontSize: '0.88rem', color: 'var(--ink-muted)', cursor: 'pointer', listStyle: 'none' }}>
              Inspect sections ({sections.length})
            </summary>
            <div style={{ marginTop: '0.65rem' }}>
              {sections.map((s, i) => (
                <div key={s.id} style={{ display: 'flex', gap: '0.5rem', fontSize: '0.88rem', marginBottom: '0.3rem' }}>
                  <span style={{ color: 'var(--gold)', minWidth: '2rem', fontSize: '0.62rem', flexShrink: 0 }}>§{i + 1}</span>
                  <span style={{ color: 'var(--ink)' }}>{s.title}</span>
                </div>
              ))}
            </div>
          </details>
        }
      />
      <StepConnector />

      {/* ── Step 3: Catalog places ───────────────────────────────────── */}
      {step3Done ? (
        <StepDone
          label="Catalog places"
          detail={`${uniqueEntityCandidates.length - rejectedCount} place${uniqueEntityCandidates.length - rejectedCount !== 1 ? 's' : ''} approved · ${rejectedCount} rejected`}
          action={
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <RerunCard
                label="Re-catalog cost"
                costLo={catalogCostLo}
                costHi={catalogCostHi}
                meta={`${sections.length} section${sections.length !== 1 ? 's' : ''} · 1 pass`}
                action="Re-catalog places"
                onAction={() => handleHarvest(true)}
              />
              {uniqueEntityCandidates.length > 0 && (
                <details>
                  <summary style={{ fontSize: '0.88rem', color: 'var(--ink-muted)', cursor: 'pointer', listStyle: 'none' }}>
                    Inspect places ({uniqueEntityCandidates.length - rejectedCount} approved{rejectedCount > 0 ? ` · ${rejectedCount} rejected` : ''})
                  </summary>
                  <div style={{ marginTop: '0.65rem', display: 'flex', flexDirection: 'column', gap: '0.18rem' }}>
                    {uniqueEntityCandidates.map((c) => {
                      const p = c.payload as Record<string, unknown>
                      const name = String(p.name ?? '')
                      const type = String(p.type ?? '')
                      const level = typeof p.spatial_level === 'number' ? p.spatial_level : null
                      const levelLabel = level !== null ? SPATIAL_LEVEL_LABELS[level] : null
                      const isRejected = rejectedCandidateIds.has(c.id)
                      return (
                        <div key={c.id} style={{ display: 'flex', gap: '0.5rem', fontSize: '0.88rem', alignItems: 'baseline', opacity: isRejected ? 0.38 : 1 }}>
                          <span style={{ flexShrink: 0, color: isRejected ? 'var(--error-text)' : 'var(--gold)', fontSize: '0.58rem' }}>
                            {isRejected ? '✕' : '◉'}
                          </span>
                          <span style={{ color: 'var(--ink)', textDecoration: isRejected ? 'line-through' : 'none' }}>{name}</span>
                          {levelLabel && (
                            <span style={{ fontSize: '0.62rem', color: 'var(--ink-faint)', border: '1px solid rgba(212,188,138,0.35)', borderRadius: '3px', padding: '0.05rem 0.3rem' }}>
                              L{level} {levelLabel}
                            </span>
                          )}
                          {type && <span style={{ color: 'var(--ink-faint)', fontSize: '0.72rem' }}>· {type}</span>}
                        </div>
                      )
                    })}
                  </div>
                </details>
              )}
            </div>
          }
        />
      ) : step3Error ? (
        <StepActive n={3} label="Catalog places">
          <p role="alert" style={{ color: 'var(--error-text)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
            {workflowError}
          </p>
          <button className="btn-cta" style={{ maxWidth: '200px' }} type="button" onClick={() => handleHarvest()}>
            Retry
          </button>
        </StepActive>
      ) : phase === 'cataloging' ? (
        <StepActive n={3} label="Catalog places" processing>
          <div style={{ fontSize: '0.88rem', color: 'var(--ink-muted)', marginTop: '0.25rem' }}>
            {currentIdx} of {sections.length} section{sections.length !== 1 ? 's' : ''} cataloged
          </div>
          <div style={{
            marginTop: '0.55rem', height: '3px', borderRadius: '2px',
            background: 'rgba(212,188,138,0.15)', overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', borderRadius: '2px',
              background: 'var(--gold)',
              width: `${sections.length > 0 ? Math.round((currentIdx / sections.length) * 100) : 0}%`,
              transition: 'width 1.5s ease',
            }} />
          </div>
          <p style={{ fontSize: '0.78rem', color: 'var(--ink-faint)', marginTop: '0.75rem', fontFamily: 'monospace' }}>
            {(elapsedMs / 1000).toFixed(1)}s elapsed
          </p>
        </StepActive>
      ) : phase === 'catalog-review' ? (
        // ── Entity review: approve / reject ───────────
        <StepActive n={3} label="Catalog places">
          <p style={{ fontSize: '0.92rem', color: 'var(--ink-muted)', marginTop: '0.25rem', marginBottom: '0.75rem', lineHeight: 1.55 }}>
            Found <strong style={{ color: 'var(--ink)' }}>{uniqueEntityCandidates.length}</strong> place{uniqueEntityCandidates.length !== 1 ? 's' : ''} across {sections.length} section{sections.length !== 1 ? 's' : ''}.
            Reject any that are not real locations before running evidence passes.
          </p>

          <div style={{
            border: '1px solid var(--border-warm)',
            borderRadius: '6px',
            background: 'var(--parchment-card)',
            overflow: 'hidden',
            marginBottom: '0.85rem',
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '0.55rem 0.9rem',
              borderBottom: '1px solid var(--border-warm)',
              fontSize: '0.72rem', color: 'var(--ink-muted)', letterSpacing: '0.12em', textTransform: 'uppercase',
            }}>
              <span>{approvedCount} approved · {rejectedCount} rejected</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <button
                  type="button"
                  onClick={handleGapPass}
                  disabled={runningGapPass}
                  style={{
                    background: 'none', border: '1px solid var(--border-warm)', borderRadius: '4px',
                    padding: '0.15rem 0.5rem', cursor: runningGapPass ? 'default' : 'pointer',
                    fontSize: '0.68rem', color: runningGapPass ? 'var(--ink-faint)' : 'var(--ink-muted)',
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    opacity: runningGapPass ? 0.6 : 1,
                  }}
                >
                  {runningGapPass ? 'Scanning…' : '+ Find more'}
                </button>
                <span>Click to reject / restore</span>
              </div>
            </div>
            <div style={{ maxHeight: '22rem', overflowY: 'auto' }}>
              {uniqueEntityCandidates.map((c) => {
                const p = c.payload as Record<string, unknown>
                const name = String(p.name ?? '')
                const type = String(p.type ?? '')
                const level = typeof p.spatial_level === 'number' ? p.spatial_level : null
                const levelLabel = level !== null ? SPATIAL_LEVEL_LABELS[level] : null
                const isRejected = rejectedCandidateIds.has(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleReject(c.id)}
                    style={{
                      width: '100%', display: 'flex', flexDirection: 'column',
                      alignItems: 'stretch', gap: 0, padding: '0.5rem 0.9rem',
                      background: 'none', border: 'none',
                      borderBottom: '1px solid rgba(212,188,138,0.15)',
                      cursor: 'pointer', textAlign: 'left',
                      opacity: isRejected ? 0.42 : 1,
                      transition: 'opacity 0.15s, background 0.15s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', width: '100%' }}>
                      <span style={{
                        width: '1.1rem', height: '1.1rem', borderRadius: '50%', flexShrink: 0,
                        border: isRejected ? '1.5px solid rgba(180,60,60,0.5)' : '1.5px solid var(--gold)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '0.5rem', color: isRejected ? 'rgba(180,60,60,0.7)' : 'var(--gold)',
                      }}>
                        {isRejected ? '✕' : '◉'}
                      </span>
                      <span style={{ flex: 1, fontSize: '0.9rem', color: isRejected ? 'var(--ink-faint)' : 'var(--ink)', textDecoration: isRejected ? 'line-through' : 'none' }}>
                        {name}
                      </span>
                      {levelLabel && (
                        <span style={{
                          fontSize: '0.62rem', color: 'var(--ink-faint)', flexShrink: 0,
                          border: '1px solid rgba(212,188,138,0.35)', borderRadius: '3px',
                          padding: '0.05rem 0.3rem', fontVariantNumeric: 'tabular-nums',
                        }}>
                          L{level} {levelLabel}
                        </span>
                      )}
                      {type && (
                        <span style={{ fontSize: '0.68rem', color: 'var(--ink-faint)', flexShrink: 0 }}>{type}</span>
                      )}
                      {c.source === 'manual' ? (
                        <span style={{ fontSize: '0.62rem', color: 'var(--ink-faint)', flexShrink: 0, border: '1px solid rgba(212,188,138,0.35)', borderRadius: '3px', padding: '0.05rem 0.3rem' }}>
                          added
                        </span>
                      ) : (
                        <span style={{ fontSize: '0.72rem', color: 'var(--gold)', opacity: 0.65, flexShrink: 0 }}>
                          {(c.confidence * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                    {c.excerpt && (
                      <div style={{
                        paddingLeft: '1.75rem', fontSize: '0.75rem', color: 'var(--ink-faint)',
                        fontStyle: 'italic', lineHeight: 1.4, marginTop: '0.18rem',
                        opacity: isRejected ? 0.6 : 1,
                      }}>
                        "{c.excerpt.length > 120 ? c.excerpt.slice(0, 120) + '…' : c.excerpt}"
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Add missing place */}
          <div ref={addPlaceRef} style={{ position: 'relative', marginBottom: '0.75rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="Add missing place…"
                value={addPlaceInput}
                disabled={addingPlace}
                onChange={e => { setAddPlaceInput(e.target.value); setShowAddSuggestions(true) }}
                onFocus={() => setShowAddSuggestions(true)}
                onBlur={() => setTimeout(() => setShowAddSuggestions(false), 150)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && addPlaceInput.trim()) { handleAddManualPlace(addPlaceInput.trim()) }
                  if (e.key === 'Escape') { setShowAddSuggestions(false); setAddPlaceInput('') }
                }}
                style={{
                  flex: 1, padding: '0.45rem 0.75rem',
                  background: 'var(--parchment-card)', border: '1px solid var(--border-warm)',
                  borderRadius: '5px', color: 'var(--ink)', fontSize: '0.88rem',
                  outline: 'none',
                }}
              />
              {addingPlace && (
                <span style={{ fontSize: '0.75rem', color: 'var(--ink-faint)' }}>Adding…</span>
              )}
            </div>
            {showAddSuggestions && filteredSuggestions.length > 0 && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
                background: 'var(--parchment-card)', border: '1px solid var(--border-warm)',
                borderRadius: '0 0 5px 5px', boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                maxHeight: '10rem', overflowY: 'auto',
              }}>
                {filteredSuggestions.map(s => (
                  <button
                    key={s}
                    type="button"
                    onMouseDown={() => handleAddManualPlace(s)}
                    style={{
                      width: '100%', padding: '0.45rem 0.75rem',
                      background: 'none', border: 'none', cursor: 'pointer',
                      textAlign: 'left', fontSize: '0.88rem', color: 'var(--ink)',
                      borderBottom: '1px solid rgba(212,188,138,0.12)',
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button className="btn-cta" type="button" onClick={handleConfirmCatalog} disabled={confirmingCatalog}>
            {confirmingCatalog ? 'Confirming…' : 'Confirm catalog →'}
          </button>
          {workflowError && phase === 'catalog-review' && (
            <p role="alert" style={{ fontSize: '0.82rem', color: 'var(--error-text)', marginTop: '0.5rem' }}>{workflowError}</p>
          )}
        </StepActive>
      ) : phase === 'ready' ? (
        <StepActive n={3} label="Catalog places">
          <p style={{ fontSize: '0.95rem', color: 'var(--ink-muted)', marginTop: '0.5rem', marginBottom: '1.25rem', lineHeight: 1.6 }}>
            One pass over all {sections.length} section{sections.length !== 1 ? 's' : ''} to identify every named place.
            After review, the approved catalog anchors the evidence passes.
          </p>
          <div style={{
            borderTop: '1px solid rgba(212, 188, 138, 0.5)',
            borderBottom: '1px solid rgba(212, 188, 138, 0.5)',
            padding: '0.65rem 0', marginBottom: '0.7rem',
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem',
          }}>
            <span style={{ fontSize: '0.68rem', color: 'var(--ink-muted)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
              Est. catalog cost
            </span>
            <span>
              {totalCost !== null ? (
                <span style={{ fontSize: '1rem', color: 'var(--ink)', fontFamily: 'monospace' }}>
                  ${catalogCostLo.toFixed(2)} – ${catalogCostHi.toFixed(2)}
                </span>
              ) : (
                <span style={{ fontSize: '1rem', color: 'var(--ink-faint)', fontFamily: 'monospace' }}>Estimating…</span>
              )}
            </span>
          </div>
          <p style={{ fontSize: '0.66rem', color: 'var(--ink-faint)', fontFamily: 'monospace', marginBottom: '1rem' }}>
            {document.original_filename} · {sections.length} section{sections.length !== 1 ? 's' : ''} · 1 pass · OpenAI
            {cachedCount > 0 && ` · ${cachedCount} cached`}
          </p>
          <button className="btn-cta" type="button" onClick={() => handleHarvest()}>
            Find places
          </button>
        </StepActive>
      ) : (
        <StepActive n={3} label="Catalog places">
          <p style={{ fontSize: '0.92rem', color: 'var(--ink-faint)' }}>Checking sections and estimating cost…</p>
        </StepActive>
      )}
      <StepConnector />

      {/* ── Step 4: Harvest evidence ─────────────────────────────────── */}
      {step4Done && !evidenceStale ? (
        <StepDone
          label="Harvest evidence"
          detail={`${totalCandidates} candidate${totalCandidates !== 1 ? 's' : ''} across ${sections.length} sections${totalElapsedMs > 0 ? ` · ${(totalElapsedMs / 1000).toFixed(1)}s` : ''}`}
          action={
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <RerunCard
                label="Re-harvest cost"
                costLo={evidenceCostLo}
                costHi={evidenceCostHi}
                meta={`${sections.length} section${sections.length !== 1 ? 's' : ''} · 7 passes · clears cache`}
                action="Re-harvest evidence"
                onAction={() => handleStartEvidence(true)}
              />
              <details>
                <summary style={{ fontSize: '0.88rem', color: 'var(--ink-muted)', cursor: 'pointer', listStyle: 'none' }}>
                  Inspect raw candidates ({totalCandidates})
                </summary>
                <div style={{ marginTop: '0.75rem' }}>
                  <CandidatesTable
                    sections={sections.map(s => ({ id: s.id, title: s.title }))}
                    candidates={allCandidates}
                  />
                </div>
              </details>
            </div>
          }
        />
      ) : step4Error ? (
        <StepActive n={4} label="Harvest evidence">
          <p role="alert" style={{ color: 'var(--error-text)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
            {workflowError}
          </p>
          <button className="btn-cta" style={{ maxWidth: '200px' }} type="button" onClick={() => handleStartEvidence()}>
            Retry
          </button>
        </StepActive>
      ) : phase === 'extracting' ? (
        <StepActive n={4} label="Harvest evidence" processing>
          <div style={{ flex: 1 }}>
              <div style={{ fontSize: '0.9rem', color: 'var(--ink)', fontWeight: 500 }}>
                §{currentIdx} of {sections.length}{currentTitle ? <> · <em>{currentTitle}</em></> : ''}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem', marginTop: '0.55rem' }}>
                {(() => {
                  const isParallel = evidenceSubPhase === 'parallel'
                  const activeIdx = isParallel ? -1 : EVIDENCE_SUBPASSES.findIndex(p => p.key === evidenceSubPhase)
                  return EVIDENCE_SUBPASSES.map((sp, i) => {
                    const done = !isParallel && activeIdx > i
                    const active = isParallel || activeIdx === i
                    return (
                      <div key={sp.key} title={sp.detail} style={{
                        display: 'flex', alignItems: 'center', gap: '0.3rem',
                        padding: '0.2rem 0.55rem', borderRadius: '3px', fontSize: '0.72rem',
                        border: done ? '1px solid rgba(122,53,40,0.4)' : active ? '1px solid var(--gold)' : '1px solid rgba(212,188,138,0.25)',
                        background: done ? 'rgba(122,53,40,0.12)' : active ? 'rgba(212,188,138,0.15)' : 'transparent',
                        color: done ? 'rgba(122,53,40,0.9)' : active ? 'var(--ink)' : 'var(--ink-faint)',
                        opacity: (!done && !active) ? 0.4 : 1,
                        transition: 'all 0.3s',
                      }}>
                        {done && <span style={{ fontSize: '0.5rem' }}>✦</span>}
                        {active && <span style={{ width: '0.45rem', height: '0.45rem', borderRadius: '50%', background: 'var(--gold)', display: 'inline-block', animation: 'pulse 1s ease-in-out infinite' }} />}
                        {sp.label}
                      </div>
                    )
                  })
                })()}
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--ink-faint)', marginTop: '0.45rem' }}>
                {candidatesSoFar} fragment{candidatesSoFar !== 1 ? 's' : ''} collected
              </div>
          </div>
          <p style={{ fontSize: '0.78rem', color: 'var(--ink-faint)', marginTop: '1rem', fontFamily: 'monospace' }}>
            {(elapsedMs / 1000).toFixed(1)}s elapsed
          </p>
        </StepActive>
      ) : phase === 'evidence-ready' ? (
        <StepActive n={4} label="Harvest evidence">
          {evidenceStale && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: '0.55rem',
              padding: '0.55rem 0.75rem', marginTop: '0.25rem', marginBottom: '0.75rem',
              borderRadius: '4px', background: 'rgba(180, 120, 20, 0.12)',
              border: '1px solid rgba(180, 120, 20, 0.35)',
            }}>
              <span style={{ fontSize: '0.72rem', lineHeight: 1, marginTop: '0.18rem' }}>⚠</span>
              <span style={{ fontSize: '0.82rem', color: 'var(--ink-muted)', lineHeight: 1.5 }}>
                Catalog has changed — previous evidence is outdated. Re-harvest to update.
              </span>
            </div>
          )}
          <p style={{ fontSize: '0.95rem', color: 'var(--ink-muted)', marginTop: '0.5rem', marginBottom: '1.25rem', lineHeight: 1.6 }}>
            Seven focused passes over all {sections.length} section{sections.length !== 1 ? 's' : ''}, anchored to {approvedCount} approved place{approvedCount !== 1 ? 's' : ''}:
            spatial claims, visual observations, routes, movement, access, containment, and entity deduplication.
          </p>
          <div style={{
            borderTop: '1px solid rgba(212, 188, 138, 0.5)',
            borderBottom: '1px solid rgba(212, 188, 138, 0.5)',
            padding: '0.65rem 0', marginBottom: '0.7rem',
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem',
          }}>
            <span style={{ fontSize: '0.68rem', color: 'var(--ink-muted)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
              Est. evidence cost
            </span>
            <span>
              {totalCost !== null ? (
                <span style={{ fontSize: '1rem', color: 'var(--ink)', fontFamily: 'monospace' }}>
                  ${evidenceCostLo.toFixed(2)} – ${evidenceCostHi.toFixed(2)}
                </span>
              ) : (
                <span style={{ fontSize: '1rem', color: 'var(--ink-faint)', fontFamily: 'monospace' }}>Estimating…</span>
              )}
            </span>
          </div>
          <p style={{ fontSize: '0.66rem', color: 'var(--ink-faint)', fontFamily: 'monospace', marginBottom: '1rem' }}>
            {document.original_filename} · {sections.length} section{sections.length !== 1 ? 's' : ''} · 7 passes · OpenAI
          </p>
          <button className="btn-cta" type="button" onClick={() => handleStartEvidence()}>
            Harvest evidence
          </button>
        </StepActive>
      ) : (
        <StepLocked n={4} label="Harvest evidence" detail="Available once the catalog is confirmed." />
      )}
      <StepConnector />

      {/* ── Step 5: Synthesize atlas ─────────────────────────────────── */}
      {step5Done && !synthesisStale ? (
        <StepDone
          label="Synthesize atlas"
          detail={`${canonicalEntityCount} place${canonicalEntityCount !== 1 ? 's' : ''} · ${canonicalClaimCount} relationship${canonicalClaimCount !== 1 ? 's' : ''} canonicalized`}
          action={
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <RerunCard
                label="Re-synthesize cost"
                costLo={synthCostLo}
                costHi={synthCostHi}
                meta={`${totalCandidates} candidate${totalCandidates !== 1 ? 's' : ''} · gpt-4o-mini`}
                action="Re-synthesize"
                onAction={() => handleSynthesize(true)}
              />
              {atlasEntities.length > 0 && (() => {
                const spatialClaims = atlasEntities.flatMap(e => e.claims.filter(c => c.claim_type === 'spatial'))
                const visualClaims = atlasEntities.flatMap(e => e.claims.filter(c => c.claim_type === 'visual'))
                return (
                  <>
                    <details>
                      <summary style={{ fontSize: '0.88rem', color: 'var(--ink-muted)', cursor: 'pointer', listStyle: 'none' }}>
                        Inspect canonical places ({canonicalEntityCount})
                      </summary>
                      <div style={{ marginTop: '0.65rem', display: 'flex', flexDirection: 'column', gap: '0.22rem' }}>
                        {atlasEntities
                          .slice()
                          .sort((a, b) => a.name.localeCompare(b.name))
                          .map(e => (
                            <div key={e.id} style={{ fontSize: '0.88rem', color: 'var(--ink)', display: 'flex', gap: '0.35rem', alignItems: 'baseline' }}>
                              <span style={{ flexShrink: 0, color: 'var(--gold)', fontSize: '0.58rem' }}>◉</span>
                              <span>{e.name}</span>
                              {e.place_kind && (
                                <span style={{ color: 'var(--ink-faint)', fontSize: '0.62rem' }}>· {e.place_kind}</span>
                              )}
                            </div>
                          ))}
                      </div>
                    </details>
                    {spatialClaims.length > 0 && (
                      <details>
                        <summary style={{ fontSize: '0.88rem', color: 'var(--ink-muted)', cursor: 'pointer', listStyle: 'none' }}>
                          Inspect spatial relationships ({spatialClaims.length})
                        </summary>
                        <div style={{ marginTop: '0.65rem', display: 'flex', flexDirection: 'column', gap: '0.22rem' }}>
                          {spatialClaims.map((c) => (
                            <div key={c.id} style={{ fontSize: '0.82rem', color: 'var(--ink)', display: 'flex', gap: '0.35rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                              <span style={{ flexShrink: 0, color: 'var(--gold)', fontSize: '0.58rem' }}>◈</span>
                              <span style={{ fontStyle: 'italic' }}>{String(c.payload.subject ?? '')}</span>
                              <span style={{ color: 'var(--ink-faint)', fontSize: '0.72rem', letterSpacing: '0.04em' }}>{c.predicate ?? String(c.payload.predicate ?? '')}</span>
                              <span style={{ fontStyle: 'italic' }}>{String(c.payload.object ?? '')}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    {visualClaims.length > 0 && (
                      <details>
                        <summary style={{ fontSize: '0.88rem', color: 'var(--ink-muted)', cursor: 'pointer', listStyle: 'none' }}>
                          Inspect visual descriptions ({visualClaims.length})
                        </summary>
                        <div style={{ marginTop: '0.65rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                          {visualClaims.map((c) => (
                            <div key={c.id} style={{ fontSize: '0.82rem', color: 'var(--ink)' }}>
                              <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'baseline' }}>
                                <span style={{ flexShrink: 0, color: 'var(--gold)', fontSize: '0.58rem' }}>◈</span>
                                <span style={{ fontStyle: 'italic' }}>{String(c.payload.subject ?? '')}</span>
                                {c.payload.category && (
                                  <span style={{ color: 'var(--ink-faint)', fontSize: '0.72rem' }}>· {String(c.payload.category)}</span>
                                )}
                              </div>
                              {c.payload.observation && (
                                <div style={{ marginLeft: '1.1rem', color: 'var(--ink-muted)', fontSize: '0.78rem', marginTop: '0.1rem' }}>
                                  {String(c.payload.observation)}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    {atlasTravelRules.length > 0 && (
                      <details>
                        <summary style={{ fontSize: '0.88rem', color: 'var(--ink-muted)', cursor: 'pointer', listStyle: 'none' }}>
                          Inspect movements & routes ({atlasTravelRules.length})
                        </summary>
                        <div style={{ marginTop: '0.65rem', display: 'flex', flexDirection: 'column', gap: '0.22rem' }}>
                          {atlasTravelRules.map((r) => (
                            <div key={r.id} style={{ fontSize: '0.82rem', color: 'var(--ink)', display: 'flex', gap: '0.35rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                              <span style={{ flexShrink: 0, color: 'var(--gold)', fontSize: '0.58rem' }}>→</span>
                              <span>{r.route ?? `${String(r.payload.from_place ?? r.payload.from ?? '')} → ${String(r.payload.to_place ?? r.payload.to ?? '')}`}</span>
                              {r.traveler && (
                                <span style={{ color: 'var(--ink-faint)', fontSize: '0.72rem' }}>({r.traveler})</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </>
                )
              })()}
            </div>
          }
        />
      ) : step5Error ? (
        <StepActive n={5} label="Synthesize atlas">
          <p role="alert" style={{ color: 'var(--error-text)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
            {workflowError}
          </p>
          <button className="btn-cta" style={{ maxWidth: '200px' }} type="button" onClick={() => handleSynthesize(false)}>
            Retry
          </button>
        </StepActive>
      ) : phase === 'synthesizing' ? (
        <StepActive n={5} label="Synthesize atlas" processing>
          {(() => {
            const PARALLEL_PASSES: Array<{ key: string; label: string; detail: string }> = [
              { key: 'spatial',  label: 'Spatial claims',       detail: 'LOCATED_IN, CONTAINS, NEAR, ADJACENT_TO, SAME_AS' },
              { key: 'visual',   label: 'Visual observations',  detail: 'Appearance, atmosphere, color, material, scale' },
              { key: 'routes',   label: 'Routes',               detail: 'Traversal paths between places' },
              { key: 'access',   label: 'Access rules',         detail: 'Permitted, prohibited, and conditional entry' },
              { key: 'movement', label: 'Movement',             detail: 'Narrated journeys and character travel arcs' },
            ]
            const isParallel = synthPhase === 'parallel'
            const entitiesDone = isParallel
            const entitiesActive = synthPhase === 'entities'
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem', marginTop: '0.25rem' }}>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', opacity: entitiesDone ? 0.55 : 1, transition: 'opacity 0.4s' }}>
                  <SubPassDot done={entitiesDone} active={entitiesActive} />
                  <div>
                    <div style={{ fontSize: '0.88rem', color: 'var(--ink)', fontWeight: entitiesActive ? 600 : 400 }}>Entity consolidation</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--ink-faint)', marginTop: '0.1rem' }}>{`Merging ${sections.length}-section place list into canonical entries`}</div>
                  </div>
                </div>
                {PARALLEL_PASSES.map(p => (
                  <div key={p.key} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', opacity: isParallel ? 1 : 0.35, transition: 'opacity 0.4s' }}>
                    <SubPassDot done={false} active={isParallel} />
                    <div>
                      <div style={{ fontSize: '0.88rem', color: 'var(--ink)', fontWeight: isParallel ? 600 : 400 }}>{p.label}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--ink-faint)', marginTop: '0.1rem' }}>{p.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            )
          })()}
          <p style={{ fontSize: '0.78rem', color: 'var(--ink-faint)', marginTop: '1rem', fontFamily: 'monospace' }}>
            {(synthElapsedMs / 1000).toFixed(1)}s elapsed
          </p>
        </StepActive>
      ) : phase === 'inspecting' ? (
        <StepActive n={5} label="Synthesize atlas">
          <p style={{ fontSize: '0.95rem', color: 'var(--ink-muted)', marginTop: '0.5rem', marginBottom: '1rem', lineHeight: 1.6 }}>
            Six focused passes over {totalCandidates} evidence fragment{totalCandidates !== 1 ? 's' : ''}:
            Pass 1 consolidates all entity candidates into a canonical place list,
            then 5 targeted passes synthesize spatial claims, visual observations,
            routes, access rules, and movement.
          </p>

          {Object.keys(kindCounts).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem', marginBottom: '0.85rem' }}>
              {Object.entries(kindCounts)
                .sort(([, a], [, b]) => b - a)
                .map(([kind, count]) => (
                  <div key={kind} style={{
                    padding: '0.2rem 0.6rem', borderRadius: '3px',
                    border: '1px solid var(--border-warm)', background: 'var(--parchment-card)',
                    fontSize: '0.75rem', color: 'var(--ink-muted)',
                  }}>
                    <span style={{ color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
                    {' '}
                    <span style={{ color: 'var(--ink-faint)' }}>{kind}</span>
                  </div>
                ))}
            </div>
          )}

          <div style={{
            borderTop: '1px solid rgba(212, 188, 138, 0.5)',
            borderBottom: '1px solid rgba(212, 188, 138, 0.5)',
            padding: '0.65rem 0', marginBottom: '0.7rem',
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem',
          }}>
            <span style={{ fontSize: '0.68rem', color: 'var(--ink-muted)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
              Est. synthesis cost
            </span>
            <span style={{ fontSize: '1rem', color: 'var(--ink)', fontFamily: 'monospace' }}>
              ${synthCostLo.toFixed(2)} – ${synthCostHi.toFixed(2)}
            </span>
          </div>
          <p style={{ fontSize: '0.66rem', color: 'var(--ink-faint)', fontFamily: 'monospace', marginBottom: '1rem' }}>
            {totalCandidates} candidate{totalCandidates !== 1 ? 's' : ''} · gpt-4o-mini · OpenAI
          </p>
          <button className="btn-cta" type="button" onClick={() => handleSynthesize(false)}>
            Synthesize atlas
          </button>
        </StepActive>
      ) : synthesisStale && step5Done ? (
        <StepActive n={5} label="Synthesize atlas">
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: '0.55rem',
            padding: '0.55rem 0.75rem', marginTop: '0.25rem', marginBottom: '1rem',
            borderRadius: '4px', background: 'rgba(180, 120, 20, 0.12)',
            border: '1px solid rgba(180, 120, 20, 0.35)',
          }}>
            <span style={{ fontSize: '0.72rem', lineHeight: 1, marginTop: '0.18rem' }}>⚠</span>
            <span style={{ fontSize: '0.82rem', color: 'var(--ink-muted)', lineHeight: 1.5 }}>
              Evidence has changed — atlas is outdated. Re-synthesize to rebuild.
            </span>
          </div>
          <button className="btn-cta" type="button" onClick={() => handleSynthesize(true)}>
            Re-synthesize atlas
          </button>
        </StepActive>
      ) : (
        <StepLocked n={5} label="Synthesize atlas" detail="Reads all harvested evidence in one pass and writes the canonical atlas automatically." />
      )}
      <StepConnector />

      {/* ── Step 6: Atlas Explorer ───────────────────────────────── */}
      {step5Done && !synthesisStale ? (
        <StepDone
          label="Atlas Explorer"
          detail={`${canonicalEntityCount} place${canonicalEntityCount !== 1 ? 's' : ''} · no additional cost`}
          action={
            onViewAtlas ? (
              <button type="button" className="btn-cta" onClick={onViewAtlas}>
                Open Atlas Explorer →
              </button>
            ) : undefined
          }
        />
      ) : synthesisStale ? (
        <StepLocked n={6} label="Atlas Explorer" detail="Re-synthesize the atlas above to unlock the explorer." />
      ) : (
        <StepLocked n={6} label="Atlas Explorer" detail="Available once the atlas is synthesized." />
      )}
    </div>
  )
}
