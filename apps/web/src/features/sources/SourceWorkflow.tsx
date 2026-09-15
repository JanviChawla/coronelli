import { useEffect, useRef, useState } from 'react'
import { CandidatesTable } from '../candidates/CandidatesTable'
import { type Candidate, fetchCandidates } from '../candidates/candidateApi'
import { fetchPreflight, triggerExtraction } from './extractionApi'
import type { Document, Section } from './sourceApi'
import { ApprovedAtlasView } from '../atlas/ApprovedAtlasView'
import { ProvisionalAtlasView } from '../synthesis/ProvisionalAtlasView'
import { type SynthesisItem, fetchProvisionalAtlas, triggerSynthesis } from '../synthesis/synthesisApi'

interface Props {
  document: Document
  sections: Section[]
  onEditSections: () => void
}

type Phase = 'preflight' | 'ready' | 'extracting' | 'harvested' | 'synthesizing' | 'done' | 'error'

// ── Step chrome components ────────────────────────────────────────────────────

function StepDone({ label, detail, action }: {
  label: string
  detail: string
  action?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
      <span style={{ minWidth: '1.5rem', color: '#16a34a', fontWeight: 'bold', fontSize: '1.1rem', lineHeight: 1 }}>✓</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: '0.82rem', color: '#666', marginTop: '0.15rem' }}>{detail}</div>
        {action && <div style={{ marginTop: '0.5rem' }}>{action}</div>}
      </div>
    </div>
  )
}

function StepActive({ n, label, children }: {
  n: number
  label: string
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
      <span style={{
        minWidth: '1.5rem', width: '1.5rem', height: '1.5rem',
        border: '2px solid #111', borderRadius: '50%',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '0.72rem', fontWeight: 700, flexShrink: 0, marginTop: '0.05rem',
        background: '#111', color: '#fff',
      }}>
        {n}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, marginBottom: '0.6rem' }}>{label}</div>
        {children}
      </div>
    </div>
  )
}

