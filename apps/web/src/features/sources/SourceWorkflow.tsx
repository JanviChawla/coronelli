import { useEffect, useRef, useState } from 'react'
import { CandidateQueue } from '../candidates/CandidateQueue'
import { fetchPreflight, triggerExtraction } from './extractionApi'
import type { Document, Section } from './sourceApi'

interface Props {
  document: Document
  sections: Section[]
  onEditSections: () => void
}

type Phase = 'preflight' | 'ready' | 'extracting' | 'done' | 'error'

interface SectionResult {
  sectionId: string
  title: string | null
  candidateCount: number
}

function StepDone({ label, detail, action }: {
  label: string
  detail: string
  action?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem' }}>
      <span style={{ minWidth: '1.5rem', color: 'green', fontWeight: 'bold', fontSize: '1rem' }}>✓</span>
      <div>
        <div style={{ fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.1rem' }}>{detail}</div>
        {action && <div style={{ marginTop: '0.4rem' }}>{action}</div>}
      </div>
    </div>
  )
}

function StepPending({ n, label, children }: {
  n: number
  label: string
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem' }}>
      <span style={{
        minWidth: '1.5rem', width: '1.5rem', height: '1.5rem',
        border: '2px solid #555', borderRadius: '50%',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '0.75rem', fontWeight: 'bold', flexShrink: 0, marginTop: '0.1rem',
      }}>
        {n}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, marginBottom: '0.5rem' }}>{label}</div>
        {children}
      </div>
    </div>
  )
}

