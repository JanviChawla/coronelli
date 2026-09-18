import React, { useEffect, useRef, useState } from 'react'
import { CandidatesTable } from '../candidates/CandidatesTable'
import { type Candidate, fetchCandidates, fetchDocumentEntityCandidates, patchCandidateReviewState } from '../candidates/candidateApi'
import { fetchPreflight, triggerDocumentCatalog, getDocumentCatalogStatus, confirmDocumentCatalog, triggerEvidenceExtraction, getExtractionProgress, fetchPlaceSuggestions, addManualCandidate, triggerDocumentCatalogGap, getDocumentCatalogGapStatus, triggerDedupPass, getDedupStatus, promoteDedup, fetchDedupCandidates, type DedupCandidate } from './extractionApi'
import type { Document, Section } from './sourceApi'
import { fetchAtlas } from '../atlas/atlasApi'
import { triggerVisualSynthesis, getSynthesisProgress } from '../synthesis/synthesisApi'
import { AtlasEditor } from '../atlas/AtlasEditor'
import { AtlasExplorer } from '../atlas/AtlasExplorer'

interface Props {
  document: Document
  sections: Section[]
  onBack: () => void
  onEditSections: () => void
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

type StepStatus = 'done' | 'active' | 'running' | 'locked'

const SPATIAL_LEVEL_LABELS: Record<number, string> = { 0: 'Realm', 1: 'Territory', 2: 'Place', 3: 'Feature' }

interface CatalogPass {
  label: string
  candidates: Candidate[]
  sectionIds: Set<string>
}

function buildFirstPass(entities: Candidate[], label: string): CatalogPass {
  const sectionIds = new Set(entities.map(c => c.section_id))
  const seen = new Set<string>()
  const candidates: Candidate[] = []
  for (const c of entities) {
    const name = String((c.payload as Record<string, unknown>).name ?? '').toLowerCase()
    if (name && !seen.has(name)) { seen.add(name); candidates.push(c) }
  }
  return { label, candidates, sectionIds }
}

function buildPassesFromEntities(entities: Candidate[]): CatalogPass[] {
  const catalogEntities = entities.filter(e => e.source !== 'gap')
  const gapEntities = entities.filter(e => e.source === 'gap')
  const passes: CatalogPass[] = [buildFirstPass(catalogEntities, 'Catalog')]
  if (gapEntities.length > 0) {
    const knownNames = new Set(catalogEntities.map(c => String((c.payload as Record<string, unknown>).name ?? '').toLowerCase()))
    passes.push(buildGapPass(gapEntities, knownNames, 1))
  }
  return passes
}

function buildGapPass(
  newEntities: Candidate[],
  knownNames: Set<string>,
  passNumber: number,
): CatalogPass {
  const sectionIds = new Set(newEntities.map(c => c.section_id))
  const seen = new Set<string>()
  const candidates: Candidate[] = []
  for (const c of newEntities) {
    const name = String((c.payload as Record<string, unknown>).name ?? '').toLowerCase()
    if (name && !knownNames.has(name) && !seen.has(name)) { seen.add(name); candidates.push(c) }
  }
  return { label: `Gap pass ${passNumber}`, candidates, sectionIds }
}

// ── FooterStepPill (horizontal footer variant) ─────────────────────────────────

function FooterStepPill({ n: _n, label, detail, status, active, onClick }: {
  n: number; label: string; detail?: string; status: StepStatus
  active: boolean; onClick: () => void
}) {
  const isLocked = status === 'locked'
  return (
    <button
      type="button"
      onClick={isLocked ? undefined : onClick}
      disabled={isLocked}
      style={{
        flex: 1, display: 'flex', alignItems: 'center', gap: '0.6rem',
        padding: '0 1.25rem', height: '100%',
        background: active ? 'rgba(212,188,138,0.10)' : 'transparent',
        border: 'none',
        borderLeft: '1px solid var(--sidebar-border)',
        borderBottom: active ? '2px solid var(--gold)' : '2px solid transparent',
        cursor: isLocked ? 'default' : 'pointer', opacity: isLocked ? 0.32 : 1,
        transition: 'background 0.12s',
        textAlign: 'left',
      }}
    >
      <span style={{
        width: '1.25rem', height: '1.25rem', borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: status === 'done' ? '0.65rem' : '0.48rem', fontWeight: 700, lineHeight: 1,
        ...(status === 'done'
          ? { background: 'radial-gradient(circle at 40% 35%, #7a3528, #3d1208)', color: 'rgba(240,215,190,0.92)' }
          : status === 'running'
            ? { background: 'var(--step-active-circle)', color: '#fff' }
            : status === 'active'
              ? { border: '1.5px solid var(--gold)', color: 'var(--gold)' }
              : { background: 'rgba(212,188,138,0.06)', border: '1.5px solid rgba(212,188,138,0.14)' }),
      }} className={status === 'running' ? 'step-processing' : ''}>
        {status === 'done' ? '✓' : status === 'running' || status === 'active' ? '✦' : ''}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: '0.8rem',
          color: active ? 'var(--gold)' : status === 'locked' ? 'var(--sidebar-muted)' : 'var(--sidebar-text)',
          fontWeight: active ? 600 : 400, lineHeight: 1.2, whiteSpace: 'nowrap',
        }}>
          {label}
        </div>
        {detail && (
          <div style={{ fontSize: '0.6rem', color: 'var(--sidebar-muted)', lineHeight: 1.2, whiteSpace: 'nowrap' }}>
            {detail}
          </div>
        )}
      </div>
    </button>
  )
}

// ── Sub-pass dot (used during progress display) ───────────────────────────────
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

// ── Main component ────────────────────────────────────────────────────────────

