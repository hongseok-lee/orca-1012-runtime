import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { RuntimeUnitId, SessionId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, type DurableTransaction, withDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'

export async function discoverUnitMembers(pool: Pool, unitId: RuntimeUnitId): Promise<SessionId[]> {
  return withDurableTransaction(pool, async tx => {
    const members = await tx.query<{ session_id: string }>(
      'SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1 ORDER BY session_id', [unitId]
    )
    return members.rows.map(row => logicalId('session', row.session_id))
  })
}
// Catalog passes the complete discovered set, including closed members. Reentry
// uses the DB owner's held-row tracker; no late Session lock is acquired.
export async function lockUnitMembers(
  tx: DurableTransaction, unitId: RuntimeUnitId, discovered: readonly SessionId[]
): Promise<SessionId[]> {
  const expected = [...new Set(discovered)].sort()
  await lockAggregates(tx, { sessionIds: expected, runtimeUnitIds: [unitId] })
  const actual = await tx.query<{ session_id: string }>(
    'SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1 ORDER BY session_id', [unitId]
  )
  const current = actual.rows.map(row => logicalId('session', row.session_id))
  if (JSON.stringify(expected) !== JSON.stringify(current)) {
    throw new DurableDatabaseError('LIFECYCLE_MEMBERSHIP_CHANGED')
  }
  return current
}
