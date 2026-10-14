import { createHash } from 'node:crypto'
import type { CatalogHeadRow } from '../db/rows.ts'
import { CatalogError } from './errors.ts'

export type CatalogAggregateHead = Pick<CatalogHeadRow, 'dataset_name' | 'scope' | 'publication_epoch'>
export type CatalogAggregateSource = readonly [
  'orca-1012-catalog-aggregate-v1', string, string, string
]
export type CatalogAggregateAnchor = {
  readonly aggregateId: string
  readonly sourceTuple: CatalogAggregateSource
}

/** Internal outbox identity only. The caller supplies its actual locked head. */
export function deriveCatalogAggregateAnchor(head: CatalogAggregateHead): CatalogAggregateAnchor {
  const sourceTuple: CatalogAggregateSource = Object.freeze([
    'orca-1012-catalog-aggregate-v1', head.dataset_name, head.scope, head.publication_epoch
  ])
  if (sourceTuple.some(value => typeof value !== 'string' || !value)) {
    throw new CatalogError('CATALOG_AGGREGATE_SOURCE')
  }
  const bytes = createHash('sha256').update(JSON.stringify(sourceTuple)).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  const aggregateId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  return Object.freeze({ aggregateId, sourceTuple })
}
