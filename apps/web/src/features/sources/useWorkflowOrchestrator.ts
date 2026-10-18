import { useCallback, useEffect, useRef, useState } from 'react'
import type { Candidate } from '../candidates/candidateApi'
import { fetchCandidates, fetchDocumentEntityCandidates, patchCandidateReviewState } from '../candidates/candidateApi'
import {
  fetchPreflight, getDocumentCatalogStatus, confirmDocumentCatalog,
  triggerEvidenceExtraction, getExtractionProgress, fetchPlaceSuggestions,
  addManualCandidate, triggerDocumentCatalogGap, getDocumentCatalogGapStatus,
  triggerDedupPass, getDedupStatus, promoteDedup, fetchDedupCandidates,
  triggerCatalogExtraction, triggerSectionCatalogGap, confirmSectionCatalog,
  openDocumentEventStream, validateCatalog,
  type DedupCandidate, type CatalogValidationSuggestion,
} from './extractionApi'
import type { Document, Section } from './sourceApi'
import { fetchAtlas, promoteContainmentHierarchy } from '../atlas/atlasApi'
import { triggerVisualSynthesis, getSynthesisProgress } from '../synthesis/synthesisApi'
import type { Phase, StepStatus, Toast } from './workflowTypes'
import { buildGapPass, buildPassesFromEntities, type CatalogPass } from './catalogPassUtils'

