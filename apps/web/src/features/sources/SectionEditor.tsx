import { useEffect, useState } from 'react'
import type { Section, SectionUpdate } from './sourceApi'

interface Props {
  documentId: string
  sections: Section[]
  onSave: (sections: SectionUpdate[]) => void | Promise<void>
}

export function SectionEditor({ sections, onSave }: Props) {
  const [titles, setTitles] = useState<Record<string, string | null>>(
    () => Object.fromEntries(sections.map((s) => [s.id, s.title])),
  )
  const [saving, setSaving] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  // After save, the parent replaces sections with new DB rows (new UUIDs).
  // Resync titles so inputs don't go blank.
  useEffect(() => {
    setTitles(Object.fromEntries(sections.map((s) => [s.id, s.title])))
  }, [sections])

  function setTitle(id: string, value: string) {
    setTitles((prev) => ({ ...prev, [id]: value || null }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const payload: SectionUpdate[] = sections.map((s) => ({
      id: s.id,
      ordinal: s.ordinal,
      title: titles[s.id] ?? null,
      text: s.text,
    }))
    await onSave(payload)
    setSaving(false)
    setConfirmed(true)
  }

  if (confirmed) {
    return (
      <div>
        <ol style={{ listStyle: 'none', padding: 0 }}>
          {sections.map((s) => (
            <li key={s.id} style={{ marginBottom: '1rem' }}>
              <div style={{ fontWeight: 500 }}>
                {s.ordinal + 1}. {s.title ?? <em style={{ color: '#888' }}>untitled</em>}
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#666', marginTop: '0.2rem' }}>
                {s.id}
              </div>
            </li>
          ))}
        </ol>
        <button type="button" onClick={() => setConfirmed(false)}>
          Edit sections
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit}>
      <ol style={{ listStyle: 'none', padding: 0 }}>
        {sections.map((s) => (
          <li key={s.id} style={{ marginBottom: '1rem' }}>
            <label>
              <span style={{ display: 'block', fontSize: '0.75rem', color: '#666' }}>
                Section {s.ordinal + 1} title
              </span>
              <input
                type="text"
                value={titles[s.id] ?? ''}
                onChange={(e) => setTitle(s.id, e.target.value)}
                style={{ width: '100%' }}
              />
            </label>
            <p style={{ marginTop: '0.25rem', fontSize: '0.875rem', color: '#444' }}>
              {s.text.slice(0, 160)}
              {s.text.length > 160 ? '…' : ''}
            </p>
          </li>
        ))}
      </ol>
      <button type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save sections'}
      </button>
    </form>
  )
}
