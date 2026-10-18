import { useState, useEffect } from 'react'
import type { AtlasEntity, EntityExcerpt } from './atlasApi'
import { fetchEntityExcerpts } from './atlasApi'
import { TIER_LABEL, TIER_BAR } from './atlasExplorerUtils'

interface Props {
  entity: AtlasEntity
  entityMap: Map<string, AtlasEntity>
  allEntities: AtlasEntity[]
  documentId: string
  sections: Array<{ id: string; title: string }>
  firstSeenOrdinal?: number
  onClose: () => void
}

const SM = "'Space Mono', monospace"
const SL_LABEL: Record<number, string> = { 0: 'Realm', 1: 'Territory', 2: 'Place', 3: 'Feature' }
const SPATIAL_PREDS = ['LOCATED_IN', 'CONTAINS', 'LEADS_TO', 'ADJACENT_TO', 'PART_OF', 'FLOWS_THROUGH']
const PRED_FLIP: Record<string, string> = { LOCATED_IN: 'CONTAINS', CONTAINS: 'LOCATED_IN', PART_OF: 'CONTAINS' }

export function AtlasExplorerDetailPanel({ entity, entityMap, allEntities, documentId, sections, firstSeenOrdinal, onClose }: Props) {
  const [excerpts, setExcerpts] = useState<EntityExcerpt[]>([])

  useEffect(() => {
    setExcerpts([])
    fetchEntityExcerpts(documentId, entity.id)
      .then(res => setExcerpts(res.filter(e => e.excerpt).slice(0, 3)))
      .catch(() => {})
  }, [documentId, entity.id])

  // Palette: prefer entity.payload.colors {primary, atmosphere, accent} (set by synthesis),
  // fall back to palette arrays on visual claims (extraction-only runs)
  const payloadColors = entity.payload.colors as { primary?: string; atmosphere?: string; accent?: string } | null
  const paletteFromPayload: Array<{ hex: string; label: string }> = payloadColors
    ? ([
        payloadColors.primary   ? { hex: payloadColors.primary,    label: 'primary'    } : null,
        payloadColors.atmosphere && payloadColors.atmosphere !== payloadColors.primary
          ? { hex: payloadColors.atmosphere, label: 'atmosphere' } : null,
        payloadColors.accent && payloadColors.accent !== payloadColors.primary && payloadColors.accent !== payloadColors.atmosphere
          ? { hex: payloadColors.accent,     label: 'accent'     } : null,
      ].filter(Boolean) as Array<{ hex: string; label: string }>)
    : []

  const paletteFromClaims = entity.claims
    .filter(c => c.claim_type === 'visual' && Array.isArray(c.payload.palette))
    .flatMap(c => c.payload.palette as Array<{ color?: string; hex?: string; c?: string; label?: string; l?: string }>)
    .map(p => ({ hex: p.color ?? p.hex ?? p.c ?? '', label: p.label ?? p.l ?? '' }))
    .filter(p => p.hex)

  const seenHex = new Set<string>()
  const palette = (paletteFromPayload.length > 0 ? paletteFromPayload : paletteFromClaims).filter(p => {
    if (!p.hex || seenHex.has(p.hex)) return false
    seenHex.add(p.hex); return true
  }).slice(0, 6)

  const tier     = (entity.payload.tier as string) ?? 'surface'
  const kindDesc = (entity.payload.kind_descriptor as string) ?? entity.place_kind ?? ''
  const sl       = (entity.payload.spatial_level as number) ?? 2

  // Visual observation excerpts
  const observations = entity.claims
    .filter(c => c.claim_type === 'visual' && c.excerpt && !Array.isArray(c.payload.palette))
    .map(c => ({ kind: (c.predicate ?? 'observation').replace(/_/g, ' ').toLowerCase(), text: c.excerpt! }))
    .slice(0, 4)

  const aliases = (entity.aliases ?? []).filter(Boolean)

  // Spatial connections — outgoing from entity.claims, incoming by scanning allEntities
  const conns: Array<{ pred: string; name: string; dir: 'out' | 'in' }> = []
  const seen = new Set<string>()

  for (const claim of entity.claims) {
    if (!claim.predicate || !SPATIAL_PREDS.includes(claim.predicate)) continue
    if (!claim.object_refs?.length) continue
    const tid = claim.object_refs[0], key = `out|${claim.predicate}|${tid}`
    if (seen.has(key)) continue; seen.add(key)
    const target = entityMap.get(tid)
    if (target) conns.push({ pred: claim.predicate, name: target.name, dir: 'out' })
  }

  for (const other of allEntities) {
    if (other.id === entity.id) continue
    for (const claim of other.claims) {
      if (!claim.predicate || !SPATIAL_PREDS.includes(claim.predicate)) continue
      if (!claim.object_refs?.includes(entity.id)) continue
      const flipped = PRED_FLIP[claim.predicate] ?? claim.predicate
      const key = `in|${flipped}|${other.id}`
      if (seen.has(key)) continue; seen.add(key)
      conns.push({ pred: flipped, name: other.name, dir: 'in' })
    }
  }

  // First seen label
  const firstSeenLabel = (() => {
    if (firstSeenOrdinal == null) return null
    const sec = sections[firstSeenOrdinal - 1]
    if (sec?.title) return `§${firstSeenOrdinal} — ${sec.title}`
    return `Section ${firstSeenOrdinal}`
  })()

  return (
    <div style={{
      position: 'absolute', left: 0, top: 0, bottom: 0, width: 288,
      background: 'rgba(5,12,26,.92)', borderRight: '1px solid rgba(184,148,58,.18)',
      backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      fontFamily: "'Crimson Pro', Georgia, serif", zIndex: 30,
      transform: 'translateX(0)', transition: 'transform .38s cubic-bezier(.16,1,.3,1)',
    }}>
      <button onClick={onClose} style={{
        position: 'absolute', top: 18, right: 16, background: 'none', border: 'none',
        cursor: 'pointer', color: '#6B6352', fontSize: 18, padding: '4px 6px', lineHeight: 1,
        transition: 'color .15s',
      }}>×</button>

      <div style={{ padding: '54px 22px 18px', borderBottom: '1px solid rgba(184,148,58,.18)', position: 'relative' }}>
        <div style={{ fontFamily: SM, fontSize: 8, color: '#B8943A', letterSpacing: '.14em', textTransform: 'uppercase', marginBottom: 6 }}>
          {kindDesc || 'Place'}
        </div>
        <div style={{ fontFamily: "'Cinzel', serif", fontSize: 19, fontWeight: 400, color: '#D4B060', lineHeight: 1.15, marginBottom: 10 }}>
          {entity.name}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: SM, fontSize: 8, letterSpacing: '.08em', textTransform: 'uppercase', color: '#6B6352', padding: '3px 8px', border: '1px solid rgba(184,148,58,.18)', borderRadius: 2 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: TIER_BAR[tier] ?? '#4A7A4A', flexShrink: 0, display: 'inline-block' }} />
            {TIER_LABEL[tier] ?? tier}
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: SM, fontSize: 8, letterSpacing: '.08em', textTransform: 'uppercase', color: '#6B6352', padding: '3px 8px', border: '1px solid rgba(184,148,58,.18)', borderRadius: 2 }}>
            L{sl} · {SL_LABEL[sl] ?? 'Place'}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 22px 24px', scrollbarWidth: 'thin', scrollbarColor: 'rgba(184,148,58,.18) transparent' }}>

        {/* First seen */}
        {firstSeenLabel && (
          <>
            <div style={{ fontFamily: SM, fontSize: 8, letterSpacing: '.12em', color: '#6B6352', textTransform: 'uppercase', margin: '18px 0 8px', paddingBottom: 5, borderBottom: '1px solid rgba(184,148,58,.12)' }}>
              First seen
            </div>
            <div style={{ fontFamily: SM, fontSize: 10, color: '#A89878', letterSpacing: '.04em' }}>
              {firstSeenLabel}
            </div>
          </>
        )}

        {/* Book quotes */}
        {excerpts.length > 0 && (
          <>
            <div style={{ fontFamily: SM, fontSize: 8, letterSpacing: '.12em', color: '#6B6352', textTransform: 'uppercase', margin: '20px 0 10px', paddingBottom: 5, borderBottom: '1px solid rgba(184,148,58,.12)' }}>
              From the text
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {excerpts.map((ex, i) => (
                <div key={i}>
                  <blockquote style={{ margin: 0, padding: '0 0 0 10px', borderLeft: '2px solid rgba(184,148,58,.35)', fontFamily: "'Crimson Pro', Georgia, serif", fontStyle: 'italic', fontSize: 12.5, color: '#A89878', lineHeight: 1.6 }}>
                    "{ex.excerpt}"
                  </blockquote>
                  {ex.section_title && (
                    <div style={{ fontFamily: SM, fontSize: 7, color: '#5A5040', textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 5, paddingLeft: 12 }}>
                      {ex.section_title}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Visual observations */}
        {observations.length > 0 && (
          <>
            <div style={{ fontFamily: SM, fontSize: 8, letterSpacing: '.12em', color: '#6B6352', textTransform: 'uppercase', margin: '20px 0 10px', paddingBottom: 5, borderBottom: '1px solid rgba(184,148,58,.12)' }}>
              Observations
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {observations.map((o, i) => (
                <div key={i}>
                  <div style={{ fontFamily: SM, fontSize: 7, color: '#B8943A', textTransform: 'uppercase', letterSpacing: '.10em', marginBottom: 4 }}>{o.kind}</div>
                  <blockquote style={{ margin: 0, padding: '0 0 0 10px', borderLeft: '2px solid rgba(184,148,58,.35)', fontFamily: "'Crimson Pro', Georgia, serif", fontStyle: 'italic', fontSize: 13, color: '#A89878', lineHeight: 1.55 }}>
                    "{o.text}"
                  </blockquote>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Sensory palette */}
        {palette.length > 0 && (
          <>
            <div style={{ fontFamily: SM, fontSize: 8, letterSpacing: '.12em', color: '#6B6352', textTransform: 'uppercase', margin: '20px 0 10px', paddingBottom: 5, borderBottom: '1px solid rgba(184,148,58,.12)' }}>
              Palette
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {palette.map((p, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 18, height: 18, borderRadius: 4, background: p.hex, display: 'inline-block', flexShrink: 0, boxShadow: `0 0 8px ${p.hex}AA, 0 0 2px ${p.hex}` }} />
                  <span style={{ fontFamily: SM, fontSize: 8, color: '#8A7A60' }}>{p.label}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Aliases */}
        {aliases.length > 0 && (
          <>
            <div style={{ fontFamily: SM, fontSize: 8, letterSpacing: '.12em', color: '#6B6352', textTransform: 'uppercase', margin: '20px 0 8px', paddingBottom: 5, borderBottom: '1px solid rgba(184,148,58,.12)' }}>
              Also known as
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {aliases.map((a, i) => (
                <span key={i} style={{ fontFamily: "'Crimson Pro', Georgia, serif", fontStyle: 'italic', fontSize: 12, color: '#7A7060', padding: '2px 7px', border: '1px solid rgba(184,148,58,.18)', borderRadius: 2 }}>{a}</span>
              ))}
            </div>
          </>
        )}

        {/* Spatial relations */}
        {conns.length > 0 && (
          <>
            <div style={{ fontFamily: SM, fontSize: 8, letterSpacing: '.12em', color: '#6B6352', textTransform: 'uppercase', margin: '20px 0 8px', paddingBottom: 5, borderBottom: '1px solid rgba(184,148,58,.12)' }}>
              Spatial Relations
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {conns.map((c, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 7, padding: '5px 8px', borderRadius: 3, background: 'rgba(184,148,58,.04)', border: '1px solid rgba(184,148,58,.08)' }}>
                  <span style={{ fontFamily: SM, fontSize: 7, color: '#5A8AAA', textTransform: 'uppercase', letterSpacing: '.06em', flexShrink: 0 }}>
                    {c.pred.replace(/_/g, ' ')}
                  </span>
                  <span style={{ fontFamily: "'Crimson Pro', Georgia, serif", fontSize: 13, color: '#C8BC9E' }}>{c.name}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
