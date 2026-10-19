import React from 'react'
import type { Candidate } from '../candidates/candidateApi'
import { CandidatesTable } from '../candidates/CandidatesTable'
import type { Document, Section } from './sourceApi'
import { validateCatalog, type CatalogValidationResult } from './extractionApi'
import { AtlasEditor } from '../atlas/AtlasEditor'
import { AtlasExplorer } from '../atlas/AtlasExplorer'
import { useWorkflowOrchestrator } from './useWorkflowOrchestrator'
import { WorkflowHeader } from './WorkflowHeader'
import { WorkflowProgressBar } from './WorkflowProgressBar'
import { WorkflowToasts } from './WorkflowToasts'
import { CatalogSlot } from './CatalogSlot'

interface Props {
  document: Document
  sections: Section[]
  onBack: () => void
  onEditSections: () => void
  onEdit?: () => void
  onDelete?: () => void
}

export function SourceWorkflow({ document, sections, onBack, onEditSections, onEdit, onDelete }: Props) {
  const w = useWorkflowOrchestrator(document, sections)

  // ── Main content ───────────────────────────────────────────────────────────

  function renderContent() {
    const isReadOnly = !w.catalogConfirmed

    const pendingClaims = !w.atlasDone
      ? Object.values(w.allCandidates).flat()
          .filter(c => c.kind === 'claim')
          .map(c => {
            const p = c.payload as Record<string, unknown>
            return {
              id: c.id,
              subject: String(p.subject ?? ''),
              predicate: String(p.predicate ?? ''),
              object: String(p.object ?? ''),
            }
          })
          .filter(c => c.subject && c.predicate && c.object)
      : []

    const pendingVisualClaims = !w.atlasDone
      ? Object.entries(w.allCandidates).flatMap(([sectionId, candidates]) => {
          const section = sections.find(s => s.id === sectionId)
          return candidates
            .filter(c => c.kind === 'visual_claim')
            .map(c => {
              const p = c.payload as Record<string, unknown>
              return {
                id: c.id,
                subject: String(p.subject ?? ''),
                category: String(p.category ?? ''),
                observation: String(p.observation ?? ''),
                excerpt: c.excerpt ?? null,
                section_title: section?.title ?? null,
              }
            })
            .filter(c => c.subject && c.observation)
        })
      : []

    if (w.showExplorer) {
      return (
        <AtlasExplorer
          documentId={document.id}
          sections={sections.map(s => ({ id: s.id, title: s.title ?? '' }))}
          onAtlasLoaded={w.handleAtlasLoaded}
        />
      )
    }

    const showCatalogSlot = w.phase === 'catalog-review' || w.gapReviewPending

    const catalogCandidates = (() => {
      const src: Candidate[] =
        w.gapReviewPending && w.phase !== 'catalog-review'
          ? (w.catalogPasses[w.catalogPasses.length - 1]?.candidates ?? [])
          : w.phase === 'catalog-review'
          ? w.uniqueEntityCandidates
          : []
      return src.map(c => ({
        id: c.id,
        name: String((c.payload as Record<string, unknown>).name ?? ''),
        excerpt: c.excerpt ?? null,
        source: c.source ?? 'catalog',
        isRejected: w.rejectedCandidateIds.has(c.id),
        parentContext: ((c.payload as Record<string, unknown>).parent_context as string | null) ?? null,
        note: ((c.payload as Record<string, unknown>).note as string | null) ?? null,
        sectionTitle: sections.find(s => s.id === c.section_id)?.title ?? null,
        spatialLevel: ((c.payload as Record<string, unknown>).spatial_level as number | null) ?? null,
        placeType: ((c.payload as Record<string, unknown>).type as string | null) ?? null,
      }))
    })()

    const dedupProposals = w.dedupCandidates.length > 0 && !w.dedupDone
      ? w.dedupCandidates.map(c => ({
          id: c.id,
          subject: c.subject,
          object: c.object,
          rationale: c.rationale ?? null,
          isRejected: w.rejectedDedupIds.has(c.id),
        }))
      : []

    const catalogSlotNode = showCatalogSlot ? (
      <CatalogSlot
        validatingWeb={w.validatingWeb}
        webCheckCost={w.webCheckCost}
        webSuggestions={w.webSuggestions}
        addPlaceInput={w.addPlaceInput}
        showAddSuggestions={w.showAddSuggestions}
        addingPlace={w.addingPlace}
        filteredSuggestions={w.filteredSuggestions}
        addPlaceRef={w.addPlaceRef}
        onValidate={async () => {
          w.setValidatingWeb(true)
          try {
            const result: CatalogValidationResult = await validateCatalog(document.id)
            w.setWebSuggestions(result.suggestions)
            w.setWebCheckCost(result.cost_usd)
          } catch { /* ignore */ } finally { w.setValidatingWeb(false) }
        }}
        onAddManualPlace={w.handleAddManualPlace}
        onInputChange={w.handleInputChange}
        onFocus={() => w.setShowAddSuggestions(true)}
        onBlur={() => setTimeout(() => w.setShowAddSuggestions(false), 150)}
        onDismissWebSuggestions={() => w.setWebSuggestions(null)}
        onWebSuggestionClick={(name) => {
          w.handleAddManualPlace(name)
          w.setWebSuggestions(prev => prev ? prev.filter(x => x.name !== name) : prev)
        }}
      />
    ) : undefined

    return (
      <AtlasEditor
        key={w.atlasKey}
        documentId={document.id}
        readOnly={isReadOnly}
        canExplore={w.phase === 'done'}
        pendingClaims={pendingClaims}
        pendingVisualClaims={pendingVisualClaims}
        catalogCandidates={catalogCandidates}
        onToggleCatalogReject={w.toggleReject}
        dedupProposals={dedupProposals}
        onToggleDedupReject={(id) => w.setRejectedDedupIds(prev => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })}
        hideHeader={true}
        isReviewingCatalog={catalogCandidates.length > 0}
        onConfirmCatalog={showCatalogSlot ? w.handleConfirmCatalog : undefined}
        confirmingCatalog={w.confirmingCatalog}
        confirmCatalogSlot={catalogSlotNode}
        onConfirmDedup={w.handleConfirmDedup}
        confirmingDedup={w.confirmingDedup}
        dedupConfirmCount={w.dedupCandidates.length - w.rejectedDedupIds.size}
        onDone={() => w.setShowExplorer(true)}
      />
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const headerProps = {
    document, onBack, phase: w.phase, runningGapPass: w.runningGapPass,
    runningDedup: w.runningDedup, spatialDone: w.spatialDone, atlasDone: w.atlasDone,
    atlasStale: w.atlasStale, dedupDone: w.dedupDone, catalogConfirmed: w.catalogConfirmed,
    showExplorer: w.showExplorer, totalCost: w.totalCost,
    catalogCostLo: w.catalogCostLo, catalogCostHi: w.catalogCostHi,
    evidenceCostLo: w.evidenceCostLo, evidenceCostHi: w.evidenceCostHi,
    synthCostLo: w.synthCostLo, synthCostHi: w.synthCostHi,
    enrichCostLo: w.enrichCostLo, enrichCostHi: w.enrichCostHi,
    onRunCatalog: () => w.handleRunCatalog(false), onGapPass: w.handleGapPass,
    onStartEvidence: w.handleStartEvidence, onDedupStep: w.handleDedupStep,
    onSynthesize: () => w.handleSynthesize(false), onExportAtlas: w.handleExportAtlas,
    onToggleExplorer: () => w.setShowExplorer(v => !v),
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', position: 'relative' }}>
      {w.showExplorer ? (
        <>
          <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {renderContent()}
          </main>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20 }}>
            <WorkflowHeader {...headerProps} />
          </div>
        </>
      ) : (
        <>
          <WorkflowHeader {...headerProps} />
          <WorkflowProgressBar
            phase={w.phase} sections={sections} currentIdx={w.currentIdx}
            gapSectionsDone={w.gapSectionsDone} candidatesSoFar={w.candidatesSoFar}
            elapsedMs={w.elapsedMs} runningGapPass={w.runningGapPass}
          />
          <main style={{ flex: 1, overflow: 'hidden', backgroundColor: 'var(--parchment)', display: 'flex', flexDirection: 'column' }}>
            {renderContent()}
          </main>
        </>
      )}
      <WorkflowToasts toasts={w.toasts} />
    </div>
  )
}
