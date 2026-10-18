import React from 'react'
import type { Section } from './sourceApi'
import type { Phase } from './workflowTypes'

interface Props {
  phase: Phase
  sections: Section[]
  currentIdx: number
  gapSectionsDone: number
  candidatesSoFar: number
  elapsedMs: number
  runningGapPass: boolean
}

export function WorkflowProgressBar({
  phase, sections, currentIdx, gapSectionsDone,
  candidatesSoFar, elapsedMs, runningGapPass,
}: Props) {
  if (!(phase === 'cataloging' || phase === 'extracting' || runningGapPass) || sections.length === 0) {
    return null
  }

  const sectionsDone = runningGapPass ? gapSectionsDone : currentIdx
  const label = runningGapPass ? 'Gap scan' : phase === 'cataloging' ? 'Cataloging' : 'Extracting'
  const barDone = phase === 'extracting' ? sectionsDone - 1 : sectionsDone
  const pct = Math.max(2, (barDone / sections.length) * 100)

  return (
    <div style={{
      flexShrink: 0, background: 'var(--parchment)', borderBottom: '1px solid var(--border-warm)',
      padding: '0.3rem 1.5rem 0.35rem', display: 'flex', alignItems: 'center', gap: '0.75rem',
    }}>
      <span style={{ fontSize: '0.62rem', color: 'var(--ink-faint)', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
        {label} section {phase === 'extracting' ? sectionsDone : sectionsDone + 1} of {sections.length}
      </span>
      <div style={{ flex: 1, height: '3px', borderRadius: '2px', background: 'rgba(212,188,138,0.15)', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: '2px', background: 'var(--gold)', width: `${pct}%`, transition: 'width 0.4s ease' }} />
      </div>
      <span style={{ fontSize: '0.62rem', color: 'var(--ink-faint)', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
        {phase === 'extracting' && candidatesSoFar > 0 ? `${candidatesSoFar} claims · ` : ''}
        {(elapsedMs / 1000).toFixed(1)}s
      </span>
    </div>
  )
}
