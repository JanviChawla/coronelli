import type { AtlasClaim, AtlasEntity } from './atlasApi'

export type HierarchyResult = {
  parentOf: Map<string, string>
  parentClaimOf: Map<string, { claim: AtlasClaim; inverse: boolean }>
  childrenOf: Map<string, string[]>
  rootIds: string[]
  depthOf: Map<string, number>
}

export function buildHierarchy(entities: AtlasEntity[]): HierarchyResult {
  const entityMap = new Map(entities.map(e => [e.id, e]))
  const parentOf = new Map<string, string>()
  const parentClaimOf = new Map<string, { claim: AtlasClaim; inverse: boolean }>()

  // Pass 1: LOCATED_IN / PART_OF — direct parent relationships (highest priority)
  for (const entity of entities) {
    for (const claim of entity.claims) {
      if (
        claim.claim_type === 'spatial' &&
        (claim.predicate === 'LOCATED_IN' || claim.predicate === 'PART_OF') &&
        claim.object_refs?.[0] &&
        entityMap.has(claim.object_refs[0])
      ) {
        parentOf.set(entity.id, claim.object_refs[0])
        parentClaimOf.set(entity.id, { claim, inverse: false })
        break
      }
    }
  }

  // Pass 2: CONTAINS — inverse parent relationships (only where not already set)
  for (const entity of entities) {
    for (const claim of entity.claims) {
      if (
        claim.claim_type === 'spatial' &&
        claim.predicate === 'CONTAINS' &&
        claim.object_refs?.[0] &&
        entityMap.has(claim.object_refs[0])
      ) {
        const childId = claim.object_refs[0]
        if (!parentOf.has(childId)) {
          parentOf.set(childId, entity.id)
          parentClaimOf.set(childId, { claim, inverse: true })
        }
      }
    }
  }

  const childrenOf = new Map<string, string[]>()
  for (const e of entities) childrenOf.set(e.id, [])
  for (const [childId, parentId] of parentOf) {
    childrenOf.get(parentId)?.push(childId)
  }

  const rootIds = entities
    .filter(e => !parentOf.has(e.id))
    .map(e => e.id)
    .sort((a, b) => (entityMap.get(a)?.name ?? '').localeCompare(entityMap.get(b)?.name ?? ''))

  const depthOf = new Map<string, number>()
  const computeDepth = (id: string, visited = new Set<string>()): number => {
    if (depthOf.has(id)) return depthOf.get(id)!
    if (visited.has(id)) return 0
    visited.add(id)
    const parent = parentOf.get(id)
    const d = parent ? 1 + computeDepth(parent, visited) : 0
    depthOf.set(id, d)
    return d
  }
  for (const e of entities) computeDepth(e.id)

  return { parentOf, parentClaimOf, childrenOf, rootIds, depthOf }
}