export function SourceWorkflow({ document, sections, onEditSections }: Props) {
  const [phase, setPhase] = useState<Phase>('preflight')
  const [totalCost, setTotalCost] = useState<number | null>(null)
  const [cachedCount, setCachedCount] = useState(0)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [currentTitle, setCurrentTitle] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [candidatesSoFar, setCandidatesSoFar] = useState(0)
  const [sectionResults, setSectionResults] = useState<SectionResult[]>([])
  const [totalCandidates, setTotalCandidates] = useState(0)
  const [totalElapsedMs, setTotalElapsedMs] = useState(0)
  const [extractionError, setExtractionError] = useState<string | null>(null)
  const [reviewSectionId, setReviewSectionId] = useState<string | null>(null)
  const [reviewSectionTitle, setReviewSectionTitle] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    loadPreflight()
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [document.id])

  async function loadPreflight() {
    setPhase('preflight')
    try {
      const results = await Promise.all(sections.map((s) => fetchPreflight(s.id)))
      const cost = results.reduce(
        (sum, r) => sum + (r.cache_valid ? 0 : (r.estimated_cost_usd ?? 0)),
        0,
      )
      const cached = results.filter((r) => r.cache_valid).length
      setTotalCost(cost)
      setCachedCount(cached)
    } catch {
      setTotalCost(null)
    }
    setPhase('ready')
  }

  async function handleGenerate() {
    setPhase('extracting')
    setCurrentIdx(0)
    setCandidatesSoFar(0)
    setSectionResults([])
    setExtractionError(null)
    setReviewSectionId(null)

    const startTime = Date.now()
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - startTime), 100)

    let total = 0
    const results: SectionResult[] = []

    try {
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i]
        setCurrentIdx(i + 1)
        setCurrentTitle(section.title)
        const result = await triggerExtraction(section.id)
        const count = result.candidates.length
        total += count
        setCandidatesSoFar(total)
        results.push({ sectionId: section.id, title: section.title, candidateCount: count })
      }
      if (timerRef.current) clearInterval(timerRef.current)
      setTotalElapsedMs(Date.now() - startTime)
      setTotalCandidates(total)
      setSectionResults(results)
      setPhase('done')
    } catch (e) {
      if (timerRef.current) clearInterval(timerRef.current)
      setExtractionError(e instanceof Error ? e.message : 'Extraction failed. Check your API key.')
      setPhase('error')
    }
  }

  return (
    <div>
      <p style={{ fontSize: '0.7rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>
        Source work
      </p>
      <h2 style={{ marginBottom: '1.75rem' }}>{document.title}</h2>

      {/* Step 1 */}
      <StepDone label="Import source" detail={document.original_filename} />

      {/* Step 2 */}
      <StepDone
        label="Prepare sections"
        detail={`${sections.length} section${sections.length !== 1 ? 's' : ''} detected`}
        action={
          <button type="button" onClick={onEditSections} style={{ fontSize: '0.8rem' }}>
            Review and edit
          </button>
        }
      />

      {/* Step 3 — preflight loading */}
      {phase === 'preflight' && (
        <StepPending n={3} label="Generate cartographer artifacts">
          <p style={{ fontSize: '0.85rem', color: '#888' }}>Loading estimate…</p>
        </StepPending>
      )}

      {/* Step 3 — ready */}
      {phase === 'ready' && (
        <StepPending n={3} label="Generate cartographer artifacts">
          {totalCost !== null && (
            <p style={{ fontSize: '0.85rem', color: '#555', marginBottom: '0.75rem' }}>
              Estimated cost: <strong>${totalCost.toFixed(4)}</strong>
              {' · '}{sections.length} section{sections.length !== 1 ? 's' : ''} · OpenAI
              {cachedCount > 0 && <> · {cachedCount} cached</>}
            </p>
          )}
          <button type="button" onClick={handleGenerate} style={{ fontWeight: 500 }}>
            Generate candidates
          </button>
          <p style={{ fontSize: '0.78rem', color: '#999', marginTop: '0.4rem' }}>
            Candidates remain local until you choose to export.
          </p>
        </StepPending>
      )}

      {/* Step 3 — extracting */}
      {phase === 'extracting' && (
        <StepPending n={3} label="Generate cartographer artifacts">
          <p style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>
            Section {currentIdx} of {sections.length}
            {currentTitle && <> · <em>{currentTitle}</em></>}
            {' · '}{(elapsedMs / 1000).toFixed(1)}s elapsed
          </p>
          <p style={{ fontSize: '0.82rem', color: '#666' }}>
            {candidatesSoFar} candidate{candidatesSoFar !== 1 ? 's' : ''} found so far
          </p>
        </StepPending>
      )}

      {/* Step 3 — error */}
      {phase === 'error' && (
        <StepPending n={3} label="Generate cartographer artifacts">
          <p role="alert" style={{ color: 'red', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
            {extractionError}
          </p>
          <button type="button" onClick={handleGenerate}>Retry</button>
        </StepPending>
      )}

      {/* Step 3 — done */}
      {phase === 'done' && (
        <>
          <StepDone
            label="Generate cartographer artifacts"
            detail={`${totalCandidates} candidate${totalCandidates !== 1 ? 's' : ''} generated · ${(totalElapsedMs / 1000).toFixed(1)}s`}
          />

          <div style={{ marginTop: '0.5rem' }}>
            <h3 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Review candidates</h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {sectionResults.map((r) => (
                <li
                  key={r.sectionId}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.4rem 0', borderBottom: '1px solid #eee' }}
                >
                  <span style={{ flex: 1, fontSize: '0.9rem' }}>{r.title ?? '(untitled)'}</span>
                  <span style={{ fontSize: '0.8rem', color: '#888' }}>{r.candidateCount}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setReviewSectionId(r.sectionId)
                      setReviewSectionTitle(r.title)
                    }}
                    style={{ fontSize: '0.8rem' }}
                  >
                    Review
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {/* Inline candidate review */}
      {reviewSectionId && (
        <div style={{ marginTop: '2rem', paddingTop: '1rem', borderTop: '1px solid #ddd' }}>
          <button
            type="button"
            onClick={() => setReviewSectionId(null)}
            style={{ fontSize: '0.8rem', marginBottom: '0.75rem' }}
          >
            ← Back to sections
          </button>
          <CandidateQueue sectionId={reviewSectionId} sectionTitle={reviewSectionTitle} />
        </div>
      )}
    </div>
  )
}