export function useWorkflowOrchestrator(document: Document, sections: Section[]) {
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
  const [confirmingCatalog, setConfirmingCatalog] = useState(false)
  const [evidenceStale, setEvidenceStale] = useState(false)
  const [atlasStale, setAtlasStale] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const synthPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const evidencePollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const catalogPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [dedupDone, setDedupDone] = useState(false)
  const [runningDedup, setRunningDedup] = useState(false)
  const [dedupError, setDedupError] = useState<string | null>(null)
  const [dedupCount, setDedupCount] = useState(0)
  const dedupPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [dedupCandidates, setDedupCandidates] = useState<DedupCandidate[]>([])
  const [rejectedDedupIds, setRejectedDedupIds] = useState<Set<string>>(new Set())
  const [confirmingDedup, setConfirmingDedup] = useState(false)
  const [gapFindings, setGapFindings] = useState<string[] | null>(null)
  const [gapReviewPending, setGapReviewPending] = useState(false)
  const [webSuggestions, setWebSuggestions] = useState<CatalogValidationSuggestion[] | null>(null)
  const [webCheckCost, setWebCheckCost] = useState<number | null>(null)
  const [validatingWeb, setValidatingWeb] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [activeStep, setActiveStep] = useState<number>(1)
  const [atlasKey, setAtlasKey] = useState(0)
  const [showExplorer, setShowExplorer] = useState(false)

  function addToast(message: string, kind: 'info' | 'success' | 'warn' = 'info') {
    const id = Math.random().toString(36).slice(2)
    setToasts(prev => [...prev, { id, message, kind }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500)
  }

  useEffect(() => {
    if (!sections.length) return
    initWorkflow()
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (catalogPollRef.current) clearInterval(catalogPollRef.current)
      if (evidencePollRef.current) clearInterval(evidencePollRef.current)
      if (synthPollRef.current) clearInterval(synthPollRef.current)
      if (dedupPollRef.current) clearInterval(dedupPollRef.current)
      if (esRef.current) { esRef.current.close(); esRef.current = null }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id, sections.length])

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

    const catalogConfirmedNow = catalogStatus?.catalog_confirmed ?? false
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

    if (catalogConfirmedNow) {
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
          if (evidenceTotal > 0 && atlas.claim_count > 0) {
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
        if (evidenceCount > 0 && !catalogConfirmedNow) {
          setEvidenceStale(true)
          setAtlasStale(true)
        }
      } catch { /* non-critical */ }
      await loadPreflight()
      setPhase(catalogConfirmedNow ? 'evidence-ready' : 'catalog-review')
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
    setCurrentIdx(0)
    setWorkflowError(null)
    setEntityCandidates([])
    setCatalogPasses([])
    setRejectedCandidateIds(new Set())
    if (force) { setEvidenceStale(true); setAtlasStale(true) }

    const startTime = Date.now()
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - startTime), 100)
    setElapsedMs(0)
    setPhase('cataloging')

    try {
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i]
        setCurrentIdx(i)
        setCurrentTitle(section.title)
        await triggerCatalogExtraction(section.id, force)
        await triggerSectionCatalogGap(section.id)
        await confirmSectionCatalog(section.id)
      }
      if (timerRef.current) clearInterval(timerRef.current)
      await _finishCatalogAndReview()
    } catch (e) {
      if (timerRef.current) clearInterval(timerRef.current)
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
      setGapReviewPending(false)
      setGapFindings(null)
      setPhase('evidence-ready')
      addToast('Catalog confirmed — run Extract to include new places.', 'success')
    } catch (e) {
      setWorkflowError(e instanceof Error ? e.message : 'Failed to confirm catalog.')
    } finally {
      setConfirmingCatalog(false)
    }
  }

  async function handleStartEvidence() {
    setEvidenceStale(false)
    setAtlasStale(true)
    setGapFindings(null)
    setPhase('extracting')
    setCurrentIdx(0)
    setCandidatesSoFar(0)
    setEvidenceSubPhase(null)
    setAllCandidates({})

    const startTime = Date.now()
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - startTime), 100)

    esRef.current = openDocumentEventStream(document.id, (event) => {
      if (event.type === 'phase_change' && event.stage === 'evidence') {
        setEvidenceSubPhase(event.phase)
      }
    })

    try {
      let total = 0
      for (let i = 0; i < sections.length; i++) {
        setCurrentIdx(i + 1)
        setCurrentTitle(sections[i].title)
        setEvidenceSubPhase(null)
        await triggerEvidenceExtraction(sections[i].id)
        const sectionCandidates = await fetchCandidates(sections[i].id)
        total += sectionCandidates.filter(c => c.kind !== 'entity').length
        setCandidatesSoFar(total)
      }

      if (esRef.current) { esRef.current.close(); esRef.current = null }
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
      if (esRef.current) { esRef.current.close(); esRef.current = null }
      if (timerRef.current) clearInterval(timerRef.current)
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
    esRef.current = openDocumentEventStream(document.id, (event) => {
      if (event.type === 'phase_change') setSynthPhase(event.phase)
    })
    try {
      await triggerVisualSynthesis(document.id)
      if (esRef.current) { esRef.current.close(); esRef.current = null }
      if (timerRef.current) clearInterval(timerRef.current)
      let hierarchyClaims = 0
      try {
        const hResult = await promoteContainmentHierarchy(document.id)
        hierarchyClaims = hResult.claims_created
      } catch { /* non-critical */ }
      const atlas = await fetchAtlas(document.id)
      setCanonicalEntityCount(atlas.entity_count)
      setCanonicalClaimCount(atlas.claim_count)
      setAtlasKey(k => k + 1)
      setPhase('done')
      if (hierarchyClaims > 0) {
        addToast(`Hierarchy auto-built from ${hierarchyClaims} spatial relationship${hierarchyClaims !== 1 ? 's' : ''}.`, 'success')
      }
    } catch (e) {
      if (esRef.current) { esRef.current.close(); esRef.current = null }
      if (timerRef.current) clearInterval(timerRef.current)
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
            const foundNames = newEntities.map(c => String((c.payload as Record<string, unknown>).name ?? ''))
            setGapFindings(foundNames)
            if (phase !== 'catalog-review') {
              setGapReviewPending(true)
              if (foundNames.length > 0) {
                addToast(`Gap scan found ${foundNames.length} new place${foundNames.length !== 1 ? 's' : ''}: ${foundNames.slice(0, 3).join(', ')}${foundNames.length > 3 ? ` +${foundNames.length - 3} more` : ''}`, 'success')
              } else {
                addToast('Gap scan complete — no new locations found. You can still add places manually.', 'info')
              }
            }
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
        await promoteDedup(document.id)
        setDedupCount(0)
        setDedupDone(true)
        handleSynthesize(false)
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

  function handleInputChange(val: string) {
    setAddPlaceInput(val)
    setShowAddSuggestions(true)
    if (suggestionDebounceRef.current) clearTimeout(suggestionDebounceRef.current)
    if (val.trim().length >= 2) {
      suggestionDebounceRef.current = setTimeout(async () => {
        const results = await fetchPlaceSuggestions(document.id, val.trim())
        setDynamicSuggestions(results)
      }, 300)
    } else {
      setDynamicSuggestions([])
    }
  }

  const handleAtlasLoaded = useCallback((count: number) => {
    setCanonicalEntityCount(count)
  }, [])

  // ── Derived values ─────────────────────────────────────────────────────────

  const catalogConfirmed = phase === 'evidence-ready' || phase === 'extracting' || phase === 'inspecting' || phase === 'synthesizing' || phase === 'done' || (phase === 'error' && errorInStep > 1)
  const catalogError = phase === 'error' && errorInStep === 1
  const spatialError = phase === 'error' && errorInStep === 2
  const atlasDone = phase === 'done'
  const atlasError = phase === 'error' && errorInStep === 3
  const spatialDone = phase === 'inspecting' || phase === 'synthesizing' || phase === 'done' || (phase === 'error' && errorInStep >= 3)

  const totalCostBase = totalCost ?? sections.length * 0.0020
  const catalogCostBase = totalCostBase / 4
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

  const enrichInputTokens = approvedCount * 120 + 1500
  const enrichOutputTokens = approvedCount * 40 + 400
  const enrichCostBase = (enrichInputTokens / 1_000_000) * 0.15 + (enrichOutputTokens / 1_000_000) * 0.60
  const enrichCostLo = Math.max(enrichCostBase * 0.85, 0.0001)
  const enrichCostHi = enrichCostBase * 1.15

  const existingCandidateNames = new Set(
    uniqueEntityCandidates.map(c => String((c.payload as Record<string, unknown>).name ?? '').toLowerCase())
  )
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

  return {
    // Phase
    phase, errorInStep, workflowError, activeStep, showExplorer, atlasKey,
    // Progress
    totalCost, cachedCount, currentIdx, gapSectionsDone, currentTitle,
    elapsedMs, candidatesSoFar, totalCandidates, totalElapsedMs,
    synthElapsedMs, synthPhase, evidenceSubPhase,
    // Catalog
    entityCandidates, catalogPasses, rejectedCandidateIds,
    placeSuggestions, addPlaceInput, showAddSuggestions, addingPlace,
    addPlaceRef, dynamicSuggestions, runningGapPass, gapFindings, gapReviewPending,
    // Atlas
    allCandidates, canonicalEntityCount, canonicalClaimCount, evidenceStale, atlasStale,
    // Dedup
    dedupDone, runningDedup, dedupError, dedupCount, dedupCandidates,
    rejectedDedupIds, confirmingDedup,
    // Confirm state
    confirmingCatalog, confirmingDelete,
    // Web validation
    webSuggestions, webCheckCost, validatingWeb,
    // Toasts
    toasts,
    // Computed
    catalogConfirmed, catalogError, spatialError, atlasDone, atlasError, spatialDone,
    uniqueEntityCandidates, rejectedCount, approvedCount, filteredSuggestions,
    allCandidatesList, kindCounts,
    // Cost estimates
    catalogCostLo, catalogCostHi, evidenceCostLo, evidenceCostHi,
    synthCostLo, synthCostHi, enrichCostLo, enrichCostHi,
    // Handlers
    addToast, handleRunCatalog, toggleReject, toggleRejectPersist,
    handleConfirmCatalog, handleStartEvidence, handleSynthesize,
    handleGapPass, handleDedupStep, handleConfirmDedup, handleExportAtlas,
    handleAddManualPlace, handleAtlasLoaded, handleInputChange, getStepStatus,
    // Setters needed by inline subcomponents
    setShowExplorer, setRejectedDedupIds, setWebSuggestions, setValidatingWeb,
    setWebCheckCost, setAddPlaceInput, setShowAddSuggestions, setDynamicSuggestions,
  }
}
