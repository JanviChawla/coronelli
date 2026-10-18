import type { Candidate } from '../candidates/candidateApi'

export const SPATIAL_LEVEL_LABELS: Record<number, string> = {
  0: 'Realm', 1: 'Territory', 2: 'Place', 3: 'Feature',
}

export interface CatalogPass {
  label: string
  candidates: Candidate[]
  sectionIds: Set<string>
}

export function buildFirstPass(entities: Candidate[], label: string): CatalogPass {
  const sectionIds = new Set(entities.map(c => c.section_id))
  const seen = new Set<string>()
  const candidates: Candidate[] = []
  for (const c of entities) {
    const name = String((c.payload as Record<string, unknown>).name ?? '').toLowerCase()
    if (name && !seen.has(name)) { seen.add(name); candidates.push(c) }
  }
  return { label, candidates, sectionIds }
}

export function buildGapPass(
  newEntities: Candidate[],
  knownNames: Set<string>,
  passNumber: number,
): CatalogPass {
  const sectionIds = new Set(newEntities.map(c => c.section_id))
  const seen = new Set<string>()
  const candidates: Candidate[] = []
  for (const c of newEntities) {
    const name = String((c.payload as Record<string, unknown>).name ?? '').toLowerCase()
    if (name && !knownNames.has(name) && !seen.has(name)) { seen.add(name); candidates.push(c) }
  }
  return { label: `Gap pass ${passNumber}`, candidates, sectionIds }
}

export function buildPassesFromEntities(entities: Candidate[]): CatalogPass[] {
  const catalogEntities = entities.filter(e => e.source !== 'gap')
  const gapEntities = entities.filter(e => e.source === 'gap')
  const passes: CatalogPass[] = [buildFirstPass(catalogEntities, 'Catalog')]
  if (gapEntities.length > 0) {
    const knownNames = new Set(
      catalogEntities.map(c => String((c.payload as Record<string, unknown>).name ?? '').toLowerCase())
    )
    passes.push(buildGapPass(gapEntities, knownNames, 1))
  }
  return passes
}
