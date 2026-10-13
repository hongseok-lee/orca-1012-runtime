import type { Pool } from 'pg'
import { withDurableTransaction } from '../db/connection.ts'
import { pageLimit, uuid, reject } from '../replay/validation.ts'
import type { NotificationList, NotificationRow } from './types.ts'

// Internal authorized adapter supplies access scope. Reads do not acknowledge,
// resolve, wake or mutate any state.
export async function listNotifications(pool: Pool, request: NotificationList): Promise<{ notifications: NotificationRow[]; nextAfterId: string | null }> {
  const input = Object.freeze({ afterId: request.afterId, state: request.state, optionalUnitFilter: request.optionalUnitFilter, limit: request.limit })
  pageLimit(input.limit)
  if (input.afterId) { uuid(input.afterId) }
  if (input.optionalUnitFilter) { uuid(input.optionalUnitFilter) }
  if (input.state !== undefined && input.state !== 'OPEN' && input.state !== 'RESOLVED') { reject('NOTIFICATION_STATE') }
  return withDurableTransaction(pool, async tx => {
    await tx.query('SET TRANSACTION READ ONLY')
    const rows = await tx.query<NotificationRow>(`SELECT n.* FROM durable_runtime.notifications n WHERE
      ($1::uuid IS NULL OR n.id>$1::uuid) AND ($2::text IS NULL OR n.state=$2)
      AND ($3::uuid IS NULL OR n.target_ref->>'runtimeUnitId'=$3::text OR EXISTS(
        SELECT 1 FROM durable_runtime.runtime_event_queue q JOIN durable_runtime.runtime_event_producers p USING(producer_id,incarnation)
        WHERE q.event_id::text=n.target_ref->>'eventId' AND p.runtime_unit_id=$3::uuid))
      ORDER BY n.id LIMIT $4`, [input.afterId ?? null, input.state ?? null, input.optionalUnitFilter ?? null, input.limit])
    return { notifications: rows.rows, nextAfterId: rows.rows.at(-1)?.id ?? input.afterId ?? null }
  })
}
