import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { CandidatesTable } from '../candidates/CandidatesTable'
import { type Candidate, fetchCandidates } from '../candidates/candidateApi'
import { fetchPreflight, triggerExtraction } from './extractionApi'
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
      <div className="wax-seal">✦</div>
      <div style={{ flex: 1, paddingTop: '0.3rem' }}>
        <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--ink)' }}>{label}</div>
        <div style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', marginTop: '0.1rem' }}>{detail}</div>
        {action && <div style={{ marginTop: '0.75rem' }}>{action}</div>}
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
    <div style={{ display: 'flex', gap: '1rem', height: '2rem', margin: '0.1rem 0' }}>
      <div style={{ width: '2rem', flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ width: '1px', flex: 1, background: 'var(--gold)', opacity: 0.3 }} />
        <span style={{ color: 'var(--gold)', opacity: 0.38, fontSize: '0.4rem', lineHeight: 1 }}>◆</span>
        <div style={{ width: '1px', flex: 1, background: 'var(--gold)', opacity: 0.3 }} />
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
        className="btn-cta"
        type="button"
        onClick={onAction}
        style={{ width: 'auto', flexShrink: 0, padding: '0.45rem 1rem', fontSize: '0.82rem' }}
      >
        {action}
      </button>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function SourceWorkflow({ document, sections, onEditSections, onAtlasChanged, onViewAtlas }: Props) {
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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
    setSynthElapsedMs(0)
    const synthStart = Date.now()
    timerRef.current = setInterval(() => setSynthElapsedMs(Date.now() - synthStart), 100)
    try {
      await triggerSynthesis(document.id, force)
      if (timerRef.current) clearInterval(timerRef.current)
      const atlas = await fetchAtlas(document.id)
      setCanonicalEntityCount(atlas.entity_count)
      setCanonicalClaimCount(atlas.claim_count)
      setAtlasEntities(atlas.entities)
      setPhase('done')
      onAtlasChanged?.()
    } catch (e) {
      if (timerRef.current) clearInterval(timerRef.current)
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
    <div style={{ maxWidth: '680px', margin: '0 auto' }}>
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
      {document.author && (
        <p style={{ fontSize: '0.85rem', color: 'var(--ink-muted)', marginTop: '0.25rem' }}>
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
            <summary style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', cursor: 'pointer', listStyle: 'none' }}>
              ▸ Inspect metadata
            </summary>
            <div style={{ marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.18rem' }}>
              {[
                ['Title',  document.title],
                ['Author', document.author || '—'],
                ['Year',   document.year != null ? String(document.year) : 'N/A'],
              ].map(([label, value]) => (
                <div key={label} style={{ display: 'flex', gap: '0.5rem', fontSize: '0.78rem' }}>
                  <span style={{ color: 'var(--ink-faint)', minWidth: '3.5rem' }}>{label}</span>
                  <span style={{ color: 'var(--ink)' }}>{value}</span>
                </div>
              ))}
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
            <summary style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', cursor: 'pointer', listStyle: 'none' }}>
              ▸ Inspect sections ({sections.length})
            </summary>
            <div style={{ marginTop: '0.65rem' }}>
              {sections.map((s, i) => (
                <div key={s.id} style={{ display: 'flex', gap: '0.5rem', fontSize: '0.78rem', marginBottom: '0.2rem' }}>
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
                meta={`${sections.length} section${sections.length !== 1 ? 's' : ''} · cached runs free`}
                action="Re-harvest evidence"
                onAction={handleHarvest}
              />
              <details>
                <summary style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', cursor: 'pointer', listStyle: 'none' }}>
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
            borderTop: '1px solid rgba(212, 188, 138, 0.5)',
            borderBottom: '1px solid rgba(212, 188, 138, 0.5)',
            padding: '0.65rem 0',
            marginBottom: '0.7rem',
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: '1rem',
          }}>
            <span style={{ fontSize: '0.58rem', color: 'var(--ink-muted)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
              Est. extraction cost
            </span>
            <span>
              {totalCost !== null ? (
                <span style={{ fontSize: '0.92rem', color: 'var(--ink)', fontFamily: 'monospace' }}>
                  ${(totalCost * 0.85).toFixed(2)} – ${(totalCost * 1.15).toFixed(2)}
                </span>
              ) : (
                <span style={{ fontSize: '0.82rem', color: 'var(--ink-faint)', fontFamily: 'monospace' }}>Estimating…</span>
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
                  <summary style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', cursor: 'pointer', listStyle: 'none' }}>
                    ▸ Inspect canonical places ({canonicalEntityCount})
                  </summary>
                  <div style={{ marginTop: '0.65rem', display: 'flex', flexDirection: 'column', gap: '0.22rem' }}>
                    {atlasEntities
                      .slice()
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map(e => (
                        <div key={e.id} style={{ fontSize: '0.78rem', color: 'var(--ink)', display: 'flex', gap: '0.35rem', alignItems: 'baseline' }}>
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
        <StepActive n={4} label="Synthesize atlas">
          <p style={{ fontSize: '0.85rem', color: 'var(--ink-muted)', marginBottom: '0.2rem' }}>
            Synthesizing {totalCandidates} evidence fragment{totalCandidates !== 1 ? 's' : ''} in one pass · {(synthElapsedMs / 1000).toFixed(1)}s
          </p>
          <p style={{ fontSize: '0.78rem', color: 'var(--ink-faint)' }}>
            Merging entities, resolving aliases, anchoring provenance…
          </p>
        </StepActive>
      ) : phase === 'harvested' ? (
        <StepActive n={4} label="Synthesize atlas">
          <p style={{ fontSize: '0.82rem', color: 'var(--ink-muted)', marginBottom: '1rem', lineHeight: 1.55 }}>
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
            <span style={{ fontSize: '0.58rem', color: 'var(--ink-muted)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
              Est. synthesis cost
            </span>
            <span style={{ fontSize: '0.92rem', color: 'var(--ink)', fontFamily: 'monospace' }}>
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
