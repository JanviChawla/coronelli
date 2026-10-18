import type { AtlasEntity } from './atlasApi'
import { TIER_Y, TIER_LABEL, TIER_BAR } from './atlasExplorerUtils'

interface Props {
  entity: AtlasEntity
  entityMap: Map<string, AtlasEntity>
  onClose: () => void
}

const SM = "'Space Mono', monospace"
const SL_LABEL: Record<number, string> = { 0: 'Realm', 1: 'Territory', 2: 'Place', 3: 'Feature' }

export function AtlasExplorerDetailPanel({ entity, entityMap, onClose }: Props) {
  // Palette lives on visual claims (claim_type='visual'), not on the entity payload
  const paletteRaw = entity.claims
    .filter(c => c.claim_type === 'visual' && Array.isArray(c.payload.palette))
    .flatMap(c => c.payload.palette as Array<{ color?: string; hex?: string; c?: string; label?: string; l?: string }>)
  const seenHex = new Set<string>()
  const palette = paletteRaw.filter(p => {
    const h = p.color ?? p.hex ?? p.c ?? ''
    if (!h || seenHex.has(h)) return false
    seenHex.add(h); return true
  }).slice(0, 6)
  const tier     = (entity.payload.tier as string) ?? 'surface'
  const kindDesc = (entity.payload.kind_descriptor as string) ?? entity.place_kind ?? ''
  const sl       = (entity.payload.spatial_level as number) ?? 2
  const yv       = TIER_Y[tier] ?? 0

  // Visual observation excerpts (non-palette visual claims with text)
  const observations = entity.claims
    .filter(c => c.claim_type === 'visual' && c.excerpt && !Array.isArray(c.payload.palette))
    .map(c => ({ kind: (c.predicate ?? 'observation').replace(/_/g, ' ').toLowerCase(), text: c.excerpt! }))
    .slice(0, 4)

  const aliases = (entity.aliases ?? []).filter(Boolean)

  const conns: Array<{ pred: string; name: string; dir: 'out' | 'in' }> = []
  const seen = new Set<string>()
  for (const claim of entity.claims) {
    if (!claim.predicate || !['LOCATED_IN','CONTAINS','LEADS_TO','ADJACENT_TO','PART_OF','FLOWS_THROUGH'].includes(claim.predicate)) continue
    if (!claim.object_refs?.length) continue
    const tid = claim.object_refs[0], key = `${claim.predicate}|${tid}`
    if (seen.has(key)) continue; seen.add(key)
    const target = entityMap.get(tid)
    if (target) conns.push({ pred: claim.predicate, name: target.name, dir: 'out' })
  }

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

        {/* Elevation */}
        <div style={{ fontFamily: SM, fontSize: 8, letterSpacing: '.12em', color: '#6B6352', textTransform: 'uppercase', margin: '18px 0 8px', paddingBottom: 5, borderBottom: '1px solid rgba(184,148,58,.12)' }}>
          Elevation
        </div>
        <div style={{ fontFamily: SM, fontSize: 22, color: '#C8BC9E', letterSpacing: '-.02em' }}>
          {`Z ${yv >= 0 ? '+' : ''}${yv.toFixed(1)}`}
        </div>
        <div style={{ fontFamily: SM, fontSize: 8, color: '#6B6352', textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 2 }}>
          {TIER_LABEL[tier] ?? tier} tier
        </div>

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
              {palette.map((p, i) => {
                const hex = p.color ?? p.hex ?? p.c ?? '#6B6352'
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 14, height: 14, borderRadius: 3, background: hex, display: 'inline-block', flexShrink: 0, boxShadow: `0 0 6px ${hex}88` }} />
                    <span style={{ fontFamily: SM, fontSize: 8, color: '#8A7A60' }}>{p.label ?? p.l ?? ''}</span>
                  </div>
                )
              })}
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
