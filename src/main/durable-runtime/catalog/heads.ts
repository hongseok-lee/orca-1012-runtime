import type { CatalogHeadRow } from '../db/rows.ts'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, type DurableTransaction } from '../db/connection.ts'
import { catalogSnapshotVersion } from './revision.ts'

/** Final projection lock rank. Call only after all aggregate/metadata locks. */
export async function advanceCatalogProjection(
  tx: DurableTransaction, inputScopes: readonly string[]
): Promise<readonly CatalogHeadRow[]> {
  const scopes = Object.freeze([...new Set(inputScopes)].sort())
  for (const scope of scopes) {
    if (tx.isLockHeld(10, scope)) continue
    tx.advanceLock(10, scope)
    const row = await tx.query<CatalogHeadRow>(
      'SELECT * FROM durable_runtime.catalog_heads WHERE scope=$1 FOR UPDATE', [scope]
    )
    if (row.rowCount !== 1) throw new DurableDatabaseError('CATALOG_HEAD_MISSING')
    // Refuse the mutation rather than publish a rounded or zero wire revision.
    catalogSnapshotVersion(counter('row:catalog-head', BigInt(row.rows[0].revision) + 1n))
    tx.markLockAcquired(10, scope)
  }
  const changed: CatalogHeadRow[] = []
  for (const scope of scopes) {
    const row = await tx.query<CatalogHeadRow>(
      'UPDATE durable_runtime.catalog_heads SET revision=revision+1 WHERE scope=$1 RETURNING *', [scope]
    )
    changed.push(row.rows[0])
  }
  return Object.freeze(changed)
}

export async function lockCatalogMetadata(tx: DurableTransaction, inputKeys: readonly string[]): Promise<void> {
  const keys = Object.freeze([...new Set(inputKeys)].sort())
  for (const key of keys) {
    if (tx.isLockHeld(6, key)) continue
    tx.advanceLock(6, key)
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`durable_runtime:catalog:${key}`])
    tx.markLockAcquired(6, key)
  }
}
