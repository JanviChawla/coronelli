import type { AtlasEntity } from './atlasApi'
import type { EntityExcerpt } from './atlasApi'
import type { PendingVisualClaim } from './AtlasEditor'

interface Props {
  focusedEntity: AtlasEntity | null | undefined
  selectedIds: string[]
  entityMap: Map<string, AtlasEntity>
  excerpts: EntityExcerpt[]
  loadingExcerpts: boolean
  pendingVisualClaims: PendingVisualClaim[]
}

export function AtlasDetailPanel({ focusedEntity, selectedIds, entityMap, excerpts, loadingExcerpts, pendingVisualClaims }: Props) {
  return (
    <div style={{
      width: 'calc(100% / 3)', flexShrink: 0,
      borderRight: '1px solid var(--border-warm)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ padding: '0.8rem 1.25rem 0.5rem', borderBottom: '1px solid rgba(212,188,138,0.25)', flexShrink: 0 }}>
        <div style={{ fontSize: '0.58rem', color: 'var(--ink-faint)', letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: '0.22rem' }}>
          Place Detail
        </div>
        {focusedEntity ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.88rem', color: 'var(--ink)', fontWeight: 600 }}>{focusedEntity.name}</span>
            {(() => {
              const colors = focusedEntity.payload.colors as { primary?: string; atmosphere?: string; accent?: string } | undefined
              return (
                <span style={{ display: 'flex', gap: '4px', flexShrink: 0, alignItems: 'center' }}>
                  {(['primary', 'atmosphere', 'accent'] as const).map(role => {
                    const hex = colors?.[role]
                    return (
                      <span key={role} title={hex ? `${role}: ${hex}` : `${role}: none`} style={{
                        width: '10px', height: '10px', borderRadius: '2px', flexShrink: 0,
                        background: hex ?? 'transparent',
                        border: hex ? '1px solid rgba(0,0,0,0.15)' : '1px dashed rgba(212,188,138,0.3)',
                      }} />
                    )
                  })}
                </span>
              )
            })()}
            {selectedIds.length === 2 && (
              <span style={{ fontSize: '0.65rem', color: 'var(--ink-faint)', fontStyle: 'italic' }}>
                · absorbs {entityMap.get(selectedIds[1])?.name}
              </span>
            )}
          </div>
        ) : (
          <div style={{ fontSize: '0.73rem', color: 'var(--ink-faint)', fontStyle: 'italic' }}>
            Click a place to inspect it
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0.6rem 1.25rem 1rem' }}>
        {focusedEntity ? (
          <>
            {loadingExcerpts && (
              <p style={{ fontSize: '0.75rem', color: 'var(--ink-faint)', margin: 0 }}>Loading excerpts…</p>
            )}
            {!loadingExcerpts && excerpts.length === 0 && (
              <p style={{ fontSize: '0.75rem', color: 'var(--ink-faint)', margin: 0, fontStyle: 'italic' }}>No excerpts found for this place.</p>
            )}
            {!loadingExcerpts && excerpts.map((ex, i) => (
              <div key={i} style={{ marginBottom: '0.6rem' }}>
                {ex.section_title && (
                  <div style={{ fontSize: '0.58rem', color: 'var(--gold)', opacity: 0.7, marginBottom: '0.15rem', letterSpacing: '0.04em' }}>
                    {ex.section_title}
                  </div>
                )}
                <p style={{
                  fontSize: '0.78rem', color: 'var(--ink-muted)', margin: 0,
                  lineHeight: 1.55, fontStyle: 'italic',
                  borderLeft: '2px solid rgba(212,188,138,0.3)', paddingLeft: '0.6rem',
                }}>
                  "{ex.excerpt}"
                </p>
              </div>
            ))}
            {(() => {
              if (pendingVisualClaims.length > 0) {
                const names = new Set([
                  focusedEntity.name.toLowerCase(),
                  ...(focusedEntity.aliases ?? []).map(a => a.toLowerCase()),
                ])
                const matching = pendingVisualClaims.filter(v => names.has(v.subject.toLowerCase()))
                if (matching.length === 0) return null
                return (
                  <div style={{ marginTop: '0.75rem' }}>
                    <div style={{ fontSize: '0.58rem', color: 'var(--ink-faint)', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: '0.4rem', borderTop: '1px solid rgba(212,188,138,0.15)', paddingTop: '0.55rem' }}>
                      Visual observations · {matching.length}
                    </div>
                    {matching.map(v => (
                      <div key={v.id} style={{ marginBottom: '0.55rem' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', marginBottom: '0.15rem' }}>
                          {v.section_title && (
                            <span style={{ fontSize: '0.58rem', color: 'var(--gold)', opacity: 0.7, letterSpacing: '0.04em' }}>{v.section_title}</span>
                          )}
                          <span style={{ fontSize: '0.55rem', color: 'var(--ink-faint)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{v.category}</span>
                        </div>
                        <p style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', margin: 0, lineHeight: 1.5, borderLeft: '2px solid rgba(139,171,202,0.35)', paddingLeft: '0.6rem' }}>
                          {v.observation}
                        </p>
                        {v.excerpt && v.excerpt !== v.observation && (
                          <p style={{ fontSize: '0.72rem', color: 'var(--ink-faint)', margin: '0.2rem 0 0 0.6rem', lineHeight: 1.4, fontStyle: 'italic' }}>
                            "{v.excerpt}"
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )
              }
              const visualClaims = (focusedEntity.claims ?? []).filter(c => c.claim_type === 'visual')
              if (visualClaims.length === 0) return null
              return (
                <div style={{ marginTop: '0.75rem' }}>
                  <div style={{ fontSize: '0.58rem', color: 'var(--ink-faint)', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: '0.4rem', borderTop: '1px solid rgba(212,188,138,0.15)', paddingTop: '0.55rem' }}>
                    Visual observations · {visualClaims.length}
                  </div>
                  {visualClaims.map(v => {
                    const category = String(v.payload.category ?? v.payload.visual_property ?? '')
                    const observation = String(v.payload.observation ?? v.payload.value ?? '')
                    return (
                      <div key={v.id} style={{ marginBottom: '0.55rem' }}>
                        {category && (
                          <span style={{ fontSize: '0.55rem', color: 'var(--ink-faint)', letterSpacing: '0.06em', textTransform: 'uppercase', display: 'block', marginBottom: '0.15rem' }}>{category}</span>
                        )}
                        <p style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', margin: 0, lineHeight: 1.5, borderLeft: '2px solid rgba(139,171,202,0.35)', paddingLeft: '0.6rem' }}>
                          {observation}
                        </p>
                        {v.excerpt && v.excerpt !== observation && (
                          <p style={{ fontSize: '0.72rem', color: 'var(--ink-faint)', margin: '0.2rem 0 0 0.6rem', lineHeight: 1.4, fontStyle: 'italic' }}>
                            "{v.excerpt}"
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })()}
          </>
        ) : (
          <p style={{ fontSize: '0.78rem', color: 'var(--ink-faint)', margin: 0, fontStyle: 'italic', lineHeight: 1.6 }}>
            Select a place in the containment tree to see its excerpts and visual observations here.
          </p>
        )}
      </div>
    </div>
  )
}