export function SourceWorkflow({ document, sections, onBack, onEditSections, onEdit, onDelete }: Props) {
  const [phase, setPhase] = useState<Phase>('preflight')
  const [errorInStep, setErrorInStep] = useState<1 | 2 | 3>(1)
  const [totalCost, setTotalCost] = useState<number | null>(null)
  const [cachedCount, setCachedCount] = useState(0)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [gapSectionsDone, setGapSectionsDone] = useState(0)
  const [currentTitle, setCurrentTitle] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [candidatesSoFar, setCandidatesSoFar] = useState(0)
  const [totalCandidates, setTotalCandidates] = useState(0)
  const [totalElapsedMs, setTotalElapsedMs] = useState(0)
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  const [allCandidates, setAllCandidates] = useState<Record<string, Candidate[]>>({})
  const [canonicalEntityCount, setCanonicalEntityCount] = useState(0)
  const [canonicalClaimCount, setCanonicalClaimCount] = useState(0)
  const [synthElapsedMs, setSynthElapsedMs] = useState(0)
  const [synthPhase, setSynthPhase] = useState<string | null>(null)
  const [entityCandidates, setEntityCandidates] = useState<Candidate[]>([])
  const [catalogPasses, setCatalogPasses] = useState<CatalogPass[]>([])
  const [rejectedCandidateIds, setRejectedCandidateIds] = useState<Set<string>>(new Set())
  const [placeSuggestions, setPlaceSuggestions] = useState<string[]>([])
  const [addPlaceInput, setAddPlaceInput] = useState('')
  const [showAddSuggestions, setShowAddSuggestions] = useState(false)
  const [addingPlace, setAddingPlace] = useState(false)
  const addPlaceRef = useRef<HTMLDivElement>(null)
  const [runningGapPass, setRunningGapPass] = useState(false)
  const gapPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [dynamicSuggestions, setDynamicSuggestions] = useState<string[]>([])
  const suggestionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [evidenceSubPhase, setEvidenceSubPhase] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [confirmingCatalog, setConfirmingCatalog] = useState(false)
  const [hoveredCandidateId, setHoveredCandidateId] = useState<string | null>(null)
  const [tooltipY, setTooltipY] = useState(0)
  const [evidenceStale, setEvidenceStale] = useState(false)
  const [atlasStale, setAtlasStale] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const synthPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const evidencePollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const catalogPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [dedupDone, setDedupDone] = useState(false)
  const [runningDedup, setRunningDedup] = useState(false)
  const [dedupError, setDedupError] = useState<string | null>(null)
  const [dedupCount, setDedupCount] = useState(0)
  const dedupPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [dedupCandidates, setDedupCandidates] = useState<DedupCandidate[]>([])
  const [rejectedDedupIds, setRejectedDedupIds] = useState<Set<string>>(new Set())
  const [confirmingDedup, setConfirmingDedup] = useState(false)

  // ── New navigation state ──────────────────────────────────────────────────
  const [activeStep, setActiveStep] = useState<number>(1)
  const [atlasKey, setAtlasKey] = useState(0)
  const [showExplorer, setShowExplorer] = useState(false)

  useEffect(() => {
    if (!sections.length) return
    initWorkflow()
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (catalogPollRef.current) clearInterval(catalogPollRef.current)
      if (evidencePollRef.current) clearInterval(evidencePollRef.current)
      if (synthPollRef.current) clearInterval(synthPollRef.current)
      if (dedupPollRef.current) clearInterval(dedupPollRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id, sections.length])

  // Auto-navigate based on phase
  useEffect(() => {
    if (phase === 'preflight' || phase === 'ready') setActiveStep(1)
    else if (phase === 'cataloging') setActiveStep(1)
    else if (phase === 'catalog-review') setActiveStep(1)
    else if (phase === 'evidence-ready') setActiveStep(prev => Math.max(prev, 2))
    else if (phase === 'extracting') setActiveStep(2)
    else if (phase === 'inspecting') setActiveStep(prev => prev < 3 ? 3 : prev)
    else if (phase === 'synthesizing') setActiveStep(3)
    else if (phase === 'done') setActiveStep(prev => prev < 3 ? 3 : prev)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  async function initWorkflow() {
    setPhase('preflight')

    let catalogStatus: Awaited<ReturnType<typeof getDocumentCatalogStatus>> | null = null
    try { catalogStatus = await getDocumentCatalogStatus(document.id) } catch { /* unavailable */ }

    const catalogConfirmed = catalogStatus?.catalog_confirmed ?? false
    const catalogDone = catalogStatus != null && catalogStatus.status === 'completed' && catalogStatus.sections_done > 0

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

    if (catalogConfirmed) {
      try {
        const dedupStatus = await getDedupStatus(document.id)
        if (dedupStatus.status === 'completed') setDedupDone(true)
      } catch { /* non-critical */ }

      try {
        const synthProg = await getSynthesisProgress(document.id)
        if (synthProg.status === 'running') {
          setPhase('synthesizing')
          if (synthProg.current_phase) setSynthPhase(synthProg.current_phase)
          synthPollRef.current = setInterval(async () => {
            try {
              const prog = await getSynthesisProgress(document.id)
              if (prog.current_phase) setSynthPhase(prog.current_phase)
              if (prog.status !== 'running') {
                clearInterval(synthPollRef.current!)
                synthPollRef.current = null
                try {
                  const atlas = await fetchAtlas(document.id)
                  setCanonicalEntityCount(atlas.entity_count)
                  setCanonicalClaimCount(atlas.claim_count)
                } catch { /* atlas may not be ready yet */ }
                setPhase('done')
              }
            } catch { /* ignore transient poll errors */ }
          }, 2000)
          return
        }
      } catch { /* synthesis progress unavailable */ }

      try {
        const atlas = await fetchAtlas(document.id)
        if (atlas.entity_count > 0) {
          const bySection: Record<string, Candidate[]> = {}
          let total = 0
          await Promise.all(sections.map(async (s) => {
            bySection[s.id] = await fetchCandidates(s.id)
            total += bySection[s.id].length
          }))
          const evidenceTotal = Object.values(bySection).reduce(
            (sum, cands) => sum + cands.filter(c => c.kind !== 'entity').length, 0
          )
          if (evidenceTotal > 0) {
            setCanonicalEntityCount(atlas.entity_count)
            setCanonicalClaimCount(atlas.claim_count)
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
              setCatalogPasses(buildPassesFromEntities(entities))
              setRejectedCandidateIds(new Set(entities.filter(e => e.review_state === 'rejected').map(e => e.id)))
            } catch { /* non-critical */ }
            setPhase('done')
            return
          }
        }
      } catch { /* no atlas yet */ }

      try {
        const progChecks = await Promise.all(
          sections.map(s => getExtractionProgress(s.id).catch(() => ({ status: 'idle' as const, current_phase: null })))
        )
        if (progChecks.some(p => p.status === 'running')) {
          setPhase('extracting')
          evidencePollRef.current = setInterval(async () => {
            try {
              const checks = await Promise.all(
                sections.map(s => getExtractionProgress(s.id).catch(() => ({ status: 'idle' as const, current_phase: null })))
              )
              if (!checks.some(p => p.status === 'running')) {
                clearInterval(evidencePollRef.current!)
                evidencePollRef.current = null
                const bySection: Record<string, Candidate[]> = {}
                let grandTotal = 0
                await Promise.all(sections.map(async (s) => {
                  bySection[s.id] = await fetchCandidates(s.id)
                  grandTotal += bySection[s.id].length
                }))
                setAllCandidates(bySection)
                setTotalCandidates(grandTotal)
                setPhase('inspecting')
              }
            } catch { /* ignore transient poll errors */ }
          }, 3000)
          return
        }
      } catch { /* progress check unavailable */ }

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
          try {
            const entities = await fetchDocumentEntityCandidates(document.id)
            setEntityCandidates(entities)
            setCatalogPasses(buildPassesFromEntities(entities))
            setRejectedCandidateIds(new Set(entities.filter(e => e.review_state === 'rejected').map(e => e.id)))
          } catch { /* non-critical */ }
          setPhase('inspecting')
          return
        }
      } catch { /* no candidates yet */ }
    }

    if (catalogDone) {
      const [entities, suggestions] = await Promise.all([
        fetchDocumentEntityCandidates(document.id),
        fetchPlaceSuggestions(document.id),
      ])
      setEntityCandidates(entities)
      setCatalogPasses(buildPassesFromEntities(entities))
      setRejectedCandidateIds(new Set(entities.filter(e => e.review_state === 'rejected').map(e => e.id)))
      setPlaceSuggestions(suggestions)
      try {
        const bySection: Record<string, Candidate[]> = {}
        await Promise.all(sections.map(async (s) => { bySection[s.id] = await fetchCandidates(s.id) }))
        const evidenceCount = Object.values(bySection).reduce(
          (sum, cands) => sum + cands.filter(c => c.kind !== 'entity').length, 0
        )
        if (evidenceCount > 0 && !catalogConfirmed) {
          setEvidenceStale(true)
          setAtlasStale(true)
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

  async function _finishCatalogAndReview() {
    const [entities, suggestions] = await Promise.all([
      fetchDocumentEntityCandidates(document.id),
      fetchPlaceSuggestions(document.id),
    ])
    setEntityCandidates(entities)
    setCatalogPasses(buildPassesFromEntities(entities))
    setPlaceSuggestions(suggestions)
    setAddPlaceInput('')
    setPhase('catalog-review')
  }

  async function handleRunCatalog(force = false) {
    setPhase('cataloging')
    setCurrentIdx(0)
    setWorkflowError(null)
    setEntityCandidates([])
    setCatalogPasses([])
    setRejectedCandidateIds(new Set())
    if (force) { setEvidenceStale(true); setAtlasStale(true) }

    const startTime = Date.now()
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - startTime), 100)

    try {
      const job = await triggerDocumentCatalog(document.id, force)
      if (job.status === 'completed') {
        if (timerRef.current) clearInterval(timerRef.current)
        await _finishCatalogAndReview()
        return
      }
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
      setWorkflowError(e instanceof Error ? e.message : 'Catalog failed.')
      setErrorInStep(1)
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

  async function toggleRejectPersist(id: string) {
    const wasRejected = rejectedCandidateIds.has(id)
    const newState = wasRejected ? 'proposed' : 'rejected'
    setRejectedCandidateIds(prev => {
      const next = new Set(prev)
      if (wasRejected) next.delete(id)
      else next.add(id)
      return next
    })
    try {
      await patchCandidateReviewState(id, newState)
    } catch {
      setRejectedCandidateIds(prev => {
        const next = new Set(prev)
        if (wasRejected) next.add(id)
        else next.delete(id)
        return next
      })
    }
  }

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
      setAtlasKey(k => k + 1)
      setPhase('evidence-ready')
    } catch (e) {
      setWorkflowError(e instanceof Error ? e.message : 'Failed to confirm catalog.')
    } finally {
      setConfirmingCatalog(false)
    }
  }

  async function handleStartEvidence() {
    setEvidenceStale(false)
    setAtlasStale(true)
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

        await triggerEvidenceExtraction(sectionId)
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
      setPhase('inspecting')
    } catch (e) {
      if (timerRef.current) clearInterval(timerRef.current)
      if (evidencePollRef.current) clearInterval(evidencePollRef.current)
      setWorkflowError(e instanceof Error ? e.message : 'Spatial claims failed.')
      setErrorInStep(2)
      setPhase('error')
    }
  }

  async function handleSynthesize(_force = false) {
    setAtlasStale(false)
    setPhase('synthesizing')
    setSynthElapsedMs(0)
    setSynthPhase(null)
    const synthStart = Date.now()
    timerRef.current = setInterval(() => setSynthElapsedMs(Date.now() - synthStart), 100)
    synthPollRef.current = setInterval(async () => {
      try {
        const prog = await getSynthesisProgress(document.id)
        if (prog.current_phase) setSynthPhase(prog.current_phase)
      } catch { /* ignore transient poll errors */ }
    }, 2000)
    try {
      await triggerVisualSynthesis(document.id)
      if (timerRef.current) clearInterval(timerRef.current)
      if (synthPollRef.current) clearInterval(synthPollRef.current)
      const atlas = await fetchAtlas(document.id)
      setCanonicalEntityCount(atlas.entity_count)
      setCanonicalClaimCount(atlas.claim_count)
      setPhase('done')
    } catch (e) {
      if (timerRef.current) clearInterval(timerRef.current)
      if (synthPollRef.current) clearInterval(synthPollRef.current)
      setWorkflowError(e instanceof Error ? e.message : 'Building claims failed.')
      setErrorInStep(3)
      setPhase('error')
    }
  }

  async function handleGapPass() {
    if (runningGapPass) return
    setRunningGapPass(true)
    setElapsedMs(0)
    setGapSectionsDone(0)
    const gapStart = Date.now()
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - gapStart), 100)
    try {
      await triggerDocumentCatalogGap(document.id)
      gapPollRef.current = setInterval(async () => {
        try {
          const status = await getDocumentCatalogGapStatus(document.id)
          setGapSectionsDone(prev => Math.max(prev, status.sections_done ?? 0))
          if (status.status === 'completed') {
            if (gapPollRef.current) clearInterval(gapPollRef.current)
            if (timerRef.current) clearInterval(timerRef.current)
            gapPollRef.current = null
            setRunningGapPass(false)
            const allEntities = await fetchDocumentEntityCandidates(document.id)
            const existingIds = new Set(entityCandidates.map(c => c.id))
            const newEntities = allEntities.filter(c => !existingIds.has(c.id))
            const knownNames = new Set(
              catalogPasses.flatMap(p => p.candidates.map(c =>
                String((c.payload as Record<string, unknown>).name ?? '').toLowerCase()
              ))
            )
            setEntityCandidates(allEntities)
            setCatalogPasses(prev => [...prev, buildGapPass(newEntities, knownNames, prev.length)])
          }
        } catch { /* keep polling */ }
      }, 2000)
    } catch {
      if (timerRef.current) clearInterval(timerRef.current)
      setRunningGapPass(false)
    }
  }

  async function handleDedupStep() {
    if (runningDedup) return
    setRunningDedup(true)
    setDedupError(null)
    setDedupCandidates([])
    setRejectedDedupIds(new Set())
    try {
      await triggerDedupPass(document.id)
      await new Promise<void>((resolve) => {
        dedupPollRef.current = setInterval(async () => {
          try {
            const status = await getDedupStatus(document.id)
            if (status.status === 'completed') {
              if (dedupPollRef.current) clearInterval(dedupPollRef.current)
              dedupPollRef.current = null
              resolve()
            }
          } catch { /* keep polling */ }
        }, 3000)
      })
      const candidates = await fetchDedupCandidates(document.id)
      if (candidates.length === 0) {
        // No duplicates found — auto-complete with 0 merges
        await promoteDedup(document.id)
        setDedupCount(0)
        setDedupDone(true)
      } else {
        setDedupCandidates(candidates)
      }
    } catch (e) {
      setDedupError(e instanceof Error ? e.message : 'Dedup failed.')
    } finally {
      setRunningDedup(false)
    }
  }

  async function handleConfirmDedup() {
    if (confirmingDedup) return
    setConfirmingDedup(true)
    try {
      if (rejectedDedupIds.size > 0) {
        await Promise.all([...rejectedDedupIds].map(id => patchCandidateReviewState(id, 'rejected')))
      }
      const result = await promoteDedup(document.id)
      setDedupCount(result.merges_performed)
      setAtlasKey(k => k + 1)
      setDedupCandidates([])
      setDedupDone(true)
    } catch (e) {
      setDedupError(e instanceof Error ? e.message : 'Dedup promotion failed.')
    } finally {
      setConfirmingDedup(false)
    }
  }

  async function handleExportAtlas() {
    try {
      const data = await fetchAtlas(document.id)
      const json = JSON.stringify(data, null, 2)
      const blob = new Blob([json], { type: 'application/json' })
      const blobUrl = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      anchor.href = blobUrl
      anchor.download = `atlas_${document.id.slice(0, 8)}.json`
      anchor.click()
      URL.revokeObjectURL(blobUrl)
    } catch { /* ignore */ }
  }

  async function handleAddManualPlace(name: string) {
    if (!name.trim() || addingPlace) return
    setAddingPlace(true)
    setShowAddSuggestions(false)
    setAddPlaceInput('')
    setDynamicSuggestions([])
    try {
      await addManualCandidate(document.id, name.trim())
      const allEntities = await fetchDocumentEntityCandidates(document.id)
      // Compute new entries before touching state — avoids StrictMode double-invoke bug
      // where nesting setCatalogPasses inside setEntityCandidates' updater causes double-append
      const existingIds = new Set(entityCandidates.map(c => c.id))
      const newEntities = allEntities.filter(c => !existingIds.has(c.id))
      setEntityCandidates(allEntities)
      if (newEntities.length > 0) {
        setCatalogPasses(passes => {
          if (passes.length === 0) return passes
          const updated = [...passes]
          const last = updated[updated.length - 1]
          updated[updated.length - 1] = {
            ...last,
            candidates: [...last.candidates, ...newEntities],
            sectionIds: new Set([...last.sectionIds, ...newEntities.map(c => c.section_id)]),
          }
          return updated
        })
      }
    } catch { /* ignore */ }
    setAddingPlace(false)
  }

  // ── Derived values ────────────────────────────────────────────────────────

  const catalogConfirmed = phase === 'evidence-ready' || phase === 'extracting' || phase === 'inspecting' || phase === 'synthesizing' || phase === 'done' || (phase === 'error' && errorInStep > 1)
  const catalogError = phase === 'error' && errorInStep === 1
  const spatialError = phase === 'error' && errorInStep === 2
  const atlasDone = phase === 'done'
  const atlasError = phase === 'error' && errorInStep === 3

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

  const uniqueEntityCandidates = catalogPasses.flatMap(p => p.candidates)
  const rejectedCount = rejectedCandidateIds.size
  const approvedCount = uniqueEntityCandidates.length - rejectedCount

  // Enrichment passes (containment + dedup) cost — scales with approved entity count
  const enrichInputTokens = approvedCount * 120 + 1500
  const enrichOutputTokens = approvedCount * 40 + 400
  const enrichCostBase = (enrichInputTokens / 1_000_000) * 0.15 + (enrichOutputTokens / 1_000_000) * 0.60
  const enrichCostLo = Math.max(enrichCostBase * 0.85, 0.0001)
  const enrichCostHi = enrichCostBase * 1.15

  const existingCandidateNames = new Set(uniqueEntityCandidates.map(c => String((c.payload as Record<string, unknown>).name ?? '').toLowerCase()))
  const filteredSuggestions = addPlaceInput.length >= 1
    ? (dynamicSuggestions.length > 0 ? dynamicSuggestions : placeSuggestions.filter(s =>
        s.toLowerCase().includes(addPlaceInput.toLowerCase())
      )).filter(s => !existingCandidateNames.has(s.toLowerCase())).slice(0, 8)
    : []

  const allCandidatesList = Object.values(allCandidates).flat()
  const kindCounts = allCandidatesList.reduce<Record<string, number>>((acc, c) => {
    acc[c.kind] = (acc[c.kind] ?? 0) + 1
    return acc
  }, {})

  // ── Step status ───────────────────────────────────────────────────────────

  function getStepStatus(n: number): StepStatus {
    if (n === 1) {
      if (phase === 'cataloging') return 'running'
      if (catalogConfirmed || phase === 'catalog-review') return 'done'
      return 'active'
    }
    if (n === 2) {
      if (phase === 'extracting') return 'running'
      if (spatialDone) return 'done'
      if (catalogConfirmed) return 'active'
      return 'locked'
    }
    if (n === 3) {
      if (runningDedup || phase === 'synthesizing') return 'running'
      if (atlasDone && !atlasStale && dedupDone) return 'done'
      if (spatialDone) return 'active'
      return 'locked'
    }
    return 'locked'
  }

  const spatialDone = phase === 'inspecting' || phase === 'synthesizing' || phase === 'done'
  const PIPELINE_STEPS = [
    { label: 'Catalog',     detail: catalogConfirmed ? `${approvedCount} approved · ${rejectedCount} rejected` : phase === 'cataloging' ? `${currentIdx} / ${sections.length} sections` : 'Find all named locations' },
    { label: 'Extract',     detail: spatialDone ? `${totalCandidates} claim${totalCandidates !== 1 ? 's' : ''} found` : catalogConfirmed ? 'Spatial + visual from text' : 'Unlock after catalog' },
    { label: 'Synthesize',  detail: atlasDone && !atlasStale && dedupDone ? `${canonicalClaimCount} relationship${canonicalClaimCount !== 1 ? 's' : ''} · ${canonicalEntityCount} entities` : spatialDone ? 'Dedup · containment · visual' : 'Unlock after extraction' },
  ]

  // ── Footer tray content ───────────────────────────────────────────────────

  function renderTrayContent(): React.ReactNode {
    const row: React.CSSProperties = { display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }

    if (activeStep === 1) {
      if (catalogError) return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--error-text)' }}>{workflowError}</span>
          <button className="btn-cta" type="button" onClick={() => handleRunCatalog()} style={{ fontSize: '0.78rem', padding: '0.3rem 0.9rem', width: 'auto' }}>Retry</button>
        </div>
      )
      if (phase === 'preflight') return (
        <div style={row}><span style={{ fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>Estimating cost…</span></div>
      )
      if (phase === 'ready') return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>
            Est. <span style={{ fontFamily: 'monospace', color: 'var(--sidebar-text)' }}>
              {totalCost !== null ? `$${catalogCostLo.toFixed(2)}–$${catalogCostHi.toFixed(2)}` : '…'}
            </span>
          </span>
          <span style={{ fontSize: '0.72rem', color: 'var(--sidebar-muted)', fontFamily: 'monospace' }}>
            {sections.length} section{sections.length !== 1 ? 's' : ''}{cachedCount > 0 ? ` · ${cachedCount} cached` : ''}
          </span>
          <button className="btn-cta" type="button" onClick={() => handleRunCatalog()} style={{ fontSize: '0.78rem', padding: '0.3rem 0.9rem', width: 'auto' }}>Find places</button>
        </div>
      )
      if (phase === 'cataloging') return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--sidebar-text)', fontFamily: 'monospace' }}>§{currentIdx} / {sections.length}</span>
          <div style={{ width: '8rem', height: '2px', borderRadius: '1px', background: 'rgba(212,188,138,0.15)', overflow: 'hidden' }}>
            <div style={{ height: '100%', background: 'var(--gold)', width: `${sections.length > 0 ? Math.round((currentIdx / sections.length) * 100) : 0}%`, transition: 'width 1.5s ease' }} />
          </div>
          <span style={{ fontSize: '0.72rem', color: 'var(--sidebar-muted)', fontFamily: 'monospace' }}>{(elapsedMs / 1000).toFixed(1)}s</span>
        </div>
      )
      if (phase === 'catalog-review') return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>{approvedCount} approved · {rejectedCount} rejected</span>
          <button type="button" onClick={handleGapPass} disabled={runningGapPass}
            style={{ background: 'none', border: '1px solid var(--sidebar-border)', borderRadius: '3px', cursor: runningGapPass ? 'default' : 'pointer', fontSize: '0.72rem', color: 'var(--gold)', opacity: runningGapPass ? 0.5 : 1, padding: '0.25rem 0.6rem' }}>
            {runningGapPass ? 'Scanning…' : '+ Gap pass'}
          </button>
          <div ref={addPlaceRef} style={{ position: 'relative' }}>
            <input type="text" placeholder="Add place…" value={addPlaceInput} disabled={addingPlace}
              onChange={e => {
                const val = e.target.value; setAddPlaceInput(val); setShowAddSuggestions(true)
                if (suggestionDebounceRef.current) clearTimeout(suggestionDebounceRef.current)
                if (val.trim().length >= 2) {
                  suggestionDebounceRef.current = setTimeout(async () => {
                    const results = await fetchPlaceSuggestions(document.id, val.trim())
                    setDynamicSuggestions(results)
                  }, 300)
                } else { setDynamicSuggestions([]) }
              }}
              onFocus={() => setShowAddSuggestions(true)}
              onBlur={() => setTimeout(() => setShowAddSuggestions(false), 150)}
              onKeyDown={e => {
                if (e.key === 'Enter' && addPlaceInput.trim()) handleAddManualPlace(addPlaceInput.trim())
                if (e.key === 'Escape') { setShowAddSuggestions(false); setAddPlaceInput('') }
              }}
              style={{ padding: '0.28rem 0.6rem', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--sidebar-border)', borderRadius: '3px', color: 'var(--sidebar-text)', fontSize: '0.78rem', outline: 'none', width: '160px' }}
            />
            {showAddSuggestions && filteredSuggestions.length > 0 && (
              <div style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 10, background: 'var(--parchment-card)', border: '1px solid var(--border-warm)', borderRadius: '4px 4px 0 0', boxShadow: '0 -4px 12px rgba(0,0,0,0.12)', maxHeight: '6rem', overflowY: 'auto' }}>
                {filteredSuggestions.map(s => (
                  <button key={s} type="button" onMouseDown={() => handleAddManualPlace(s)}
                    style={{ width: '100%', padding: '0.3rem 0.5rem', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: '0.78rem', color: 'var(--ink)', borderBottom: '1px solid rgba(212,188,138,0.12)' }}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="btn-cta" type="button" onClick={handleConfirmCatalog} disabled={confirmingCatalog} style={{ fontSize: '0.78rem', padding: '0.3rem 0.9rem', width: 'auto' }}>
            {confirmingCatalog ? 'Confirming…' : 'Confirm catalog →'}
          </button>
          {workflowError && <span style={{ fontSize: '0.72rem', color: 'var(--error-text)' }}>{workflowError}</span>}
        </div>
      )
      if (catalogConfirmed) return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>{approvedCount} approved</span>
          <button className="btn-rerun" type="button" onClick={() => handleRunCatalog(true)} style={{ fontSize: '0.72rem' }}>Re-catalog</button>
        </div>
      )
      return null
    }

    if (activeStep === 2) {
      if (phase === 'extracting') return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--sidebar-text)', fontFamily: 'monospace' }}>§{currentIdx} / {sections.length}</span>
          <div style={{ width: '8rem', height: '2px', borderRadius: '1px', background: 'rgba(212,188,138,0.15)', overflow: 'hidden' }}>
            <div style={{ height: '100%', background: 'var(--gold)', width: `${sections.length > 0 ? Math.round((currentIdx / sections.length) * 100) : 0}%`, transition: 'width 1.5s ease' }} />
          </div>
          <span style={{ fontSize: '0.72rem', color: 'var(--sidebar-muted)', fontFamily: 'monospace' }}>{candidatesSoFar} claims · {(elapsedMs / 1000).toFixed(1)}s</span>
        </div>
      )
      if (spatialError) return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--error-text)' }}>{workflowError}</span>
          <button className="btn-cta" type="button" onClick={handleStartEvidence} style={{ fontSize: '0.78rem', padding: '0.3rem 0.9rem', width: 'auto' }}>Retry</button>
        </div>
      )
      if (spatialDone) return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>{Object.values(allCandidates).flat().filter(c => c.kind !== 'entity').length} claims found</span>
          <button className="btn-rerun" type="button" onClick={handleStartEvidence} style={{ fontSize: '0.72rem' }}>Re-run</button>
        </div>
      )
      if (evidenceStale) return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'rgba(180,120,20,0.85)' }}>Catalog changed — re-run.</span>
          <button className="btn-cta" type="button" onClick={handleStartEvidence} style={{ fontSize: '0.78rem', padding: '0.3rem 0.9rem', width: 'auto' }}>Re-run extraction</button>
        </div>
      )
      if (catalogConfirmed) return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>
            Est. <span style={{ fontFamily: 'monospace', color: 'var(--sidebar-text)' }}>
              {totalCost !== null ? `$${evidenceCostLo.toFixed(2)}–$${evidenceCostHi.toFixed(2)}` : '…'}
            </span>
          </span>
          <span style={{ fontSize: '0.72rem', color: 'var(--sidebar-muted)', fontFamily: 'monospace' }}>{sections.length} sections · 2 passes</span>
          <button className="btn-cta" type="button" onClick={handleStartEvidence} style={{ fontSize: '0.78rem', padding: '0.3rem 0.9rem', width: 'auto' }}>Run extraction</button>
        </div>
      )
      return <div style={row}><span style={{ fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>Complete catalog first.</span></div>
    }

    if (activeStep === 3) {
      if (!spatialDone) return <div style={row}><span style={{ fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>Complete extraction first.</span></div>
      if (atlasError) return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--error-text)' }}>{workflowError}</span>
          <button className="btn-cta" type="button" onClick={() => handleSynthesize(false)} style={{ fontSize: '0.78rem', padding: '0.3rem 0.9rem', width: 'auto' }}>Retry</button>
        </div>
      )
      if (dedupError && !dedupDone) return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--error-text)' }}>{dedupError}</span>
          <button className="btn-cta" type="button" onClick={handleDedupStep} style={{ fontSize: '0.78rem', padding: '0.3rem 0.9rem', width: 'auto' }}>Retry dedup</button>
        </div>
      )
      if (runningDedup) return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--sidebar-text)' }}>Deduplicating…</span>
          <div style={{ width: '5rem', height: '2px', borderRadius: '1px', background: 'rgba(212,188,138,0.15)', overflow: 'hidden' }}>
            <div className="step-processing" style={{ height: '100%', width: '40%', background: 'var(--gold)' }} />
          </div>
        </div>
      )
      if (dedupCandidates.length > 0 && !dedupDone) return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>
            {dedupCandidates.length - rejectedDedupIds.size} merge{(dedupCandidates.length - rejectedDedupIds.size) !== 1 ? 's' : ''} to apply — reject in panel
          </span>
          <button className="btn-cta" type="button" onClick={handleConfirmDedup} disabled={confirmingDedup} style={{ fontSize: '0.78rem', padding: '0.3rem 0.9rem', width: 'auto' }}>
            {confirmingDedup ? 'Confirming…' : `Confirm ${dedupCandidates.length - rejectedDedupIds.size} merge${(dedupCandidates.length - rejectedDedupIds.size) !== 1 ? 's' : ''} →`}
          </button>
        </div>
      )
      if (phase === 'synthesizing') return (
        <div style={row}>
          <SubPassDot done={false} active={true} />
          <span style={{ fontSize: '0.78rem', color: 'var(--sidebar-text)' }}>Synthesizing visual claims…</span>
          <span style={{ fontSize: '0.72rem', color: 'var(--sidebar-muted)', fontFamily: 'monospace' }}>{(synthElapsedMs / 1000).toFixed(1)}s</span>
        </div>
      )
      if (atlasDone && !atlasStale && dedupDone) return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>
            {dedupCount === 0 ? 'No duplicates.' : `${dedupCount} merge${dedupCount !== 1 ? 's' : ''}.`}{' '}
            {canonicalClaimCount} relationship{canonicalClaimCount !== 1 ? 's' : ''} · {canonicalEntityCount} entities
          </span>
          <button className="btn-rerun" type="button" onClick={() => handleSynthesize(true)} style={{ fontSize: '0.72rem' }}>Re-run</button>
        </div>
      )
      if (atlasStale) return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'rgba(180,120,20,0.85)' }}>Catalog changed — re-run.</span>
          <button className="btn-cta" type="button" onClick={() => handleSynthesize(true)} style={{ fontSize: '0.78rem', padding: '0.3rem 0.9rem', width: 'auto' }}>Re-run</button>
        </div>
      )
      if (dedupDone) return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>
            {dedupCount === 0 ? 'No duplicates found.' : `${dedupCount} merge${dedupCount !== 1 ? 's' : ''} performed.`}
          </span>
          <span style={{ fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>
            Est. <span style={{ fontFamily: 'monospace', color: 'var(--sidebar-text)' }}>${synthCostLo.toFixed(2)}–${synthCostHi.toFixed(2)}</span>
          </span>
          <button className="btn-cta" type="button" onClick={() => handleSynthesize(false)} style={{ fontSize: '0.78rem', padding: '0.3rem 0.9rem', width: 'auto' }}>Add visual claims →</button>
        </div>
      )
      return (
        <div style={row}>
          <span style={{ fontSize: '0.78rem', color: 'var(--sidebar-muted)' }}>
            Est. <span style={{ fontFamily: 'monospace', color: 'var(--sidebar-text)' }}>${enrichCostLo.toFixed(4)}–${enrichCostHi.toFixed(4)}</span>
            {' · '}{approvedCount} entities
          </span>
          <button className="btn-cta" type="button" onClick={handleDedupStep} style={{ fontSize: '0.78rem', padding: '0.3rem 0.9rem', width: 'auto' }}>Deduplicate entities</button>
        </div>
      )
    }

    return null
  }

  // ── Right panel content ───────────────────────────────────────────────────

  function renderStepContent(_step: number) {
    const isReadOnly = !catalogConfirmed
    const pendingClaims = !atlasDone
      ? Object.values(allCandidates).flat()
          .filter(c => c.kind === 'claim')
          .map(c => {
            const p = c.payload as Record<string, unknown>
            return {
              id: c.id,
              subject: String(p.subject ?? ''),
              predicate: String(p.predicate ?? ''),
              object: String(p.object ?? ''),
            }
          })
          .filter(c => c.subject && c.predicate && c.object)
      : []
    if (showExplorer) {
      return (
        <AtlasExplorer
          documentId={document.id}
          sections={sections.map(s => ({ id: s.id, title: s.title ?? '' }))}
          onAtlasLoaded={count => setCanonicalEntityCount(count)}
        />
      )
    }

    return (
      <AtlasEditor
        key={atlasKey}
        documentId={document.id}
        readOnly={isReadOnly}
        canExplore={phase === 'done'}
        pendingClaims={pendingClaims}
        catalogCandidates={phase === 'catalog-review' ? uniqueEntityCandidates.map(c => ({
          id: c.id,
          name: String((c.payload as Record<string, unknown>).name ?? ''),
          excerpt: c.excerpt ?? null,
          source: c.source ?? 'catalog',
          isRejected: rejectedCandidateIds.has(c.id),
        })) : []}
        onToggleCatalogReject={toggleReject}
        dedupProposals={dedupCandidates.length > 0 && !dedupDone ? dedupCandidates.map(c => ({
          id: c.id,
          subject: c.subject,
          object: c.object,
          rationale: c.rationale ?? null,
          isRejected: rejectedDedupIds.has(c.id),
        })) : []}
        onToggleDedupReject={(id) => setRejectedDedupIds(prev => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })}
        hideHeader={true}
        onConfirmCatalog={handleConfirmCatalog}
        confirmingCatalog={confirmingCatalog}
        confirmCatalogSlot={phase === 'catalog-review' ? (
          <div ref={addPlaceRef} style={{ position: 'relative' }}>
            <input
              type="text" placeholder="+ Add place…" value={addPlaceInput} disabled={addingPlace}
              onChange={e => {
                const val = e.target.value; setAddPlaceInput(val); setShowAddSuggestions(true)
                if (suggestionDebounceRef.current) clearTimeout(suggestionDebounceRef.current)
                if (val.trim().length >= 2) {
                  suggestionDebounceRef.current = setTimeout(async () => {
                    const results = await fetchPlaceSuggestions(document.id, val.trim())
                    setDynamicSuggestions(results)
                  }, 300)
                } else { setDynamicSuggestions([]) }
              }}
              onFocus={() => setShowAddSuggestions(true)}
              onBlur={() => setTimeout(() => setShowAddSuggestions(false), 150)}
              onKeyDown={e => {
                if (e.key === 'Enter' && addPlaceInput.trim()) handleAddManualPlace(addPlaceInput.trim())
                if (e.key === 'Escape') { setShowAddSuggestions(false); setAddPlaceInput('') }
              }}
              style={{ padding: '0.22rem 0.55rem', background: 'rgba(212,188,138,0.07)', border: '1px solid var(--border-warm)', borderRadius: '4px', color: 'var(--ink)', fontSize: '0.72rem', outline: 'none', width: '140px' }}
            />
            {showAddSuggestions && filteredSuggestions.length > 0 && (
              <div style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--parchment-card)', border: '1px solid var(--border-warm)', borderRadius: '4px 4px 0 0', boxShadow: '0 -4px 12px rgba(0,0,0,0.18)', maxHeight: '8rem', overflowY: 'auto' }}>
                {filteredSuggestions.map(s => (
                  <button key={s} type="button" onMouseDown={() => handleAddManualPlace(s)}
                    style={{ width: '100%', padding: '0.3rem 0.6rem', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: '0.75rem', color: 'var(--ink)', borderBottom: '1px solid rgba(212,188,138,0.12)' }}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : undefined}
        onConfirmDedup={handleConfirmDedup}
        confirmingDedup={confirmingDedup}
        dedupConfirmCount={dedupCandidates.length - rejectedDedupIds.size}
        onDone={() => setShowExplorer(true)}
      />
    )
  }
  // ── Render ────────────────────────────────────────────────────────────────

  // ── Compact pipeline item helpers ────────────────────────────────────────

  const cBtn = (clickable: boolean, gold = false): React.CSSProperties => ({
    fontSize: '0.72rem', padding: '0.22rem 0.6rem',
    background: clickable ? (gold ? 'rgba(212,188,138,0.13)' : 'rgba(212,188,138,0.07)') : 'rgba(212,188,138,0.03)',
    border: `1px solid ${clickable ? (gold ? 'rgba(212,188,138,0.45)' : 'rgba(212,188,138,0.28)') : 'rgba(212,188,138,0.1)'}`,
    borderRadius: '4px', cursor: clickable ? 'pointer' : 'default',
    color: clickable ? (gold ? 'var(--gold)' : 'var(--ink)') : 'var(--ink-faint)',
    opacity: clickable ? 1 : 0.45,
    display: 'flex', alignItems: 'center', gap: '0.15rem',
    whiteSpace: 'nowrap' as const, transition: 'background 0.12s',
  })

  const tinyLink: React.CSSProperties = {
    fontSize: '0.62rem', background: 'none', border: 'none',
    cursor: 'pointer', color: 'var(--ink-muted)', padding: 0,
    textDecoration: 'underline', textDecorationStyle: 'dotted' as const,
  }

  const tinyConfirm: React.CSSProperties = {
    fontSize: '0.62rem', background: 'none', border: 'none',
    cursor: 'pointer', color: 'var(--gold)', padding: 0, fontWeight: 500,
  }

  const subTxt: React.CSSProperties = { fontSize: '0.62rem', color: 'var(--ink-faint)' }
  const costFmt = (lo: number, hi: number) => `($${lo.toFixed(2)}–$${hi.toFixed(2)})`
  const pSep = <span style={{ color: 'rgba(212,188,138,0.3)', fontSize: '0.9rem', alignSelf: 'flex-start', paddingTop: '0.28rem', flexShrink: 0 }}>›</span>

  function renderCatalogItem() {
    const isRunning = phase === 'cataloging'
    const inReview = phase === 'catalog-review'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.18rem', alignItems: 'flex-start' }}>
        <button type="button" disabled={isRunning || phase === 'preflight'}
          onClick={() => !isRunning && !catalogError ? handleRunCatalog(catalogConfirmed) : handleRunCatalog()}
          style={cBtn(!(isRunning || phase === 'preflight'))}>
          {isRunning ? 'Finding…' : catalogConfirmed ? 'Re-catalog' : 'Catalog'}
          <span style={{ opacity: 0.55, fontSize: '0.67rem' }}>
            {totalCost !== null ? ` ${costFmt(catalogCostLo, catalogCostHi)}` : ' (…)'}
          </span>
        </button>
        {isRunning && <span style={{ ...subTxt, fontFamily: 'monospace' }}>§{currentIdx}/{sections.length}</span>}
        {catalogError && <span style={{ ...subTxt, color: 'var(--error-text)' }}>Error · <button style={tinyLink} onClick={() => handleRunCatalog()}>retry</button></span>}
        {(inReview || catalogConfirmed) && !catalogError && (
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'nowrap' }}>
            <span style={subTxt}>{approvedCount} found</span>
            {inReview && (
              <>
                <button type="button" style={tinyLink} onClick={handleGapPass} disabled={runningGapPass}>
                  {runningGapPass ? 'scanning…' : 'gap +'}
                </button>
                <button type="button" style={tinyConfirm} onClick={handleConfirmCatalog} disabled={confirmingCatalog}>
                  {confirmingCatalog ? 'confirming…' : 'Confirm →'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  function renderExtractItem() {
    const locked = !catalogConfirmed
    const isRunning = phase === 'extracting'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.18rem', alignItems: 'flex-start' }}>
        <button type="button" disabled={locked || isRunning}
          onClick={locked || isRunning ? undefined : handleStartEvidence}
          style={cBtn(!locked && !isRunning)}>
          {isRunning ? 'Extracting…' : spatialDone ? 'Re-extract' : 'Extract'}
          <span style={{ opacity: 0.55, fontSize: '0.67rem' }}> {costFmt(evidenceCostLo, evidenceCostHi)}</span>
        </button>
        {isRunning && <span style={{ ...subTxt, fontFamily: 'monospace' }}>§{currentIdx}/{sections.length} · {candidatesSoFar} claims</span>}
        {spatialError && <span style={{ ...subTxt, color: 'var(--error-text)' }}>Error · <button style={tinyLink} onClick={handleStartEvidence}>retry</button></span>}
        {spatialDone && !spatialError && !isRunning && <span style={subTxt}>{totalCandidates} claims</span>}
        {evidenceStale && <span style={{ ...subTxt, color: 'rgba(180,120,20,0.85)' }}>stale</span>}
      </div>
    )
  }

  function renderDedupItem() {
    const locked = !spatialDone
    const isRunning = runningDedup || phase === 'synthesizing'
    const needsConfirm = dedupCandidates.length > 0 && !dedupDone
    const toConfirm = dedupCandidates.length - rejectedDedupIds.size
    const label = isRunning
      ? 'Synthesizing…'
      : atlasDone && !atlasStale && dedupDone ? 'Re-synthesize'
      : 'Synthesize'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.18rem', alignItems: 'flex-start' }}>
        <button type="button" disabled={locked || isRunning}
          onClick={locked || isRunning ? undefined : (dedupDone ? () => handleSynthesize(false) : handleDedupStep)}
          style={cBtn(!locked && !isRunning)}>
          {label}
          <span style={{ opacity: 0.55, fontSize: '0.67rem' }}>
            {' '}{costFmt(dedupDone ? synthCostLo : enrichCostLo, dedupDone ? synthCostHi : enrichCostHi)}
          </span>
        </button>
        {(dedupError && !dedupDone) && <span style={{ ...subTxt, color: 'var(--error-text)' }}>Error · <button style={tinyLink} onClick={handleDedupStep}>retry</button></span>}
        {atlasError && <span style={{ ...subTxt, color: 'var(--error-text)' }}>Error · <button style={tinyLink} onClick={() => handleSynthesize(false)}>retry</button></span>}
        {needsConfirm && !isRunning && (
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <span style={subTxt}>{toConfirm} merge{toConfirm !== 1 ? 's' : ''}</span>
            <button type="button" style={tinyConfirm} onClick={handleConfirmDedup} disabled={confirmingDedup}>
              {confirmingDedup ? 'confirming…' : 'Confirm →'}
            </button>
          </div>
        )}
        {atlasDone && !atlasStale && dedupDone && !isRunning && (
          <span style={subTxt}>{dedupCount} dedup{dedupCount !== 1 ? 's' : ''} · {canonicalEntityCount} entities</span>
        )}
        {atlasStale && <span style={{ ...subTxt, color: 'rgba(180,120,20,0.85)' }}>stale</span>}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Brand header: CORONELLI (= back link) + book title ───────────────── */}
      <header style={{
        flexShrink: 0, display: 'flex', alignItems: 'center',
        background: 'var(--sidebar-bg)', borderBottom: '1px solid var(--sidebar-border)',
        height: '2.6rem', padding: '0 1.5rem',
      }}>
        <button type="button" onClick={onBack} style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.24em',
          color: 'var(--gold)', textTransform: 'uppercase', flexShrink: 0,
          transition: 'opacity 0.12s',
        }} title="Back to library">
          Coronelli
        </button>
        <div style={{ flex: 1, textAlign: 'center', fontSize: '0.85rem', color: 'var(--sidebar-text)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 2rem' }}>
          {document.title}
        </div>
      </header>

      {/* ── Atlas Editor header row ───────────────────────────────────────────── */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.65rem',
        background: 'var(--parchment)', borderBottom: '1px solid var(--border-warm)',
        padding: '0.55rem 1.5rem',
      }}>
        {/* Atlas Editor label */}
        <span style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', flexShrink: 0 }}>
          Atlas Editor
        </span>

        {/* Separator */}
        <div style={{ width: '1px', height: '1.1rem', background: 'var(--border-warm)', flexShrink: 0, marginLeft: '0.15rem', marginRight: '0.15rem' }} />

        {/* Catalog button — "Catalog +" (gap pass) after first run */}
        {(() => {
          const catalogRunOnce = phase !== 'preflight' && phase !== 'ready'
          const isCataloging = phase === 'cataloging'
          const label = isCataloging ? 'Finding…' : catalogRunOnce ? 'Catalog +' : 'Catalog'
          const clickable = !isCataloging && phase !== 'preflight'
          const handler = catalogRunOnce ? handleGapPass : () => handleRunCatalog(false)
          return (
            <button type="button"
              disabled={!clickable || runningGapPass}
              onClick={clickable && !runningGapPass ? handler : undefined}
              style={cBtn(clickable && !runningGapPass)}>
              {runningGapPass ? 'Scanning…' : label}
              {totalCost !== null && <span style={{ opacity: 0.55, fontSize: '0.67rem', marginLeft: '0.1rem' }}>
                ({catalogCostLo.toFixed(2)}–{catalogCostHi.toFixed(2)})
              </span>}
            </button>
          )
        })()}

        {/* Extract button — "Extract +" after first run */}
        <button type="button"
          disabled={!catalogConfirmed || phase === 'extracting'}
          onClick={catalogConfirmed && phase !== 'extracting' ? handleStartEvidence : undefined}
          style={cBtn(catalogConfirmed && phase !== 'extracting')}>
          {phase === 'extracting' ? 'Extracting…' : spatialDone ? 'Extract +' : 'Extract'}
          <span style={{ opacity: 0.55, fontSize: '0.67rem', marginLeft: '0.1rem' }}>
            ({evidenceCostLo.toFixed(2)}–{evidenceCostHi.toFixed(2)})
          </span>
        </button>

        {/* Deduplicate / Synthesize button */}
        {(() => {
          const locked = !spatialDone
          const isRunning = runningDedup || phase === 'synthesizing'
          const label = isRunning
            ? (runningDedup ? 'Synthesizing…' : 'Synthesizing…')
            : atlasDone && dedupDone ? 'Re-synthesize'
            : 'Synthesize'
          const costLo = dedupDone ? synthCostLo : enrichCostLo
          const costHi = dedupDone ? synthCostHi : enrichCostHi
          return (
            <>
              <button type="button"
                disabled={locked || isRunning}
                onClick={locked || isRunning ? undefined : (dedupDone ? () => handleSynthesize(false) : handleDedupStep)}
                style={cBtn(!locked && !isRunning)}>
                {label}
                <span style={{ opacity: 0.55, fontSize: '0.67rem', marginLeft: '0.1rem' }}>
                  ({costLo.toFixed(2)}–{costHi.toFixed(2)})
                </span>
              </button>
            </>
          )
        })()}

        {/* Export button */}
        <button type="button"
          disabled={!atlasDone}
          onClick={atlasDone ? handleExportAtlas : undefined}
          style={{ ...cBtn(atlasDone), color: atlasDone ? 'var(--gold)' : undefined, border: atlasDone ? '1px solid rgba(212,188,138,0.4)' : undefined }}>
          Export atlas.json ↓
        </button>

        {/* Push Launch Explorer to the right */}
        <div style={{ flex: 1 }} />

        {/* Launch / Back toggle */}
        <button type="button" className="btn-cta"
          disabled={!atlasDone && !showExplorer}
          onClick={() => setShowExplorer(v => !v)}
          style={{ display: 'inline-flex', alignItems: 'center', width: 'auto', flexShrink: 0, padding: '0.32rem 0.9rem', fontSize: '0.78rem', opacity: atlasDone || showExplorer ? 1 : 0.38, cursor: atlasDone || showExplorer ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap' }}>
          {showExplorer ? '← Atlas Editor' : 'Launch Atlas Explorer'}
        </button>
      </div>

      {/* ── Section progress bar ─────────────────────────────────────────────── */}
      {(phase === 'cataloging' || phase === 'extracting' || runningGapPass) && sections.length > 0 && (
        <div style={{ flexShrink: 0, background: 'var(--parchment)', borderBottom: '1px solid var(--border-warm)', padding: '0.3rem 1.5rem 0.35rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {(() => {
            const sectionsDone = runningGapPass ? gapSectionsDone : currentIdx
            const label = runningGapPass ? 'Gap scan' : phase === 'cataloging' ? 'Cataloging' : 'Extracting'
            const pct = Math.max(2, (sectionsDone / sections.length) * 100)
            return (
              <>
                <span style={{ fontSize: '0.62rem', color: 'var(--ink-faint)', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
                  {label} section {sectionsDone} of {sections.length}
                </span>
                <div style={{ flex: 1, height: '3px', borderRadius: '2px', background: 'rgba(212,188,138,0.15)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: '2px', background: 'var(--gold)', width: `${pct}%`, transition: 'width 0.4s ease' }} />
                </div>
              </>
            )
          })()}
          <span style={{ fontSize: '0.62rem', color: 'var(--ink-faint)', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
            {phase === 'extracting' && candidatesSoFar > 0 ? `${candidatesSoFar} claims · ` : ''}{(elapsedMs / 1000).toFixed(1)}s
          </span>
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────────────────── */}
      <main style={{ flex: 1, overflow: 'hidden', backgroundColor: 'var(--parchment)', display: 'flex', flexDirection: 'column' }}>
        {renderStepContent(activeStep)}
      </main>

    </div>
  )
}
