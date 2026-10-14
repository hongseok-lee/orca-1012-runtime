import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { OperationId, RowRevision } from '../../../shared/durable-runtime/identity.ts'
import type { ObservationEpisodeRow, RuntimeUnitRow } from '../db/rows.ts'
import { runDurableMutation, type JsonValue, type MutationOutcome } from '../db/atomic.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { discoverUnitMembers, lockUnitMembers } from '../lifecycle/locks.ts'
import type { ObservationLossRequest, ObservationSource, ObservationTarget } from './types.ts'
import { snapshotObservationLoss, snapshotObservationSource, snapshotObservationTarget } from './snapshot.ts'
import { assertObservationProducerBinding } from './target.ts'
import { episodeResponse, recordObservationEvent, requireObservationUnitLock } from './store.ts'

export type RecordObservationLossRequest = {
  readonly actorId: string
  readonly target: ObservationTarget
  readonly source: ObservationSource
  readonly operationId?: OperationId
}
export type RecordedObservationLoss =
  | { readonly status: 'RECORDED'; readonly episode: ObservationEpisodeRow;
      readonly created: boolean; readonly unitRevision: RowRevision<'runtime-unit'> }
  | { readonly status: 'STALE_HISTORY_ONLY'; readonly unitRevision: RowRevision<'runtime-unit'> }

/** Same-TX SQL entry after caller's whole Session→Unit lock and source checks.
 * No lower rank, external I/O, fake stop or provider state is introduced here. */
export async function recordObservationLoss(
  tx: DurableTransaction, caller: RecordObservationLossRequest
): Promise<RecordedObservationLoss> {
  const actorId = caller.actorId, operationId = caller.operationId
  const target = snapshotObservationTarget(caller.target)
  if (typeof actorId !== 'string' || !actorId) { throw new DurableDatabaseError('OBSERVATION_INPUT') }
  if (operationId !== undefined) { logicalId('operation', operationId) }
  const source = snapshotObservationSource(caller.source)
  requireObservationUnitLock(tx, target.runtimeUnitId)
  const unit = (await tx.query<RuntimeUnitRow>('SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [target.runtimeUnitId])).rows[0]
  const original = await tx.query(`SELECT id FROM durable_runtime.attempts WHERE id=$1
    AND runtime_unit_id=$2 AND pod_uid=$3 AND execution_epoch=$4`,
    [target.attemptId, target.runtimeUnitId, target.podUid, target.executionEpoch])
  if (!unit || original.rowCount !== 1) { throw new DurableDatabaseError('OBSERVATION_TARGET_STALE') }
  if (unit.active_attempt_id !== target.attemptId || unit.execution_epoch !== target.executionEpoch) {
    await recordObservationEvent(tx, { actorId, target, kind: 'OBSERVATION_LOSS_STALE',
      event: { source: { ...source } }, unitRevision: unit.revision, operationId, sourceRefs: [source.reference] })
    return { status: 'STALE_HISTORY_ONLY', unitRevision: unit.revision }
  }
  if (source.stream !== null) {
    if (source.watermark === null) { throw new DurableDatabaseError('OBSERVATION_SOURCE_WATERMARK') }
    await assertObservationProducerBinding(tx, target, source.stream)
  }
  const prior = await tx.query<ObservationEpisodeRow>(`SELECT * FROM durable_runtime.observation_episodes
    WHERE runtime_unit_id=$1 AND attempt_id=$2 AND pod_uid=$3 AND execution_epoch=$4 AND resolved_at IS NULL`,
    [target.runtimeUnitId, target.attemptId, target.podUid, target.executionEpoch])
  let episode = prior.rows[0]
  const created = !episode
  if (!episode) {
    const inserted = await tx.query<ObservationEpisodeRow>(`INSERT INTO durable_runtime.observation_episodes
      (id,runtime_unit_id,attempt_id,pod_uid,execution_epoch,start_source_ref,start_producer_id,start_producer_incarnation,start_watermark)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [logicalId('observation-episode', randomUUID()), target.runtimeUnitId, target.attemptId, target.podUid,
      target.executionEpoch, source.reference, source.stream?.producerId ?? null, source.stream?.incarnation ?? null, source.watermark])
    // DB016 supplies started_at and exactly started_at+6h. Node time and an
    // older Unit/attempt observation_lost_at never define a new episode.
    episode = inserted.rows[0]
  }
  const updated = await tx.query<{ revision: RowRevision<'runtime-unit'> }>(`UPDATE durable_runtime.runtime_units
    SET observation_lost_at=$2,revision=revision+1 WHERE id=$1 RETURNING revision`,
    [target.runtimeUnitId, episode.started_at])
  const unitRevision = updated.rows[0].revision
  await recordObservationEvent(tx, { actorId, target, episode,
    kind: created ? 'OBSERVATION_LOSS_STARTED' : 'OBSERVATION_LOSS_RECORDED',
    event: { episode: episodeResponse(episode), source: { ...source } }, unitRevision, operationId,
    sourceRefs: [source.reference] })
  return { status: 'RECORDED', episode, created, unitRevision }
}
export async function requestObservationLoss(pool: Pool, caller: ObservationLossRequest): Promise<MutationOutcome> {
  const { input, identity } = snapshotObservationLoss(caller)
  const members = await discoverUnitMembers(pool, input.target.runtimeUnitId)
  return runDurableMutation(pool, { ...identity, locks: { sessionIds: members,
    runtimeUnitIds: [input.target.runtimeUnitId] } }, async (tx): Promise<JsonValue> => {
    await lockUnitMembers(tx, input.target.runtimeUnitId, members)
    const result = await recordObservationLoss(tx, { actorId: identity.key.principalId, target: input.target, source: input.source })
    return result.status === 'RECORDED' ? { status: result.status, created: result.created, episode: episodeResponse(result.episode) }
      : { status: result.status }
  })
}
