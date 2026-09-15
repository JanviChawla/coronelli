import { useEffect, useState } from 'react'
import { type AtlasEntity, type AtlasResponse, fetchAtlas } from './atlasApi'

interface Props {
  documentId: string
}

const PLACE_KIND_COLORS: Record<string, string> = {
  world: '#f0fdf4',
  region: '#dcfce7',
  settlement: '#dbeafe',
  landmark: '#ede9fe',
  building: '#fef9c3',
  room: '#fef3c7',
  hall: '#fef3c7',
  tunnel: '#f1f5f9',
  shaft: '#f1f5f9',
  passage: '#f1f5f9',
  portal: '#fce7f3',
  door: '#fce7f3',
  exterior: '#ecfdf5',
  terrain_feature: '#f0fdf4',
  body_of_water: '#eff6ff',
  site: '#f5f3ff',
  court: '#fff7ed',
  barrier: '#fef2f2',
}

function EntityCard({ entity }: { entity: AtlasEntity }) {
  const kindColor = PLACE_KIND_COLORS[entity.place_kind ?? ''] ?? '#f9fafb'

  return (
    <div style={{
      border: '1px solid #e5e7eb',
      borderRadius: '6px',
      padding: '0.65rem 0.85rem',
      marginBottom: '0.6rem',
      background: kindColor,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{entity.name}</span>
        {entity.place_kind && (
          <span style={{ fontSize: '0.7rem', color: '#666', background: 'rgba(0,0,0,0.06)', padding: '0.1rem 0.4rem', borderRadius: '3px' }}>
            {entity.place_kind}
          </span>
        )}
        {entity.aliases && entity.aliases.length > 0 && (
          <span style={{ fontSize: '0.72rem', color: '#888', fontStyle: 'italic' }}>
            also: {entity.aliases.join(', ')}
          </span>
        )}
      </div>

      {entity.claims.length > 0 && (
        <ul style={{ margin: '0.4rem 0 0', padding: '0 0 0 1rem', listStyle: 'disc', fontSize: '0.78rem', color: '#444' }}>
          {entity.claims.map(claim => {
            const subj = (claim.payload.subject as string) || entity.name
            const pred = claim.predicate ?? (claim.payload.predicate as string) ?? '?'
            const obj = (claim.payload.object as string) ?? ''
            return (
              <li key={claim.id} style={{ marginBottom: '0.1rem' }}>
                <span style={{ color: '#888', fontSize: '0.7rem', marginRight: '0.3rem' }}>
                  {claim.claim_type === 'visual' ? 'visual' : 'spatial'}
                </span>
                {claim.claim_type === 'visual'
                  ? `${claim.payload.visual_property as string ?? pred}: ${claim.payload.value as string ?? ''}`
                  : `${subj} ${pred} ${obj}`}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function ApprovedAtlasView({ documentId }: Props) {
  const [atlas, setAtlas] = useState<AtlasResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchAtlas(documentId)
      .then(setAtlas)
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load atlas'))
      .finally(() => setLoading(false))
  }, [documentId])

  if (loading) return <p style={{ color: '#888', fontSize: '0.85rem' }}>Loading atlas…</p>
  if (error) return <p role="alert" style={{ color: 'red', fontSize: '0.85rem' }}>{error}</p>
  if (!atlas || atlas.entity_count === 0) {
    return <p style={{ color: '#888', fontSize: '0.85rem' }}>No approved entities yet. Review the provisional atlas above to approve places.</p>
  }

  return (
    <div>
      <p style={{ fontSize: '0.78rem', color: '#888', marginBottom: '0.75rem' }}>
        {atlas.entity_count} place{atlas.entity_count !== 1 ? 's' : ''}
        {atlas.claim_count > 0 && <> · {atlas.claim_count} claim{atlas.claim_count !== 1 ? 's' : ''}</>}
        {atlas.travel_rule_count > 0 && <> · {atlas.travel_rule_count} route{atlas.travel_rule_count !== 1 ? 's' : ''}</>}
      </p>

      <div>
        {atlas.entities.map(entity => (
          <EntityCard key={entity.id} entity={entity} />
        ))}
      </div>

      {atlas.travel_rules.length > 0 && (
        <div style={{ marginTop: '1.25rem' }}>
          <h4 style={{ fontSize: '0.78rem', color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 0.4rem', fontWeight: 600 }}>
            Routes <span style={{ fontWeight: 400, color: '#aaa' }}>{atlas.travel_rules.length}</span>
          </h4>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {atlas.travel_rules.map(rule => (
              <li key={rule.id} style={{ fontSize: '0.82rem', padding: '0.3rem 0', borderBottom: '1px solid #f0f0f0', display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
                <span style={{ fontSize: '0.68rem', background: '#ede9fe', padding: '0.1rem 0.4rem', borderRadius: '3px', flexShrink: 0 }}>
                  {rule.can_traverse === false ? 'blocked' : 'route'}
                </span>
                <span>{rule.route}</span>
                {rule.traveler && <span style={{ color: '#888', fontSize: '0.75rem' }}>— {rule.traveler}</span>}
                {rule.condition && <span style={{ color: '#999', fontSize: '0.72rem', fontStyle: 'italic' }}>if {rule.condition}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
