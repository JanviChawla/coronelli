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

    </>
  )
}