function StepLocked({ n, label, detail }: { n: number; label: string; detail: string }) {
  return (
    <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', opacity: 0.35 }}>
      <span style={{
        minWidth: '1.5rem', width: '1.5rem', height: '1.5rem',
        border: '2px solid #999', borderRadius: '50%',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '0.72rem', fontWeight: 700, flexShrink: 0, marginTop: '0.05rem',
        color: '#999',
      }}>
        {n}
      </span>
      <div>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: '0.82rem', color: '#888', marginTop: '0.15rem' }}>{detail}</div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function SourceWorkflow({ document, sections, onEditSections }: Props) {
  const [phase, setPhase] = useState<Phase>('preflight')
  const [errorInStep, setErrorInStep] = useState<3 | 4>(3)
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
  const [synthesisItems, setSynthesisItems] = useState<SynthesisItem[]>([])
  const [synthesisFromCache, setSynthesisFromCache] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [atlasRefreshKey, setAtlasRefreshKey] = useState(0)

  useEffect(() => {
    initWorkflow()
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [document.id])

  async function initWorkflow() {
    setPhase('preflight')
    // Restore synthesis state if a completed run exists
    try {
      const atlas = await fetchProvisionalAtlas(document.id)
      if (atlas.items.length > 0) {
        setSynthesisItems(atlas.items)
        setSynthesisFromCache(true)
        const bySection: Record<string, Candidate[]> = {}
        let total = 0
        await Promise.all(sections.map(async (s) => {
          bySection[s.id] = await fetchCandidates(s.id)
          total += bySection[s.id].length
        }))
        setAllCandidates(bySection)
        setTotalCandidates(total)
        setPhase('done')
        return
      }
    } catch { /* no synthesis run yet */ }

    // Restore harvested state if candidates exist
    try {
      const bySection: Record<string, Candidate[]> = {}
      let total = 0
      await Promise.all(sections.map(async (s) => {
        bySection[s.id] = await fetchCandidates(s.id)
        total += bySection[s.id].length
      }))
      if (total > 0) {
        setAllCandidates(bySection)
        setTotalCandidates(total)
        setPhase('harvested')
        return
      }
    } catch { /* no candidates yet */ }

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

  async function handleHarvest() {
    setPhase('extracting')
    setCurrentIdx(0)
    setCandidatesSoFar(0)
    setWorkflowError(null)
    setAllCandidates({})

    const startTime = Date.now()
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - startTime), 100)

    let total = 0
    try {
      for (let i = 0; i < sections.length; i++) {
        setCurrentIdx(i + 1)
        setCurrentTitle(sections[i].title)
        const result = await triggerExtraction(sections[i].id)
        total += result.candidates.length
        setCandidatesSoFar(total)
      }

      if (timerRef.current) clearInterval(timerRef.current)
      setTotalElapsedMs(Date.now() - startTime)
      setTotalCandidates(total)

      const bySection: Record<string, Candidate[]> = {}
      await Promise.all(sections.map(async (s) => { bySection[s.id] = await fetchCandidates(s.id) }))
      setAllCandidates(bySection)
      setPhase('harvested')
    } catch (e) {
      if (timerRef.current) clearInterval(timerRef.current)
      setWorkflowError(e instanceof Error ? e.message : 'Extraction failed. Check your API key.')
      setErrorInStep(3)
      setPhase('error')
    }
  }

  async function handleSynthesize(force = false) {
    setPhase('synthesizing')
    try {
      const result = await triggerSynthesis(document.id, force)
      setSynthesisItems(result.items)
      setSynthesisFromCache(result.from_cache)
      setPhase('done')
    } catch (e) {
      setWorkflowError(e instanceof Error ? e.message : 'Synthesis failed.')
      setErrorInStep(4)
      setPhase('error')
    }
  }

  // Derived booleans for step state
  const step3Done = phase === 'harvested' || phase === 'synthesizing' || phase === 'done' || (phase === 'error' && errorInStep === 4)
  const step4Done = phase === 'done'
  const step3Error = phase === 'error' && errorInStep === 3
  const step4Error = phase === 'error' && errorInStep === 4

  return (
    <div>
      <p style={{ fontSize: '0.7rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>
        Source work
      </p>
      <h2 style={{ marginBottom: '2rem' }}>{document.title}</h2>

      {/* ── Step 1: Import source ───────────────────────────────────── */}
      <StepDone label="Import source" detail={document.original_filename} />

      {/* ── Step 2: Prepare sections ───────────────────────────────── */}
      <StepDone
        label="Prepare sections"
        detail={`${sections.length} section${sections.length !== 1 ? 's' : ''} ready`}
        action={
          <button type="button" onClick={onEditSections} style={{ fontSize: '0.8rem' }}>
            Review and edit
          </button>
        }
      />

      {/* ── Step 3: Harvest evidence ───────────────────────────────── */}
      {step3Done && (
        <StepDone
          label="Harvest evidence"
          detail={`${totalCandidates} candidate${totalCandidates !== 1 ? 's' : ''} extracted across ${sections.length} sections · ${(totalElapsedMs / 1000).toFixed(1)}s`}
          action={
            <details>
              <summary style={{ fontSize: '0.78rem', color: '#888', cursor: 'pointer' }}>
                Inspect raw candidates ({totalCandidates})
              </summary>
              <div style={{ marginTop: '0.75rem' }}>
                <CandidatesTable
                  sections={sections.map(s => ({ id: s.id, title: s.title }))}
                  candidates={allCandidates}
                />
              </div>
            </details>
          }
        />
      )}

      {phase === 'preflight' && (
        <StepActive n={3} label="Harvest evidence">
          <p style={{ fontSize: '0.85rem', color: '#888' }}>Checking cache and estimating cost…</p>
        </StepActive>
      )}

      {phase === 'ready' && (
        <StepActive n={3} label="Harvest evidence">
          <p style={{ fontSize: '0.82rem', color: '#555', marginBottom: '0.75rem' }}>
            Run the extraction model on each section to collect cartographic evidence — places, spatial
            claims, routes, and visual descriptions — before synthesis begins.
          </p>
          {totalCost !== null && (
            <p style={{ fontSize: '0.82rem', color: '#555', marginBottom: '0.75rem' }}>
              Estimated cost: <strong>${totalCost.toFixed(4)}</strong>
              {' · '}{sections.length} section{sections.length !== 1 ? 's' : ''} · OpenAI
              {cachedCount > 0 && <> · {cachedCount} cached</>}
            </p>
          )}
          <button type="button" onClick={handleHarvest} style={{ fontWeight: 600 }}>
            Harvest evidence
          </button>
          <p style={{ fontSize: '0.75rem', color: '#999', marginTop: '0.4rem' }}>
            Results stay local until you export.
          </p>
        </StepActive>
      )}

      {phase === 'extracting' && (
        <StepActive n={3} label="Harvest evidence">
          <p style={{ fontSize: '0.85rem', marginBottom: '0.2rem' }}>
            Section {currentIdx} of {sections.length}
            {currentTitle && <> · <em>{currentTitle}</em></>}
            {' · '}{(elapsedMs / 1000).toFixed(1)}s
          </p>
          <p style={{ fontSize: '0.82rem', color: '#666' }}>
            {candidatesSoFar} candidate{candidatesSoFar !== 1 ? 's' : ''} so far
          </p>
        </StepActive>
      )}

      {step3Error && (
        <StepActive n={3} label="Harvest evidence">
          <p role="alert" style={{ color: '#dc2626', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
            {workflowError}
          </p>
          <button type="button" onClick={handleHarvest}>Retry</button>
        </StepActive>
      )}

      {/* ── Step 4: Synthesize atlas ───────────────────────────────── */}
      {step4Done && (
        <StepDone
          label="Synthesize atlas"
          detail={`${synthesisItems.length} synthesis item${synthesisItems.length !== 1 ? 's' : ''} produced${synthesisFromCache ? ' · from cache' : ''}`}
        />
      )}

      {phase === 'harvested' && (
        <StepActive n={4} label="Synthesize atlas">
          <p style={{ fontSize: '0.82rem', color: '#555', marginBottom: '0.75rem' }}>
            Stage 2 reads all {totalCandidates} evidence fragment{totalCandidates !== 1 ? 's' : ''} in one pass
            and produces a consolidated provisional atlas — merging duplicates, proposing same-as
            identities, surfacing contradictions, and tracking where each place is first revealed.
          </p>
          <button type="button" onClick={() => handleSynthesize(false)} style={{ fontWeight: 600 }}>
            Synthesize atlas
          </button>
        </StepActive>
      )}

      {phase === 'synthesizing' && (
        <StepActive n={4} label="Synthesize atlas">
          <p style={{ fontSize: '0.85rem', color: '#888' }}>Synthesizing — this may take a moment…</p>
        </StepActive>
      )}

      {step4Error && (
        <StepActive n={4} label="Synthesize atlas">
          <p role="alert" style={{ color: '#dc2626', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
            {workflowError}
          </p>
          <button type="button" onClick={() => handleSynthesize(false)}>Retry</button>
        </StepActive>
      )}

      {!step3Done && !step3Error && !step4Error && (
        <StepLocked n={4} label="Synthesize atlas" detail="Reads all harvested evidence in one pass and consolidates it into a provisional atlas." />
      )}

      {/* ── Step 5: Review provisional atlas ──────────────────────── */}
      {step4Done ? (
        <StepActive n={5} label="Review provisional atlas">
          <p style={{ fontSize: '0.82rem', color: '#555', marginBottom: '0.75rem' }}>
            Approve, reject, or defer each synthesis item. Approved places and claims are written
            to the atlas. Same-as approvals merge duplicate entities. This step is iterative — you
            can re-synthesize at any time.
          </p>
          <ProvisionalAtlasView
            items={synthesisItems}
            documentId={document.id}
            onResynthesize={() => handleSynthesize(true)}
            onReviewed={() => setAtlasRefreshKey(k => k + 1)}
          />
        </StepActive>
      ) : (
        <StepLocked n={5} label="Review provisional atlas" detail="Approve, reject, or defer synthesis items. Same-as proposals merge entities; reveal events anchor places to their first chapter." />
      )}

      {/* ── Step 6: Approved atlas ─────────────────────────────────── */}
      {step4Done ? (
        <StepActive n={6} label="Approved atlas">
          <p style={{ fontSize: '0.82rem', color: '#555', marginBottom: '0.75rem' }}>
            The canonical atlas built from approved items. Export as an Atlas Package (JSON) to use
            in downstream tools or share with collaborators.
          </p>
          <ApprovedAtlasView documentId={document.id} documentTitle={document.title} refreshSignal={atlasRefreshKey} />
        </StepActive>
      ) : (
        <StepLocked n={6} label="Approved atlas" detail="The canonical place graph built from your review decisions. Export as an Atlas Package when ready." />
      )}
    </div>
  )
}
