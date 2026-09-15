import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
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

// ── Step chrome ───────────────────────────────────────────────────────────────

const CIRCLE: CSSProperties = {
  width: '2rem',
  height: '2rem',
  borderRadius: '50%',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '0.8rem',
  fontWeight: 700,
}

function StepDone({ label, detail, action }: {
  label: string
  detail: string
  action?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
      <div style={{ ...CIRCLE, background: 'var(--step-done)', color: '#fff', fontSize: '1rem' }}>✓</div>
      <div style={{ flex: 1, paddingTop: '0.3rem' }}>
        <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--ink)' }}>{label}</div>
        <div style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', marginTop: '0.1rem' }}>{detail}</div>
        {action && <div style={{ marginTop: '0.5rem' }}>{action}</div>}
      </div>
    </div>
  )
}

function StepActive({ n, label, children }: {
  n: number
  label: string
  children: ReactNode
}) {
  return (
    <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
      <div style={{ ...CIRCLE, background: 'var(--step-active-circle)', color: '#fff' }}>{n}</div>
      <div style={{ flex: 1, paddingTop: '0.25rem' }}>
        <div style={{
          fontWeight: 600, fontSize: '1.05rem',
          color: 'var(--step-active-label)', marginBottom: '0.65rem',
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
    <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', opacity: 0.38 }}>
      <div style={{ ...CIRCLE, border: '2px solid var(--step-locked)', color: 'var(--step-locked)' }}>{n}</div>
      <div style={{ flex: 1, paddingTop: '0.3rem' }}>
        <div style={{ fontWeight: 500, fontSize: '0.92rem', color: 'var(--ink-muted)' }}>{label}</div>
        <div style={{ fontSize: '0.75rem', color: 'var(--ink-faint)', marginTop: '0.1rem' }}>{detail}</div>
      </div>
    </div>
  )
}

function StepConnector() {
  return (
    <div style={{ display: 'flex', gap: '1rem', height: '1.5rem', margin: '0.2rem 0' }}>
      <div style={{ width: '2rem', flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '1px', height: '100%', background: 'var(--gold)', opacity: 0.35 }} />
      </div>
    </div>
  )
}

function Ornament() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '1rem 0 2rem' }}>
      <div style={{ flex: 1, height: '1px', background: 'var(--gold)', opacity: 0.3 }} />
      <span style={{ fontSize: '0.6rem', color: 'var(--gold)', opacity: 0.6 }}>◆</span>
      <div style={{ flex: 1, height: '1px', background: 'var(--gold)', opacity: 0.3 }} />
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

  const step3Done = phase === 'harvested' || phase === 'synthesizing' || phase === 'done' || (phase === 'error' && errorInStep === 4)
  const step4Done = phase === 'done'
  const step3Error = phase === 'error' && errorInStep === 3
  const step4Error = phase === 'error' && errorInStep === 4

  return (
    <div>
      {/* Document header */}
      <p style={{
        fontSize: '0.62rem', color: 'var(--ink-muted)',
        textTransform: 'uppercase', letterSpacing: '0.16em', marginBottom: '0.4rem',
      }}>
        Source work
      </p>
      <h2 style={{ fontSize: '1.9rem', fontWeight: 400, color: 'var(--ink)', lineHeight: 1.2 }}>
        {document.title}
      </h2>
      <Ornament />

      {/* ── Step 1 ──────────────────────────────────────────────────── */}
      <StepDone label="Import source" detail={document.original_filename} />
      <StepConnector />

      {/* ── Step 2 ──────────────────────────────────────────────────── */}
      <StepDone
        label="Prepare sections"
        detail={`${sections.length} section${sections.length !== 1 ? 's' : ''} ready`}
        action={
          <button
            type="button"
            className="btn-outline-warm"
            onClick={onEditSections}
          >
            Review and edit
          </button>
        }
      />
      <StepConnector />

      {/* ── Step 3: Harvest evidence ─────────────────────────────────── */}
      {step3Done ? (
        <StepDone
          label="Harvest evidence"
          detail={`${totalCandidates} candidate${totalCandidates !== 1 ? 's' : ''} across ${sections.length} sections · ${(totalElapsedMs / 1000).toFixed(1)}s`}
          action={
            <details>
              <summary style={{
                fontSize: '0.78rem', color: 'var(--ink-muted)',
                cursor: 'pointer', listStyle: 'none',
              }}>
                ▸ Inspect raw candidates ({totalCandidates})
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
      ) : step3Error ? (
        <StepActive n={3} label="Harvest evidence">
          <p role="alert" style={{ color: 'var(--error-text)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
            {workflowError}
          </p>
          <button className="btn-cta" style={{ maxWidth: '200px' }} type="button" onClick={handleHarvest}>
            Retry
          </button>
        </StepActive>
      ) : phase === 'extracting' ? (
        <StepActive n={3} label="Harvest evidence">
          <p style={{ fontSize: '0.85rem', color: 'var(--ink-muted)', marginBottom: '0.2rem' }}>
            Section {currentIdx} of {sections.length}
            {currentTitle && <> · <em>{currentTitle}</em></>}
            {' · '}{(elapsedMs / 1000).toFixed(1)}s
          </p>
          <p style={{ fontSize: '0.82rem', color: 'var(--ink-faint)' }}>
            {candidatesSoFar} candidate{candidatesSoFar !== 1 ? 's' : ''} so far
          </p>
        </StepActive>
      ) : phase === 'ready' ? (
        <StepActive n={3} label="Harvest evidence">
          <p style={{ fontSize: '0.82rem', color: 'var(--ink-muted)', marginBottom: '1rem', lineHeight: 1.55 }}>
            Run the extraction model on each section to collect cartographic evidence —
            places, spatial claims, routes, and visual descriptions — before synthesis begins.
          </p>
          <div style={{
            border: '1px solid var(--border-warm)',
            borderRadius: '6px',
            background: 'var(--parchment-card)',
            padding: '1.25rem 1.5rem',
            marginBottom: '0.6rem',
          }}>
            <p style={{
              fontSize: '0.58rem', color: 'var(--ink-muted)',
              letterSpacing: '0.16em', textTransform: 'uppercase',
              textAlign: 'center', marginBottom: '0.5rem',
            }}>
              Estimated extraction cost
            </p>
            <p style={{ textAlign: 'center', marginBottom: '0.5rem' }}>
              {totalCost !== null ? (
                <span style={{ fontSize: '1.75rem', color: 'var(--ink)', fontWeight: 400 }}>
                  ${(totalCost * 0.85).toFixed(2)} – ${(totalCost * 1.15).toFixed(2)}
                </span>
              ) : (
                <span style={{ fontSize: '1.1rem', color: 'var(--ink-faint)' }}>Estimating…</span>
              )}
            </p>
            <p style={{
              fontSize: '0.7rem', color: 'var(--ink-faint)',
              textAlign: 'center', fontFamily: 'monospace', marginBottom: '1.1rem',
            }}>
              {document.original_filename} · {sections.length} section{sections.length !== 1 ? 's' : ''} · OpenAI provider
              {cachedCount > 0 && ` · ${cachedCount} cached`}
            </p>
            <button className="btn-cta" type="button" onClick={handleHarvest}>
              Harvest evidence
            </button>
          </div>
          <p style={{ fontSize: '0.7rem', color: 'var(--ink-faint)', textAlign: 'center' }}>
            ● Results stay local until you export.
          </p>
        </StepActive>
      ) : (
        <StepActive n={3} label="Harvest evidence">
          <p style={{ fontSize: '0.82rem', color: 'var(--ink-faint)' }}>
            Checking sections and estimating cost…
          </p>
        </StepActive>
      )}
      <StepConnector />

      {/* ── Step 4: Synthesize atlas ─────────────────────────────────── */}
      {step4Done ? (
        <StepDone
          label="Synthesize atlas"
          detail={`${synthesisItems.length} synthesis item${synthesisItems.length !== 1 ? 's' : ''} produced${synthesisFromCache ? ' · from cache' : ''}`}
        />
      ) : step4Error ? (
        <StepActive n={4} label="Synthesize atlas">
          <p role="alert" style={{ color: 'var(--error-text)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
            {workflowError}
          </p>
          <button className="btn-cta" style={{ maxWidth: '200px' }} type="button" onClick={() => handleSynthesize(false)}>
            Retry
          </button>
        </StepActive>
      ) : phase === 'synthesizing' ? (
        <StepActive n={4} label="Synthesize atlas">
          <p style={{ fontSize: '0.82rem', color: 'var(--ink-faint)' }}>
            Synthesizing — this may take a moment…
          </p>
        </StepActive>
      ) : phase === 'harvested' ? (
        <StepActive n={4} label="Synthesize atlas">
          <p style={{ fontSize: '0.82rem', color: 'var(--ink-muted)', marginBottom: '1rem', lineHeight: 1.55 }}>
            Stage 2 reads all {totalCandidates} evidence fragment{totalCandidates !== 1 ? 's' : ''} in one pass
            and produces a consolidated provisional atlas — merging duplicates, proposing same-as
            identities, surfacing contradictions, and tracking where each place is first revealed.
          </p>
          <button className="btn-cta" style={{ maxWidth: '240px' }} type="button" onClick={() => handleSynthesize(false)}>
            Synthesize atlas
          </button>
        </StepActive>
      ) : (
        <StepLocked n={4} label="Synthesize atlas" detail="Reads all harvested evidence in one pass and consolidates it into a provisional atlas." />
      )}
      <StepConnector />

      {/* ── Step 5: Review provisional atlas ─────────────────────────── */}
      {step4Done ? (
        <StepActive n={5} label="Review provisional atlas">
          <p style={{ fontSize: '0.82rem', color: 'var(--ink-muted)', marginBottom: '0.85rem', lineHeight: 1.55 }}>
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
      <StepConnector />

      {/* ── Step 6: Approved atlas ────────────────────────────────────── */}
      {step4Done ? (
        <StepActive n={6} label="Approved atlas">
          <p style={{ fontSize: '0.82rem', color: 'var(--ink-muted)', marginBottom: '0.85rem', lineHeight: 1.55 }}>
            The canonical atlas built from approved items. Export as an Atlas Package (JSON) to use
            in downstream tools or share with collaborators.
          </p>
          <ApprovedAtlasView
            documentId={document.id}
            documentTitle={document.title}
            refreshSignal={atlasRefreshKey}
          />
        </StepActive>
      ) : (
        <StepLocked n={6} label="Approved atlas" detail="The canonical place graph built from your review decisions. Export as an Atlas Package when ready." />
      )}
    </div>
  )
}
