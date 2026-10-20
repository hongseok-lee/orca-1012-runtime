import { randomUUID } from 'node:crypto'
import type { DurableTransaction } from '../db/connection.ts'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { advanceCatalogProjection } from './heads.ts'
import { enqueueOutbox } from '../journal/store.ts'

/** Notify subscribers after the delivery observation commits. Reads derive the
 * status from that delivery, rather than storing a second mutable activity flag. */
export async function publishTerminalActivity(tx: DurableTransaction, sessionId: string): Promise<void> {
  const rows = await tx.query<{workspace_id: string}>(`SELECT DISTINCT t.workspace_id FROM durable_runtime.tabs t
    JOIN durable_runtime.catalog_tab_metadata meta ON meta.tab_id=t.id
    JOIN durable_runtime.catalog_heads h ON h.scope='workspace:'||t.workspace_id::text
    WHERE t.session_id=$1 AND t.kind='terminal' AND t.lifecycle='OPEN'`, [sessionId])
  if (!rows.rowCount) { return }
  const heads = await advanceCatalogProjection(tx, ['catalog', ...rows.rows.map(row => `workspace:${row.workspace_id}`)])
  const global = heads.find(head => head.scope === 'catalog')!
  for (const row of rows.rows) {
    await enqueueOutbox(tx, {eventId: logicalId('event', randomUUID()), aggregateId: row.workspace_id,
      aggregateKind: 'catalog', revision: counter('row:catalog-head', global.revision),
      event: {kind: 'CATALOG_TERMINAL_ACTIVITY', detail: {sessionId}}})
  }
}
