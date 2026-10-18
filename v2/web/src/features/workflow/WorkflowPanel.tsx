import { useEffect, useRef, useState, useCallback } from 'react'
import {
  type Document,
  type Section,
  type Place,
  type SSEEvent,
  type CostEstimate,
  getDocument,
  listSections,
  runCatalog,
  confirmSection,
  patchPlace,
  runExtraction,
  getPlaces,
  openEventStream,
  getEstimate,
} from '../../api/client'

interface Props {
  documentId: string
  onClose: () => void
  onOpenAtlas: () => void
}

const TIER_COLORS: Record<string, string> = {
  peak: '#8AABCA',
  elevated: '#C4884A',
  surface: '#4A7A4A',
  underground: '#6A5A7A',
  deep: '#3A1A2A',
}

export default function WorkflowPanel({ documentId, onClose, onOpenAtlas }: Props) {
  const [doc, setDoc] = useState<Document | null>(null)
  const [sections, setSections] = useState<Section[]>([])
  const [sectionIdx, setSectionIdx] = useState(0)
  const [sectionCandidates, setSectionCandidates] = useState<Place[]>([])
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set())
  const [confirmedTotal, setConfirmedTotal] = useState(0)
  const [extractedCount, setExtractedCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [estimate, setEstimate] = useState<CostEstimate | null>(null)
  const [pipelineConfirmed, setPipelineConfirmed] = useState(false)
  const [evidenceConfirmed, setEvidenceConfirmed] = useState(false)
  const esRef = useRef<EventSource | null>(null)

  const fetchDoc = useCallback(async () => {
    const d = await getDocument(documentId)
    setDoc(d)
    return d
  }, [documentId])

  const fetchConfirmedCount = useCallback(async () => {
    try {
      const grouped = await getPlaces(documentId)
      setConfirmedTotal(grouped.confirmed.length)
    } catch {
      // ignore
    }
  }, [documentId])

  const startCatalogForSection = useCallback(
    async (idx: number, secs: Section[]) => {
      const sec = secs[idx]
      if (!sec) return
      setLoading(true)
      setError(null)
      try {
        const result = await runCatalog(sec.id)
        setSectionCandidates(result.places.filter((p) => p.status !== 'rejected'))
        setRejectedIds(new Set(result.places.filter((p) => p.status === 'rejected').map((p) => p.id)))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  // Mount: resume to correct state
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const d = await fetchDoc()
        const secs = await listSections(documentId)
        if (cancelled) return
        setSections(secs)
        await fetchConfirmedCount()

        if (d.status === 'raw' || d.status === 'cataloging') {
          getEstimate(documentId).then(setEstimate).catch(() => null)
          const firstPending = secs.findIndex((s) => s.catalog_status !== 'confirmed')
          const idx = firstPending === -1 ? 0 : firstPending
          setSectionIdx(idx)
          if (d.status === 'cataloging') {
            // Already in progress — skip the cost gate and load current section
            setPipelineConfirmed(true)
            await startCatalogForSection(idx, secs)
          }
          // For 'raw': wait for user to confirm cost card before calling startCatalogForSection
        } else if (d.status === 'extracting') {
          // Open SSE stream
          const es = openEventStream(documentId, handleSSEEvent)
          esRef.current = es
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
      esRef.current?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId])

  function handleSSEEvent(event: SSEEvent) {
    if (event.type === 'section_extracted') {
      setExtractedCount((n) => n + 1)
    } else if (event.type === 'synthesis_done') {
      esRef.current?.close()
      fetchDoc()
    } else if (event.type === 'error') {
      setError(event.message)
    }
  }

  const handleToggleReject = async (placeId: string) => {
    const isRejected = rejectedIds.has(placeId)
    const newStatus = isRejected ? 'candidate' : 'rejected'
    try {
      await patchPlace(placeId, { status: newStatus })
      setRejectedIds((prev) => {
        const next = new Set(prev)
        if (isRejected) next.delete(placeId)
        else next.add(placeId)
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleConfirmSection = async () => {
    const sec = sections[sectionIdx]
    if (!sec) return
    setLoading(true)
    try {
      await confirmSection(sec.id)
      const updatedSecs = [...sections]
      updatedSecs[sectionIdx] = { ...sec, catalog_status: 'confirmed' }
      setSections(updatedSecs)
      await fetchConfirmedCount()

      const nextIdx = sectionIdx + 1
      if (nextIdx < sections.length) {
        setSectionIdx(nextIdx)
        await startCatalogForSection(nextIdx, updatedSecs)
      } else {
        const d = await fetchDoc()
        if (d.status === 'cataloged') {
          setSectionCandidates([])
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const handleStartExtraction = async () => {
    setLoading(true)
    setError(null)
    try {
      await runExtraction(documentId)
      const d = await fetchDoc()
      setDoc(d)
      const es = openEventStream(documentId, handleSSEEvent)
      esRef.current = es
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const groupCandidates = (candidates: Place[]) => {
    const realms = candidates.filter((p) => p.spatial_level === 0)
    const places = candidates.filter((p) => p.spatial_level != null && p.spatial_level >= 1 && p.spatial_level <= 2)
    const features = candidates.filter((p) => p.spatial_level === 3)
    const uncategorized = candidates.filter((p) => p.spatial_level == null)
    return { realms, places, features, uncategorized }
  }

  if (!doc) {
    return (
      <PanelShell onClose={onClose}>
        <div style={{ color: '#6B6352', fontFamily: "'Space Mono',monospace", fontSize: '10px' }}>
          Loading…
        </div>
      </PanelShell>
    )
  }

  return (
    <PanelShell onClose={onClose}>
      <div style={{ marginBottom: '24px' }}>
        <div style={{ fontFamily: "'Cinzel',serif", fontSize: '20px', color: '#D4B060', marginBottom: '4px' }}>
          {doc.title}
        </div>
        {doc.author && (
          <div style={{ fontFamily: "'Space Mono',monospace", fontSize: '9px', color: '#6B6352', letterSpacing: '.1em' }}>
            {doc.author}
          </div>
        )}
      </div>

      {error && (
        <div style={{ background: 'rgba(154,74,74,0.15)', border: '1px solid rgba(154,74,74,0.3)', borderRadius: '3px', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: '#C87878' }}>
          {error}
        </div>
      )}

      {/* RAW / CATALOGING */}
      {(doc.status === 'raw' || doc.status === 'cataloging') && (
        <div>
          {!pipelineConfirmed && estimate ? (
            <CostCard
              estimate={estimate}
              phase="catalog_gap"
              onConfirm={() => {
                setPipelineConfirmed(true)
                startCatalogForSection(sectionIdx, sections)
              }}
            />
          ) : !pipelineConfirmed && !estimate ? (
            <div style={{ color: '#6B6352', fontFamily: "'Space Mono',monospace", fontSize: '10px', marginBottom: '16px' }}>
              Loading estimate…
            </div>
          ) : (
            <>
              <div style={{ fontFamily: "'Space Mono',monospace", fontSize: '9px', color: '#6B6352', letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: '16px' }}>
                §{sectionIdx + 1} / {sections.length} · {confirmedTotal} confirmed
              </div>

              {loading && (
                <div style={{ color: '#6B6352', fontFamily: "'Space Mono',monospace", fontSize: '10px', marginBottom: '16px' }}>
                  Extracting places…
                </div>
              )}

              {!loading && sectionCandidates.length > 0 && (
                <CandidateList
                  candidates={sectionCandidates}
                  rejectedIds={rejectedIds}
                  onToggle={handleToggleReject}
                />
              )}

              {!loading && (
                <button onClick={handleConfirmSection} disabled={loading} style={primaryBtnStyle}>
                  Confirm §{sectionIdx + 1} →
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* CATALOGED */}
      {doc.status === 'cataloged' && (
        <div>
          <div style={{ marginBottom: '24px', color: '#C8BC9E', fontSize: '16px' }}>
            {confirmedTotal} places confirmed across {sections.length} sections.
          </div>
          {!evidenceConfirmed && estimate ? (
            <CostCard
              estimate={estimate}
              phase="evidence"
              onConfirm={() => setEvidenceConfirmed(true)}
            />
          ) : evidenceConfirmed ? (
            <button onClick={handleStartExtraction} disabled={loading} style={primaryBtnStyle}>
              {loading ? 'Starting…' : 'Extract evidence →'}
            </button>
          ) : (
            <button
              onClick={() => getEstimate(documentId).then(e => { setEstimate(e) })}
              style={primaryBtnStyle}
            >
              Check cost →
            </button>
          )}
        </div>
      )}

      {/* EXTRACTING */}
      {doc.status === 'extracting' && (
        <div>
          <div style={{ fontFamily: "'Space Mono',monospace", fontSize: '9px', color: '#6B6352', letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: '12px' }}>
            Extracting evidence
          </div>
          <div style={{ background: '#141E30', borderRadius: '3px', height: '6px', overflow: 'hidden', marginBottom: '12px' }}>
            <div
              style={{
                height: '100%',
                background: '#B8943A',
                width: `${sections.length > 0 ? (extractedCount / sections.length) * 100 : 0}%`,
                transition: 'width .3s ease',
              }}
            />
          </div>
          <div style={{ fontFamily: "'Space Mono',monospace", fontSize: '9px', color: '#6B6352' }}>
            {extractedCount} / {sections.length} sections
          </div>
        </div>
      )}

      {/* READY */}
      {doc.status === 'ready' && (
        <div>
          <div style={{ marginBottom: '24px', color: '#C8BC9E', fontSize: '16px' }}>
            {confirmedTotal} places confirmed. Atlas is ready.
          </div>
          <button onClick={onOpenAtlas} style={primaryBtnStyle}>
            Open Atlas →
          </button>
        </div>
      )}
    </PanelShell>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PanelShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: '1.5vh 1.5vw',
        background: 'rgba(6,12,24,0.96)',
        border: '1px solid rgba(184,148,58,0.14)',
        borderRadius: '6px',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 20,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 16px 0' }}>
        <button
          onClick={onClose}
          style={{ background: 'transparent', border: 'none', color: '#6B6352', fontSize: '18px', cursor: 'pointer', lineHeight: 1 }}
        >
          ×
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 32px 32px' }}>
        {children}
      </div>
    </div>
  )
}

function CandidateList({
  candidates,
  rejectedIds,
  onToggle,
}: {
  candidates: Place[]
  rejectedIds: Set<string>
  onToggle: (id: string) => void
}) {
  const { realms, places, features, uncategorized } = (() => {
    const realms = candidates.filter((p) => p.spatial_level === 0)
    const places = candidates.filter((p) => p.spatial_level != null && p.spatial_level >= 1 && p.spatial_level <= 2)
    const features = candidates.filter((p) => p.spatial_level === 3)
    const uncategorized = candidates.filter((p) => p.spatial_level == null)
    return { realms, places, features, uncategorized }
  })()

  return (
    <div style={{ marginBottom: '20px' }}>
      {[
        { label: 'Realms', items: realms },
        { label: 'Places', items: places },
        { label: 'Features', items: features },
        { label: 'Other', items: uncategorized },
      ]
        .filter((g) => g.items.length > 0)
        .map(({ label, items }) => (
          <div key={label} style={{ marginBottom: '16px' }}>
            <div style={{ fontFamily: "'Space Mono',monospace", fontSize: '8px', letterSpacing: '.14em', textTransform: 'uppercase', color: '#6B6352', marginBottom: '8px' }}>
              {label} ({items.length})
            </div>
            {items.map((p) => (
              <CandidateRow
                key={p.id}
                place={p}
                rejected={rejectedIds.has(p.id)}
                onToggle={() => onToggle(p.id)}
              />
            ))}
          </div>
        ))}
    </div>
  )
}

function CandidateRow({
  place,
  rejected,
  onToggle,
}: {
  place: Place
  rejected: boolean
  onToggle: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '8px 0',
        borderBottom: '1px solid rgba(184,148,58,0.06)',
        opacity: rejected ? 0.4 : 1,
      }}
    >
      <button
        onClick={onToggle}
        style={{
          width: '18px',
          height: '18px',
          borderRadius: '2px',
          border: `1px solid ${rejected ? 'rgba(154,74,74,0.5)' : 'rgba(184,148,58,0.3)'}`,
          background: rejected ? 'rgba(154,74,74,0.15)' : 'transparent',
          flexShrink: 0,
          marginTop: '2px',
          cursor: 'pointer',
          color: rejected ? '#C87878' : 'transparent',
          fontSize: '11px',
          lineHeight: '16px',
          textAlign: 'center',
        }}
      >
        {rejected ? '×' : ''}
      </button>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
          <span style={{ color: '#C8BC9E', fontSize: '14px' }}>{place.name}</span>
          {place.tier && (
            <span
              style={{
                display: 'inline-block',
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: TIER_COLORS[place.tier] ?? '#6B6352',
                flexShrink: 0,
              }}
              title={place.tier}
            />
          )}
          {place.source === 'gap' && (
            <span style={{ fontFamily: "'Space Mono',monospace", fontSize: '7px', color: '#4A9A6A', letterSpacing: '.08em', textTransform: 'uppercase' }}>
              gap
            </span>
          )}
        </div>
        {place.kind_descriptor && (
          <div style={{ fontFamily: "'Space Mono',monospace", fontSize: '9px', color: '#6B6352' }}>
            {place.kind_descriptor}
          </div>
        )}
        {place.parent_context && (
          <div style={{ fontSize: '12px', color: '#6B6352', fontStyle: 'italic' }}>
            in {place.parent_context}
          </div>
        )}
        {place.note && (
          <div style={{ fontSize: '12px', color: '#6B6352', marginTop: '2px' }}>
            {place.note}
          </div>
        )}
      </div>
    </div>
  )
}

function CostCard({
  estimate,
  phase,
  onConfirm,
}: {
  estimate: CostEstimate
  phase: 'catalog_gap' | 'evidence'
  onConfirm: () => void
}) {
  const pass = phase === 'catalog_gap' ? estimate.catalog_gap : estimate.evidence
  const label = phase === 'catalog_gap' ? 'Catalog + gap passes' : 'Evidence extraction'
  const action = phase === 'catalog_gap' ? 'Begin pipeline →' : 'Extract evidence →'

  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)

  return (
    <div
      style={{
        background: '#0E1525',
        border: '1px solid rgba(184,148,58,0.2)',
        borderRadius: '4px',
        padding: '18px 20px',
        marginBottom: '20px',
      }}
    >
      <div style={{ fontFamily: "'Space Mono',monospace", fontSize: '8px', letterSpacing: '.14em', textTransform: 'uppercase', color: '#B8943A', marginBottom: '14px' }}>
        Estimated cost — {label}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
        {[
          { label: 'Model', value: estimate.model },
          { label: 'Sections', value: String(estimate.section_count) },
          { label: 'Input tokens', value: fmt(pass.estimated_input_tokens) },
          { label: 'Output tokens', value: fmt(pass.estimated_output_tokens) },
        ].map(({ label: l, value }) => (
          <div key={l}>
            <div style={{ fontFamily: "'Space Mono',monospace", fontSize: '7.5px', color: '#6B6352', letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: '3px' }}>{l}</div>
            <div style={{ fontFamily: "'Space Mono',monospace", fontSize: '11px', color: '#C8BC9E' }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ borderTop: '1px solid rgba(184,148,58,0.1)', paddingTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontFamily: "'Space Mono',monospace", fontSize: '7.5px', color: '#6B6352', letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: '3px' }}>Estimated cost</div>
          <div style={{ fontFamily: "'Cinzel',serif", fontSize: '18px', color: '#D4B060' }}>
            ${pass.estimated_cost_usd < 0.01 ? pass.estimated_cost_usd.toFixed(4) : pass.estimated_cost_usd.toFixed(3)}
          </div>
        </div>
        <button onClick={onConfirm} style={primaryBtnStyle}>
          {action}
        </button>
      </div>
    </div>
  )
}

const primaryBtnStyle: React.CSSProperties = {
  background: 'rgba(184,148,58,0.15)',
  border: '1px solid rgba(184,148,58,0.4)',
  color: '#D4B060',
  fontFamily: "'Space Mono',monospace",
  fontSize: '9px',
  letterSpacing: '.12em',
  textTransform: 'uppercase',
  padding: '10px 20px',
  borderRadius: '2px',
  cursor: 'pointer',
  marginTop: '8px',
}
