import { randomUUID } from 'node:crypto'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { RuntimeUnitId, OperationId, RowRevision } from '../../../shared/durable-runtime/identity.ts'
import type { ObservationEpisodeRow } from '../db/rows.ts'
import type { JsonValue } from '../db/atomic.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import type { ObservationTarget } from './types.ts'

export function requireObservationUnitLock(tx: DurableTransaction, unit: RuntimeUnitId): void {
  if (!tx.isLockHeld(2, unit)) { throw new DurableDatabaseError('OBSERVATION_UNIT_LOCK_REQUIRED') }
}
export async function readOriginalEpisode(
  tx: DurableTransaction, id: ObservationEpisodeRow['id'], target: ObservationTarget
): Promise<ObservationEpisodeRow> {
  requireObservationUnitLock(tx, target.runtimeUnitId)
  const rows = await tx.query<ObservationEpisodeRow>(`SELECT * FROM durable_runtime.observation_episodes
    WHERE id=$1 AND runtime_unit_id=$2 AND attempt_id=$3 AND pod_uid=$4 AND execution_epoch=$5`,
    [id, target.runtimeUnitId, target.attemptId, target.podUid, target.executionEpoch])
  if (rows.rowCount !== 1) { throw new DurableDatabaseError('OBSERVATION_EPISODE_TARGET') }
  return rows.rows[0]
}
export function episodeResponse(row: ObservationEpisodeRow): JsonValue {
  return { episodeId: row.id, runtimeUnitId: row.runtime_unit_id, attemptId: row.attempt_id,
    podUid: row.pod_uid, executionEpoch: row.execution_epoch, state: row.state, revision: row.revision,
    startedAt: row.started_at.toISOString(), deadlineAt: row.deadline_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null, sourceRef: row.start_source_ref,
    producerId: row.start_producer_id, producerIncarnation: row.start_producer_incarnation, watermark: row.start_watermark,
    fenceOperationId: row.fence_operation_id, reason: row.reason }
}
export async function recordObservationEvent(tx: DurableTransaction, input: {
  actorId: string; target: ObservationTarget; episode?: ObservationEpisodeRow;
  kind: string; event: JsonValue; unitRevision: RowRevision<'runtime-unit'>;
  operationId?: OperationId; sourceRefs: readonly string[]
}): Promise<string> {
  const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now
  const eventId = logicalId('event', randomUUID())
  const event: JsonValue = { eventId, runtimeUnitId: input.target.runtimeUnitId,
    attemptId: input.target.attemptId, podUid: input.target.podUid, executionEpoch: input.target.executionEpoch,
    episodeId: input.episode?.id ?? null, operationId: input.operationId ?? null, detail: input.event, kind: input.kind }
  await appendAudit(tx, { actorId: input.actorId, runtimeUnitId: input.target.runtimeUnitId,
    operationId: input.operationId, attemptId: input.target.attemptId, podUid: input.target.podUid,
    kind: input.kind, nextState: event, occurredAt: now, receivedAt: now,
    producerId: input.target.runtimeUnitId, producerSeq: counter('sequence:producer', input.unitRevision),
    evidenceRefs: [...input.sourceRefs] })
  await enqueueOutbox(tx, { eventId, aggregateId: input.target.runtimeUnitId,
    aggregateKind: 'runtime-unit', revision: input.unitRevision, event })
  return eventId
}
