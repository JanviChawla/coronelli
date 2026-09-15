import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { CandidatesTable } from '../candidates/CandidatesTable'
import { type Candidate, fetchCandidates } from '../candidates/candidateApi'
import { fetchPreflight, triggerCatalogExtraction, triggerEvidenceExtraction } from './extractionApi'
import type { Document, Section } from './sourceApi'
import { fetchAtlas } from '../atlas/atlasApi'
import type { AtlasEntity } from '../atlas/atlasApi'
import { triggerSynthesis } from '../synthesis/synthesisApi'

interface Props {
  document: Document
  sections: Section[]
  onEditSections: () => void
  onAtlasChanged?: () => void
  onViewAtlas?: () => void
  onEdit?: () => void
  onDelete?: () => void
}

type Phase = 'preflight' | 'ready' | 'extracting' | 'harvested' | 'synthesizing' | 'done' | 'error'

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
          <span style={{ fontSize: '1.05rem', color: 'var(--ink)', fontWeight: 400 }}>
            ${costLo.toFixed(2)} – ${costHi.toFixed(2)}
          </span>
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

// ── Main component ────────────────────────────────────────────────────────────

export function SourceWorkflow({ document, sections, onEditSections, onAtlasChanged, onViewAtlas, onEdit, onDelete }: Props) {
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
  const [canonicalEntityCount, setCanonicalEntityCount] = useState(0)
  const [canonicalClaimCount, setCanonicalClaimCount] = useState(0)
  const [atlasEntities, setAtlasEntities] = useState<AtlasEntity[]>([])
  const [synthElapsedMs, setSynthElapsedMs] = useState(0)
  const [synthPass, setSynthPass] = useState<1 | 2>(1)
  const [harvestPass, setHarvestPass] = useState<1 | 2>(1)
  const [catalogEntityCount, setCatalogEntityCount] = useState(0)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const synthPassTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!sections.length) return
    initWorkflow()
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id, sections.length])

  async function initWorkflow() {
    setPhase('preflight')
    try {
      const atlas = await fetchAtlas(document.id)
      if (atlas.entity_count > 0) {
        setCanonicalEntityCount(atlas.entity_count)
        setCanonicalClaimCount(atlas.claim_count)
        setAtlasEntities(atlas.entities)
        const bySection: Record<string, Candidate[]> = {}
        let total = 0
        await Promise.all(sections.map(async (s) => {
          bySection[s.id] = await fetchCandidates(s.id)
          total += bySection[s.id].length
        }))
        setAllCandidates(bySection)
        setTotalCandidates(total)
        // Fetch preflight to get per-book cost estimate (sum all sections, ignore cache_valid)
        try {
          const preflightResults = await Promise.all(sections.map((s) => fetchPreflight(s.id)))
          const cost = preflightResults.reduce((sum, r) => sum + (r.estimated_cost_usd ?? 0), 0)
          setTotalCost(cost)
        } catch { /* preflight optional in done state */ }
        setPhase('done')
        return
      }
    } catch { /* no atlas yet */ }

    try {
      const bySection: Record<string, Candidate[]> = {}
      let total = 0
      await Promise.all(sections.map(async (s) => {
        bySection[s.id] = await fetchCandidates(s.id)
        total += bySection[s.id].length
      }))
      // Only treat as "harvested" if evidence candidates exist (non-entity kinds)
      // Catalog-only pass produces entity candidates; evidence pass produces the rest.
      const evidenceCount = Object.values(bySection).reduce(
        (sum, cands) => sum + cands.filter(c => c.kind !== 'entity').length, 0
      )
      if (evidenceCount > 0) {
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

  async function handleHarvest(force = false) {
    setPhase('extracting')
    setHarvestPass(1)
    setCurrentIdx(0)
    setCandidatesSoFar(0)
    setCatalogEntityCount(0)
    setWorkflowError(null)
    setAllCandidates({})

    const startTime = Date.now()
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - startTime), 100)

    try {
      // ── Pass 1: Global pre-pass — catalog all sections ─────────────────────
      let entityTotal = 0
      for (let i = 0; i < sections.length; i++) {
        setCurrentIdx(i + 1)
        setCurrentTitle(sections[i].title)
        const result = await triggerCatalogExtraction(sections[i].id, force)
        entityTotal += result.candidates.length
        setCatalogEntityCount(entityTotal)
      }

      // ── Pass 2: Global evidence pass — extract using full entity list ───────
      setHarvestPass(2)
      setCurrentIdx(0)
      let total = 0
      for (let i = 0; i < sections.length; i++) {
        setCurrentIdx(i + 1)
        setCurrentTitle(sections[i].title)
        // Evidence pass never uses force — catalog already wiped old data if force=true
        const result = await triggerEvidenceExtraction(sections[i].id, false)
        total += result.candidates.length
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
    setSynthElapsedMs(0)
    setSynthPass(1)
    const synthStart = Date.now()
    timerRef.current = setInterval(() => setSynthElapsedMs(Date.now() - synthStart), 100)
    synthPassTimerRef.current = setTimeout(() => setSynthPass(2), 15000)
    try {
      await triggerSynthesis(document.id, force)
      if (timerRef.current) clearInterval(timerRef.current)
      if (synthPassTimerRef.current) clearTimeout(synthPassTimerRef.current)
      const atlas = await fetchAtlas(document.id)
      setCanonicalEntityCount(atlas.entity_count)
      setCanonicalClaimCount(atlas.claim_count)
      setAtlasEntities(atlas.entities)
      setPhase('done')
      onAtlasChanged?.()
    } catch (e) {
      if (timerRef.current) clearInterval(timerRef.current)
      if (synthPassTimerRef.current) clearTimeout(synthPassTimerRef.current)
      setWorkflowError(e instanceof Error ? e.message : 'Synthesis failed.')
      setErrorInStep(4)
      setPhase('error')
    }
  }

  const step3Done = phase === 'harvested' || phase === 'synthesizing' || phase === 'done' || (phase === 'error' && errorInStep === 4)
  const step4Done = phase === 'done'
  const step3Error = phase === 'error' && errorInStep === 3
  const step4Error = phase === 'error' && errorInStep === 4

  // Cost estimates
  const harvestCostBase = totalCost ?? sections.length * 0.0020
  const harvestCostLo = harvestCostBase * 0.85
  const harvestCostHi = harvestCostBase * 1.15

  const synthInputTokens = totalCandidates * 350 + 1500
  const synthOutputTokens = Math.min(totalCandidates * 100, 8000)
  const synthCostBase = (synthInputTokens / 1_000_000) * 0.15 + (synthOutputTokens / 1_000_000) * 0.60
  const synthCostLo = synthCostBase * 0.85
  const synthCostHi = synthCostBase * 1.15

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto' }}>
      {/* Document header */}
      <p style={{
        fontSize: '0.72rem', color: 'var(--ink-muted)',
        textTransform: 'uppercase', letterSpacing: '0.18em', marginBottom: '0.55rem',
      }}>
        Source work
      </p>
      {confirmingDelete ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', padding: '0.6rem 0', marginBottom: '0.2rem' }}>
          <span style={{ fontSize: '0.92rem', color: 'var(--ink-muted)' }}>Remove from library?</span>
          <button type="button" onClick={() => setConfirmingDelete(false)} style={{
            background: 'none', border: '1px solid var(--border-warm)', borderRadius: '3px',
            padding: '0.25rem 0.75rem', fontSize: '0.8rem', color: 'var(--ink-muted)', cursor: 'pointer',
          }}>Cancel</button>
          <button type="button" onClick={() => onDelete?.()} style={{
            background: 'none', border: '1px solid rgba(180,60,60,0.45)', borderRadius: '3px',
            padding: '0.25rem 0.75rem', fontSize: '0.8rem', color: 'var(--error-text)', cursor: 'pointer',
          }}>Remove</button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
          <h2 style={{ flex: 1, fontSize: '2.4rem', fontWeight: 400, color: 'var(--ink)', lineHeight: 1.15, margin: 0 }}>
            {document.title}
          </h2>
          {onDelete && (
            <button type="button" onClick={() => setConfirmingDelete(true)} title="Remove from library"
              style={{
                marginTop: '0.4rem', background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--ink-faint)', fontSize: '1.1rem', lineHeight: 1, padding: '0 0.1rem',
                opacity: 0.45, transition: 'opacity 0.15s',
              }}
            >×</button>
          )}
        </div>
      )}
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
              ▸ Inspect metadata
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
              ▸ Inspect sections ({sections.length})
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

      {/* ── Step 3: Harvest evidence ─────────────────────────────────── */}
      {step3Done ? (
        <StepDone
          label="Harvest evidence"
          detail={`${totalCandidates} candidate${totalCandidates !== 1 ? 's' : ''} across ${sections.length} sections${totalElapsedMs > 0 ? ` · ${(totalElapsedMs / 1000).toFixed(1)}s` : ''}`}
          action={
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <RerunCard
                label="Re-harvest cost"
                costLo={harvestCostLo}
                costHi={harvestCostHi}
                meta={`${sections.length} section${sections.length !== 1 ? 's' : ''} · clears cache`}
                action="Re-harvest evidence"
                onAction={() => handleHarvest(true)}
              />
              <details>
                <summary style={{ fontSize: '0.88rem', color: 'var(--ink-muted)', cursor: 'pointer', listStyle: 'none' }}>
                  ▸ Inspect raw candidates ({totalCandidates})
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
        <StepActive n={3} label="Harvest evidence" processing>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', marginTop: '0.25rem' }}>
            {/* Pass 1 */}
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', opacity: harvestPass > 1 ? 0.55 : 1, transition: 'opacity 0.4s' }}>
              <div style={{
                width: '1.35rem', height: '1.35rem', borderRadius: '50%', flexShrink: 0, marginTop: '0.05rem',
                ...(harvestPass > 1
                  ? { background: 'radial-gradient(circle at 40% 35%, #7a3528, #3d1208)', boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(240,215,190,0.8)', fontSize: '0.45rem' }
                  : { background: 'var(--step-active-circle)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '0.55rem' }
                ),
              }} className={harvestPass === 1 ? 'step-processing' : ''}>
                {harvestPass > 1 ? '✦' : 'I'}
              </div>
              <div>
                <div style={{ fontSize: '0.9rem', color: 'var(--ink)', fontWeight: 500 }}>Pass 1 — Finding places</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--ink-faint)', marginTop: '0.15rem' }}>
                  {harvestPass === 1
                    ? <>§{currentIdx} of {sections.length}{currentTitle ? <> · <em>{currentTitle}</em></> : ''}</>
                    : <>{catalogEntityCount} place{catalogEntityCount !== 1 ? 's' : ''} identified across {sections.length} sections</>
                  }
                </div>
              </div>
            </div>
            {/* Pass 2 */}
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', opacity: harvestPass < 2 ? 0.38 : 1, transition: 'opacity 0.4s' }}>
              <div style={{
                width: '1.35rem', height: '1.35rem', borderRadius: '50%', flexShrink: 0, marginTop: '0.05rem',
                border: harvestPass < 2 ? '1.5px solid var(--gold)' : undefined,
                background: harvestPass >= 2 ? 'var(--step-active-circle)' : undefined,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: harvestPass >= 2 ? '#fff' : 'var(--gold)', fontSize: '0.55rem',
              }} className={harvestPass === 2 ? 'step-processing' : ''}>
                {harvestPass >= 2 ? 'II' : ''}
              </div>
              <div>
                <div style={{ fontSize: '0.9rem', color: 'var(--ink)', fontWeight: 500 }}>Pass 2 — Gathering evidence</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--ink-faint)', marginTop: '0.15rem' }}>
                  {harvestPass === 2
                    ? <>§{currentIdx} of {sections.length}{currentTitle ? <> · <em>{currentTitle}</em></> : ''} · {candidatesSoFar} fragment{candidatesSoFar !== 1 ? 's' : ''}</>
                    : <>Claims, routes, and visual observations</>
                  }
                </div>
              </div>
            </div>
          </div>
          <p style={{ fontSize: '0.78rem', color: 'var(--ink-faint)', marginTop: '1rem', fontFamily: 'monospace' }}>
            {(elapsedMs / 1000).toFixed(1)}s elapsed
          </p>
        </StepActive>
      ) : phase === 'ready' ? (
        <StepActive n={3} label="Harvest evidence">
          <p style={{ fontSize: '0.95rem', color: 'var(--ink-muted)', marginTop: '0.5rem', marginBottom: '1.25rem', lineHeight: 1.6 }}>
            Two-pass extraction over all {sections.length} section{sections.length !== 1 ? 's' : ''}:
            Pass 1 identifies every named place across the whole book,
            then Pass 2 extracts spatial claims, routes, and visual descriptions
            anchored to that complete place list.
          </p>
          <div style={{
            borderTop: '1px solid rgba(212, 188, 138, 0.5)',
            borderBottom: '1px solid rgba(212, 188, 138, 0.5)',
            padding: '0.65rem 0',
            marginBottom: '0.7rem',
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: '1rem',
          }}>
            <span style={{ fontSize: '0.68rem', color: 'var(--ink-muted)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
              Est. extraction cost
            </span>
            <span>
              {totalCost !== null ? (
                <span style={{ fontSize: '1rem', color: 'var(--ink)', fontFamily: 'monospace' }}>
                  ${(totalCost * 0.85).toFixed(2)} – ${(totalCost * 1.15).toFixed(2)}
                </span>
              ) : (
                <span style={{ fontSize: '1rem', color: 'var(--ink-faint)', fontFamily: 'monospace' }}>Estimating…</span>
              )}
            </span>
          </div>
          <p style={{ fontSize: '0.66rem', color: 'var(--ink-faint)', fontFamily: 'monospace', marginBottom: '1rem' }}>
            {document.original_filename} · {sections.length} section{sections.length !== 1 ? 's' : ''} · OpenAI
            {cachedCount > 0 && ` · ${cachedCount} cached`}
          </p>
          <button className="btn-cta" type="button" onClick={handleHarvest}>
            Harvest evidence
          </button>
        </StepActive>
      ) : (
        <StepActive n={3} label="Harvest evidence">
          <p style={{ fontSize: '0.92rem', color: 'var(--ink-faint)' }}>
            Checking sections and estimating cost…
          </p>
        </StepActive>
      )}
      <StepConnector />

      {/* ── Step 4: Synthesize atlas ─────────────────────────────────── */}
      {step4Done ? (
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
              {atlasEntities.length > 0 && (
                <details>
                  <summary style={{ fontSize: '0.88rem', color: 'var(--ink-muted)', cursor: 'pointer', listStyle: 'none' }}>
                    ▸ Inspect canonical places ({canonicalEntityCount})
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
              )}
            </div>
          }
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
        <StepActive n={4} label="Synthesize atlas" processing>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', marginTop: '0.25rem' }}>
            {/* Pass 1 */}
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', opacity: synthPass > 1 ? 0.55 : 1, transition: 'opacity 0.4s' }}>
              <div style={{
                width: '1.35rem', height: '1.35rem', borderRadius: '50%', flexShrink: 0, marginTop: '0.05rem',
                ...(synthPass > 1
                  ? { background: 'radial-gradient(circle at 40% 35%, #7a3528, #3d1208)', boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(240,215,190,0.8)', fontSize: '0.45rem' }
                  : { background: 'var(--step-active-circle)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '0.55rem' }
                ),
              }} className={synthPass === 1 ? 'step-processing' : ''}>
                {synthPass > 1 ? '✦' : 'I'}
              </div>
              <div>
                <div style={{ fontSize: '0.9rem', color: 'var(--ink)', fontWeight: 500 }}>Pass 1 — Entity consolidation</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--ink-faint)', marginTop: '0.15rem' }}>Building canonical place list across {sections.length} sections</div>
              </div>
            </div>
            {/* Pass 2 */}
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', opacity: synthPass < 2 ? 0.38 : 1, transition: 'opacity 0.4s' }}>
              <div style={{
                width: '1.35rem', height: '1.35rem', borderRadius: '50%', flexShrink: 0, marginTop: '0.05rem',
                border: synthPass < 2 ? '1.5px solid var(--gold)' : undefined,
                background: synthPass >= 2 ? 'var(--step-active-circle)' : undefined,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: synthPass >= 2 ? '#fff' : 'var(--gold)', fontSize: '0.55rem',
              }} className={synthPass === 2 ? 'step-processing' : ''}>
                {synthPass >= 2 ? 'II' : ''}
              </div>
              <div>
                <div style={{ fontSize: '0.9rem', color: 'var(--ink)', fontWeight: 500 }}>Pass 2 — Evidence synthesis</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--ink-faint)', marginTop: '0.15rem' }}>Anchoring {totalCandidates} claim{totalCandidates !== 1 ? 's' : ''}, routes, and visual observations</div>
              </div>
            </div>
          </div>
          <p style={{ fontSize: '0.78rem', color: 'var(--ink-faint)', marginTop: '1rem', fontFamily: 'monospace' }}>
            {(synthElapsedMs / 1000).toFixed(1)}s elapsed
          </p>
        </StepActive>
      ) : phase === 'harvested' ? (
        <StepActive n={4} label="Synthesize atlas">
          <p style={{ fontSize: '0.95rem', color: 'var(--ink-muted)', marginTop: '0.5rem', marginBottom: '1.25rem', lineHeight: 1.6 }}>
            Stage 2 reads all {totalCandidates} evidence fragment{totalCandidates !== 1 ? 's' : ''} in one pass
            and writes a canonical atlas — merging duplicates, resolving aliases,
            surfacing contradictions, and anchoring each place to its first revealed section.
          </p>
          <div style={{
            borderTop: '1px solid rgba(212, 188, 138, 0.5)',
            borderBottom: '1px solid rgba(212, 188, 138, 0.5)',
            padding: '0.65rem 0',
            marginBottom: '0.7rem',
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: '1rem',
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
      ) : (
        <StepLocked n={4} label="Synthesize atlas" detail="Reads all harvested evidence in one pass and writes the canonical atlas automatically." />
      )}
      <StepConnector />

      {/* ── Step 5: Atlas Explorer ───────────────────────────────── */}
      {step4Done ? (
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
      ) : (
        <StepLocked n={5} label="Atlas Explorer" detail="Available once the atlas is synthesized." />
      )}
    </div>
  )
}
