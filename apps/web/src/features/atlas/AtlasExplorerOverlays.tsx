import type { AtlasResponse } from './atlasApi'
import { TIER_Y, TIER_LABEL, TIER_BAR } from './atlasExplorerUtils'

interface Props {
  loading: boolean
  error: string | null
  atlas: AtlasResponse | null
  selectedId: string | null
  sectionCount: number
  revealUpTo: number
  onRevealChange: (v: number) => void
}

const SM = "'Space Mono', monospace"

export function AtlasExplorerOverlays({ loading, error, atlas, selectedId, sectionCount, revealUpTo, onRevealChange }: Props) {
  return (
    <>
      {loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B6352', fontFamily: SM, fontSize: '0.8rem', pointerEvents: 'none' }}>
          Loading atlas…
        </div>
      )}
      {error && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#c44', fontFamily: SM, fontSize: '0.8rem', pointerEvents: 'none' }}>
          {error}
        </div>
      )}

      {/* Elevation legend */}
      {!loading && !error && (
        <div style={{ position: 'absolute', right: 18, top: '50%', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', gap: 1, pointerEvents: 'none' }}>
          {(['peak', 'elevated', 'surface', 'underground', 'deep'] as const).map(tier => (
            <div key={tier} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
              <div style={{ width: 2, height: 26, borderRadius: 1, background: TIER_BAR[tier], flexShrink: 0 }} />
              <div>
                <span style={{ display: 'block', fontFamily: SM, fontSize: 7.5, letterSpacing: '.09em', color: '#6B6352', textTransform: 'uppercase' }}>{TIER_LABEL[tier]}</span>
                <span style={{ display: 'block', fontFamily: SM, fontSize: 7, color: '#4A5A72' }}>{TIER_Y[tier] >= 0 ? `Z +${TIER_Y[tier]}` : `Z ${TIER_Y[tier]}`}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Header */}
      {!loading && !error && atlas && (
        <header style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px 0', pointerEvents: 'none', zIndex: 20 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontFamily: "'Cinzel', serif", fontSize: 17, fontWeight: 400, letterSpacing: '.22em', color: '#D4B060' }}>CORONELLI</span>
            <span style={{ fontFamily: SM, fontSize: 8, color: '#6B6352', letterSpacing: '.10em', textTransform: 'uppercase', border: '1px solid #25201A', padding: '2px 6px', borderRadius: 2 }}>3D Atlas</span>
          </div>
          <span style={{ fontFamily: "'Crimson Pro', Georgia, serif", fontStyle: 'italic', fontSize: 13, color: '#6B6352' }}>
            {atlas.entity_count} places
          </span>
        </header>
      )}

      {/* Controls */}
      {!loading && !error && (
        <div style={{ position: 'absolute', bottom: 18, right: 18, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, pointerEvents: 'none', zIndex: 20 }}>
          {[['drag', 'Orbit'], ['scroll', 'Zoom'], ['click', 'Inspect']].map(([k, l]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: SM, fontSize: 7.5, color: '#5A7090', textTransform: 'uppercase', letterSpacing: '.07em' }}>
              <span style={{ border: '1px solid rgba(90,112,144,0.45)', padding: '1px 5px', borderRadius: 2, fontSize: 7 }}>{k}</span>
              {l}
            </div>
          ))}
        </div>
      )}

      {/* Provenance scrubber */}
      {!loading && !error && sectionCount >= 1 && (
        <div style={{ position: 'absolute', bottom: 18, left: selectedId ? 308 : 18, right: 120, display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(6,12,24,0.72)', borderRadius: 4, padding: '8px 14px', zIndex: 20, backdropFilter: 'blur(8px)' }}>
          <span style={{ fontFamily: SM, fontSize: 8, color: '#6B6352', letterSpacing: '.1em', whiteSpace: 'nowrap' }}>§1</span>
          <input
            type="range"
            min={1}
            max={sectionCount}
            value={revealUpTo}
            onChange={e => onRevealChange(Number(e.target.value))}
            style={{ flex: 1, accentColor: '#B8943A', cursor: 'pointer' }}
          />
          <span style={{ fontFamily: SM, fontSize: 8, color: '#6B6352', letterSpacing: '.1em', whiteSpace: 'nowrap' }}>§{sectionCount}</span>
        </div>
      )}
    </>
  )
}
