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

  const conns: Array<{ pred: string; name: string }> = []
  const seen = new Set<string>()
  for (const claim of entity.claims) {
    if (!claim.predicate || !claim.object_refs?.length) continue
    const tid = claim.object_refs[0], key = `${claim.predicate}|${tid}`
    if (seen.has(key)) continue; seen.add(key)
    const target = entityMap.get(tid)
    if (target) conns.push({ pred: claim.predicate, name: target.name })
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
        <div style={{ fontFamily: SM, fontSize: 8, letterSpacing: '.12em', color: '#6B6352', textTransform: 'uppercase', margin: '18px 0 8px', paddingBottom: 5, borderBottom: '1px solid #25201A' }}>
          Elevation
        </div>
        <div style={{ fontFamily: SM, fontSize: 22, color: '#C8BC9E', letterSpacing: '-.02em' }}>
          {`Z ${yv >= 0 ? '+' : ''}${yv.toFixed(1)}`}
        </div>
        <div style={{ fontFamily: SM, fontSize: 8, color: '#6B6352', textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 2 }}>
          {TIER_LABEL[tier] ?? tier} tier
        </div>

        {palette && palette.length > 0 && (
          <>
            <div style={{ fontFamily: SM, fontSize: 8, letterSpacing: '.12em', color: '#6B6352', textTransform: 'uppercase', margin: '18px 0 8px', paddingBottom: 5, borderBottom: '1px solid #25201A' }}>
              Sensory Identity
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {palette.map((p, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: SM, fontSize: 8, color: '#6B6352' }}>
                  <span style={{ width: 12, height: 12, borderRadius: 2, background: p.color ?? p.hex ?? p.c ?? '#6B6352', display: 'inline-block', flexShrink: 0 }} />
                  {p.label ?? p.l ?? ''}
                </div>
              ))}
            </div>
          </>
        )}

        {conns.length > 0 && (
          <>
            <div style={{ fontFamily: SM, fontSize: 8, letterSpacing: '.12em', color: '#6B6352', textTransform: 'uppercase', margin: '18px 0 8px', paddingBottom: 5, borderBottom: '1px solid #25201A' }}>
              Spatial Relations
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {conns.map((c, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13, color: '#C8BC9E', padding: '5px 7px', borderRadius: 3, border: '1px solid transparent', transition: 'background .12s, border-color .12s' }}>
                  <span style={{ fontFamily: SM, fontSize: 7.5, color: '#25201A', textTransform: 'uppercase', letterSpacing: '.05em', flexShrink: 0 }}>
                    {c.pred.replace(/_/g, ' ')}
                  </span>
                  {c.name}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
