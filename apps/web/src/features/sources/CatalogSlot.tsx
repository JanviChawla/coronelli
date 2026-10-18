import React from 'react'
import type { CatalogValidationSuggestion } from './extractionApi'

interface Props {
  validatingWeb: boolean
  webCheckCost: number | null
  webSuggestions: CatalogValidationSuggestion[] | null
  addPlaceInput: string
  showAddSuggestions: boolean
  addingPlace: boolean
  filteredSuggestions: string[]
  addPlaceRef: React.RefObject<HTMLDivElement>
  onValidate: () => void
  onAddManualPlace: (name: string) => void
  onInputChange: (val: string) => void
  onFocus: () => void
  onBlur: () => void
  onDismissWebSuggestions: () => void
  onWebSuggestionClick: (name: string) => void
}

export function CatalogSlot({
  validatingWeb, webCheckCost, webSuggestions,
  addPlaceInput, showAddSuggestions, addingPlace,
  filteredSuggestions, addPlaceRef,
  onValidate, onAddManualPlace, onInputChange,
  onFocus, onBlur, onDismissWebSuggestions, onWebSuggestionClick,
}: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={validatingWeb}
          onClick={onValidate}
          style={{
            background: 'none', border: '1px solid var(--border-warm)', borderRadius: '4px',
            cursor: validatingWeb ? 'default' : 'pointer', fontSize: '0.72rem',
            color: 'var(--ink-muted)', opacity: validatingWeb ? 0.5 : 1,
            padding: '0.22rem 0.6rem', whiteSpace: 'nowrap',
          }}
          title="Ask the AI what named places might be missing based on its knowledge of this book"
        >
          {validatingWeb ? 'Checking…' : '? Check web'}
          {!validatingWeb && webCheckCost !== null && (
            <span style={{ opacity: 0.55, fontSize: '0.67rem', marginLeft: '0.1rem' }}>
              (${webCheckCost.toFixed(4)})
            </span>
          )}
        </button>

        <div ref={addPlaceRef} style={{ position: 'relative' }}>
          <input
            type="text"
            placeholder="+ Add place…"
            value={addPlaceInput}
            disabled={addingPlace}
            onChange={e => onInputChange(e.target.value)}
            onFocus={onFocus}
            onBlur={onBlur}
            onKeyDown={e => {
              if (e.key === 'Enter' && addPlaceInput.trim()) onAddManualPlace(addPlaceInput.trim())
              if (e.key === 'Escape') { onInputChange('') }
            }}
            style={{
              padding: '0.22rem 0.55rem', background: 'rgba(212,188,138,0.07)',
              border: '1px solid var(--border-warm)', borderRadius: '4px',
              color: 'var(--ink)', fontSize: '0.72rem', outline: 'none', width: '140px',
            }}
          />
          {showAddSuggestions && filteredSuggestions.length > 0 && (
            <div style={{
              position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 50,
              background: 'var(--parchment-card)', border: '1px solid var(--border-warm)',
              borderRadius: '4px 4px 0 0', boxShadow: '0 -4px 12px rgba(0,0,0,0.18)',
              maxHeight: '8rem', overflowY: 'auto',
            }}>
              {filteredSuggestions.map(s => (
                <button
                  key={s}
                  type="button"
                  onMouseDown={() => onAddManualPlace(s)}
                  style={{
                    width: '100%', padding: '0.3rem 0.6rem', background: 'none', border: 'none',
                    cursor: 'pointer', textAlign: 'left', fontSize: '0.75rem', color: 'var(--ink)',
                    borderBottom: '1px solid rgba(212,188,138,0.12)',
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {webSuggestions && webSuggestions.length > 0 && (
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '0.68rem', color: 'var(--ink-faint)', flexShrink: 0 }}>AI suggests:</span>
          {webSuggestions.map(s => (
            <button
              key={s.name}
              type="button"
              onClick={() => onWebSuggestionClick(s.name)}
              title={[s.reason, s.first_seen ? `First seen: ${s.first_seen}` : ''].filter(Boolean).join(' · ')}
              style={{
                fontSize: '0.68rem', padding: '0.15rem 0.45rem',
                background: 'rgba(212,188,138,0.08)', border: '1px solid rgba(212,188,138,0.25)',
                borderRadius: '3px', cursor: 'pointer', color: 'var(--ink-muted)',
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.05rem',
              }}
            >
              <span>+ {s.name}</span>
              {s.first_seen && <span style={{ fontSize: '0.60rem', opacity: 0.65 }}>{s.first_seen}</span>}
            </button>
          ))}
          <button
            type="button"
            onClick={onDismissWebSuggestions}
            style={{
              fontSize: '0.68rem', padding: '0.15rem 0.35rem', background: 'none',
              border: 'none', cursor: 'pointer', color: 'var(--ink-faint)', marginLeft: 'auto',
            }}
          >
            ×
          </button>
        </div>
      )}

      {webSuggestions !== null && webSuggestions.length === 0 && (
        <span style={{ fontSize: '0.68rem', color: 'var(--ink-faint)' }}>
          No missing places found by AI check.
        </span>
      )}
    </div>
  )
}
