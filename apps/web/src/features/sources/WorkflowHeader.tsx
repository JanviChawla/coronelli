import React from 'react'
import type { Document } from './sourceApi'
import type { Phase } from './workflowTypes'

interface Props {
  document: Document
  onBack: () => void
  phase: Phase
  runningGapPass: boolean
  runningDedup: boolean
  spatialDone: boolean
  atlasDone: boolean
  atlasStale: boolean
  dedupDone: boolean
  catalogConfirmed: boolean
  showExplorer: boolean
  totalCost: number | null
  catalogCostLo: number
  catalogCostHi: number
  evidenceCostLo: number
  evidenceCostHi: number
  synthCostLo: number
  synthCostHi: number
  enrichCostLo: number
  enrichCostHi: number
  onRunCatalog: () => void
  onGapPass: () => void
  onStartEvidence: () => void
  onDedupStep: () => void
  onSynthesize: () => void
  onExportAtlas: () => void
  onToggleExplorer: () => void
}

function cBtn(clickable: boolean, gold = false): React.CSSProperties {
  return {
    fontSize: '0.72rem', padding: '0.22rem 0.6rem',
    background: clickable ? (gold ? 'rgba(212,188,138,0.13)' : 'rgba(212,188,138,0.07)') : 'rgba(212,188,138,0.03)',
    border: `1px solid ${clickable ? (gold ? 'rgba(212,188,138,0.45)' : 'rgba(212,188,138,0.28)') : 'rgba(212,188,138,0.1)'}`,
    borderRadius: '4px', cursor: clickable ? 'pointer' : 'default',
    color: clickable ? (gold ? 'var(--gold)' : 'var(--ink)') : 'var(--ink-faint)',
    opacity: clickable ? 1 : 0.45,
    display: 'flex', alignItems: 'center', gap: '0.15rem',
    whiteSpace: 'nowrap' as const, transition: 'background 0.12s',
  }
}

export function WorkflowHeader({
  document, onBack, phase, runningGapPass, runningDedup, spatialDone, atlasDone, atlasStale,
  dedupDone, catalogConfirmed, showExplorer, totalCost,
  catalogCostLo, catalogCostHi, evidenceCostLo, evidenceCostHi,
  synthCostLo, synthCostHi, enrichCostLo, enrichCostHi,
  onRunCatalog, onGapPass, onStartEvidence, onDedupStep, onSynthesize,
  onExportAtlas, onToggleExplorer,
}: Props) {
  const catalogRunOnce = phase !== 'preflight' && phase !== 'ready'
  const isCataloging = phase === 'cataloging'
  const catalogLabel = isCataloging ? 'Finding…' : catalogRunOnce ? 'Catalog +' : 'Catalog'
  const catalogClickable = !isCataloging && phase !== 'preflight'
  const catalogHandler = catalogRunOnce ? onGapPass : onRunCatalog

  const isRunningDedup = runningDedup || phase === 'synthesizing'
  const synthLabel = isRunningDedup
    ? 'Synthesizing…'
    : atlasDone && dedupDone ? 'Re-synthesize'
    : 'Synthesize'
  const synthClickable = spatialDone && !isRunningDedup
  const synthHandler = dedupDone ? onSynthesize : onDedupStep
  const costLo = dedupDone ? synthCostLo : enrichCostLo
  const costHi = dedupDone ? synthCostHi : enrichCostHi

  return (
    <>
      {/* Brand header */}
      <header style={{
        flexShrink: 0, display: 'flex', alignItems: 'center',
        background: 'var(--sidebar-bg)', borderBottom: '1px solid var(--sidebar-border)',
        height: '2.6rem', padding: '0 1.5rem',
      }}>
        <button
          type="button"
          onClick={onBack}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.24em',
            color: 'var(--gold)', textTransform: 'uppercase', flexShrink: 0,
            transition: 'opacity 0.12s',
          }}
          title="Back to library"
        >
          Coronelli
        </button>
        <div style={{
          flex: 1, textAlign: 'center', fontSize: '0.85rem', color: 'var(--sidebar-text)',
          fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          padding: '0 2rem',
        }}>
          {document.title}
        </div>
      </header>

      {/* Pipeline toolbar */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.65rem',
        background: 'var(--parchment)', borderBottom: '1px solid var(--border-warm)',
        padding: '0.55rem 1.5rem',
      }}>
        <span style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', flexShrink: 0 }}>
          Atlas Editor
        </span>
        <div style={{ width: '1px', height: '1.1rem', background: 'var(--border-warm)', flexShrink: 0, marginLeft: '0.15rem', marginRight: '0.15rem' }} />

        {/* Catalog */}
        <button
          type="button"
          disabled={!catalogClickable || runningGapPass}
          onClick={catalogClickable && !runningGapPass ? catalogHandler : undefined}
          style={cBtn(catalogClickable && !runningGapPass)}
        >
          {runningGapPass ? 'Scanning…' : catalogLabel}
          {totalCost !== null && (
            <span style={{ opacity: 0.55, fontSize: '0.67rem', marginLeft: '0.1rem' }}>
              ({catalogCostLo.toFixed(2)}–{catalogCostHi.toFixed(2)})
            </span>
          )}
        </button>

        {/* Extract */}
        <button
          type="button"
          disabled={!catalogConfirmed || phase === 'extracting'}
          onClick={catalogConfirmed && phase !== 'extracting' ? onStartEvidence : undefined}
          style={cBtn(catalogConfirmed && phase !== 'extracting')}
        >
          {phase === 'extracting' ? 'Extracting…' : spatialDone ? 'Extract +' : 'Extract'}
          <span style={{ opacity: 0.55, fontSize: '0.67rem', marginLeft: '0.1rem' }}>
            ({evidenceCostLo.toFixed(2)}–{evidenceCostHi.toFixed(2)})
          </span>
        </button>

        {/* Synthesize */}
        <button
          type="button"
          disabled={!synthClickable}
          onClick={synthClickable ? synthHandler : undefined}
          style={cBtn(synthClickable)}
        >
          {synthLabel}
          <span style={{ opacity: 0.55, fontSize: '0.67rem', marginLeft: '0.1rem' }}>
            ({costLo.toFixed(2)}–{costHi.toFixed(2)})
          </span>
        </button>

        {/* Export */}
        <button
          type="button"
          disabled={!atlasDone}
          onClick={atlasDone ? onExportAtlas : undefined}
          style={{
            ...cBtn(atlasDone),
            color: atlasDone ? 'var(--gold)' : undefined,
            border: atlasDone ? '1px solid rgba(212,188,138,0.4)' : undefined,
          }}
        >
          Export atlas.json ↓
        </button>

        <div style={{ flex: 1 }} />

        {/* Launch / Back toggle */}
        <button
          type="button"
          className="btn-cta"
          disabled={!atlasDone && !showExplorer}
          onClick={onToggleExplorer}
          style={{
            display: 'inline-flex', alignItems: 'center', width: 'auto', flexShrink: 0,
            padding: '0.32rem 0.9rem', fontSize: '0.78rem',
            opacity: atlasDone || showExplorer ? 1 : 0.38,
            cursor: atlasDone || showExplorer ? 'pointer' : 'not-allowed',
            whiteSpace: 'nowrap',
          }}
        >
          {showExplorer ? '← Atlas Editor' : 'Launch Atlas Explorer'}
        </button>
      </div>
    </>
  )
}
