import type { Pool } from 'pg'
import type { RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import { runDurableMutation, type JsonValue, type MutationOutcome, type ReceiptIdentity } from '../db/atomic.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { discoverUnitMembers, lockUnitMembers } from '../lifecycle/locks.ts'

// Uses the shared receipt-first/COMMIT resolution and complete member locks.
// Requests are frozen by each public entry before its first await.
export async function mutateEpisode(
  pool: Pool, unit: RuntimeUnitId, identity: ReceiptIdentity,
  callback: (tx: DurableTransaction) => Promise<JsonValue>
): Promise<MutationOutcome> {
  const members = await discoverUnitMembers(pool, unit)
  return runDurableMutation(pool, { ...identity, locks: { sessionIds: members, runtimeUnitIds: [unit] } }, async tx => {
    await lockUnitMembers(tx, unit, members)
    return callback(tx)
  })
}
