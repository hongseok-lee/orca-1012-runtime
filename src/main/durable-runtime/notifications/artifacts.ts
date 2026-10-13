import { randomUUID } from 'node:crypto'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { target } from '../replay/validation.ts'
import type { NotificationRow } from './types.ts'

export async function artifacts(tx: DurableTransaction, row: NotificationRow,
  input: { kind: 'NOTIFICATION_OPENED' | 'NOTIFICATION_OBSERVED' | 'NOTIFICATION_READ' | 'NOTIFICATION_RESOLVED'; eventId: string; actorId: string; evidenceRef: string; occurredAt: Date }): Promise<void> {
  const refs = target(row.target_ref)
  // P112's canonical target includes the immutable original event/Agent/Sessions;
  // derive its Unit from original producer binding, not current membership.
  if (!refs.runtimeUnitId && typeof refs.eventId === 'string') {
    const binding = await tx.query<{ runtime_unit_id: string }>(`SELECT p.runtime_unit_id FROM durable_runtime.runtime_event_queue q
      JOIN durable_runtime.runtime_event_producers p USING(producer_id,incarnation) WHERE q.event_id=$1`, [refs.eventId])
    if (binding.rows[0]) { refs.runtimeUnitId = binding.rows[0].runtime_unit_id }
  }
  const body: JsonValue = {
    kind: input.kind, sourceEventId: input.eventId, notificationId: row.id, incidentKey: row.incident_key,
    targetRef: refs, revision: row.revision, state: row.state, reasonCode: row.reason,
    retryCount: row.retry_count, firstSeenAt: row.first_seen_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null, resolvedAt: row.resolved_at?.toISOString() ?? null,
    actionRef: row.action_ref, occurredAt: input.occurredAt.toISOString()
  }
  await enqueueOutbox(tx, { eventId: logicalId('event', input.eventId), aggregateId: row.id,
    aggregateKind: 'notification', revision: counter('row:notification', row.revision), event: body })
  const now = await tx.query<{ at: Date }>('SELECT clock_timestamp() AS at')
  await appendAudit(tx, { actorId: input.actorId,
    // Include only a Unit whose business row was declared and locked up front.
    // Original queue-derived refs remain metadata if there was no Unit lock.
    runtimeUnitId: typeof refs.runtimeUnitId === 'string' && tx.isLockHeld(2, refs.runtimeUnitId) ? refs.runtimeUnitId : undefined,
    kind: input.kind, reasonCode: row.reason, nextState: body,
    occurredAt: input.occurredAt, receivedAt: now.rows[0].at, producerId: randomUUID(),
    producerSeq: counter('sequence:producer', '1'), evidenceRefs: [input.evidenceRef] })
}
