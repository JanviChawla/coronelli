import React from 'react'
import type { Toast } from './workflowTypes'

interface Props {
  toasts: Toast[]
}

export function WorkflowToasts({ toasts }: Props) {
  if (toasts.length === 0) return null

  return (
    <div style={{
      position: 'fixed', bottom: '1.5rem', right: '1.5rem', zIndex: 9999,
      display: 'flex', flexDirection: 'column', gap: '0.5rem', pointerEvents: 'none',
    }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          padding: '0.7rem 1rem',
          borderRadius: '6px',
          fontSize: '0.78rem',
          lineHeight: 1.45,
          maxWidth: '340px',
          boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
          pointerEvents: 'auto',
          background: t.kind === 'success' ? 'rgba(30,42,22,0.97)' : t.kind === 'warn' ? 'rgba(42,30,10,0.97)' : 'rgba(18,24,36,0.97)',
          border: `1px solid ${t.kind === 'success' ? 'rgba(100,160,60,0.4)' : t.kind === 'warn' ? 'rgba(180,120,20,0.4)' : 'rgba(100,120,160,0.3)'}`,
          color: t.kind === 'success' ? '#a8d080' : t.kind === 'warn' ? '#d4a040' : '#a0b8d8',
        }}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
