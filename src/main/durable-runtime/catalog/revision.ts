import { createHash } from 'node:crypto'
import type { JsonValue } from '../db/atomic.ts'
import { canonicalInputJson } from '../input/canonical.ts'
import { captureCatalogJson } from './immutable.ts'
import { CatalogError } from './errors.ts'

export function catalogSnapshotVersion(revision: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(revision)) throw new CatalogError('CATALOG_REVISION')
  const value = BigInt(revision)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CatalogError('CATALOG_REVISION_OVERFLOW')
  return Number(value)
}

/** Filters/limit/capability projection belong to the query identity, not just the head. */
export function catalogSnapshotId(input: {
  readonly publicationEpoch: string
  readonly revision: string
  readonly queryProjection: JsonValue
}): string {
  if (typeof input.publicationEpoch !== 'string' || !input.publicationEpoch) {
    throw new CatalogError('CATALOG_EPOCH')
  }
  catalogSnapshotVersion(input.revision)
  const snapshot = captureCatalogJson({
    epoch: input.publicationEpoch, revision: input.revision,
    query: input.queryProjection
  })
  return createHash('sha256').update(canonicalInputJson(snapshot)).digest('base64url')
}
