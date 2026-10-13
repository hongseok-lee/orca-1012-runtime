import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { ObservationEpisodeRow, RuntimeUnitRow } from '../db/rows.ts'
import type { JsonValue, MutationOutcome } from '../db/atomic.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { initializeLifecycleScope, LIFECYCLE_CONTROLLER_SCOPE } from '../lifecycle/intent.ts'
import type { LifecycleOperation } from '../lifecycle/types.ts'
import { episodeReceipt, snapshotEpisodeRequest } from './request.ts'
import { mutateEpisode } from './mutation.ts'
import { readOriginalEpisode, episodeResponse, recordObservationEvent } from './store.ts'
import { assertCurrentObservationTarget } from './target.ts'
import type { ReserveObservationFenceRequest } from './types.ts'

export async function reserveObservationFence(pool: Pool, caller: ReserveObservationFenceRequest): Promise<MutationOutcome> {
  const values = snapshotEpisodeRequest(caller)
  const policy = Object.freeze({ revisionRef: caller.policy.revisionRef, operationDeadlineMs: caller.policy.operationDeadlineMs })
  if (typeof policy.revisionRef !== 'string' || !policy.revisionRef || !Number.isSafeInteger(policy.operationDeadlineMs) ||
      policy.operationDeadlineMs < 1) { throw new DurableDatabaseError('OBSERVATION_FENCE_POLICY') }
  const request = Object.freeze({ ...values, policy })
  const identity = episodeReceipt(request, 'observation.reserve-fence', { target: request.target,
    episodeId: request.episodeId, expectedEpisodeRevision: request.expectedEpisodeRevision, policy })
  return mutateEpisode(pool, request.target.runtimeUnitId, identity, async (tx): Promise<JsonValue> => {
    let episode = await readOriginalEpisode(tx, request.episodeId, request.target)
    if (episode.state === 'RESOLVED') { return { disposition: 'NO_RESERVATION', reason: 'RESOLVED', episode: episodeResponse(episode) } }
    if (episode.fence_operation_id !== null) {
      const original = (await tx.query<LifecycleOperation>(`SELECT * FROM durable_runtime.operations WHERE id=$1 AND runtime_unit_id=$2
        AND kind='OBSERVATION_FENCE' AND expected_pod_uid=$3 AND execution_epoch=$4`,
        [episode.fence_operation_id, request.target.runtimeUnitId, request.target.podUid, request.target.executionEpoch])).rows[0]
      if (!original) { throw new DurableDatabaseError('OBSERVATION_FENCE_OPERATION') }
      return { disposition: 'ORIGINAL_RESERVED', episode: episodeResponse(episode), operationId: original.id,
        externalResourceName: original.external_resource_name, operationDeadlineAt: original.deadline_at?.toISOString() ?? null }
    }
    if (episode.revision !== request.expectedEpisodeRevision) { return { disposition: 'NO_RESERVATION', reason: 'STALE_REVISION' } }
    let unit: RuntimeUnitRow
    try { unit = await assertCurrentObservationTarget(tx, request.target) }
    catch (error) {
      if (error instanceof DurableDatabaseError && error.code === 'OBSERVATION_TARGET_STALE') {
        return { disposition: 'NO_RESERVATION', reason: 'STALE_TARGET' }
      }
      throw error
    }
    const due = await tx.query(`SELECT id FROM durable_runtime.observation_episodes WHERE id=$1 AND state='OPEN'
      AND revision=$2 AND deadline_at<=clock_timestamp()`, [episode.id, episode.revision])
    if (due.rowCount !== 1) { return { disposition: 'NO_RESERVATION', reason: 'NOT_DUE' } }
    // Reception observes the existing scope/term; it neither owns a lease nor
    // starts/claims a command. External effects require actual P109/P114 claims.
    await initializeLifecycleScope(tx)
    const operationId = logicalId('operation', randomUUID())
    const operation = (await tx.query<LifecycleOperation>(`INSERT INTO durable_runtime.operations
      (id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,
       execution_epoch,expected_pod_uid,external_resource_name,deadline_at)
      SELECT $1,u.id,'OBSERVATION_FENCE',u.intent_revision,c.scope,c.term,'FENCE_PENDING',
        $3,$4,$5,clock_timestamp()+$6::bigint*interval '1 millisecond'
      FROM durable_runtime.runtime_units u JOIN durable_runtime.controller_leases c ON c.scope=$7 WHERE u.id=$2 RETURNING *`,
      [operationId, unit.id, request.target.executionEpoch, request.target.podUid,
      `orca-observation-${episode.id}`, policy.operationDeadlineMs, LIFECYCLE_CONTROLLER_SCOPE])).rows[0]
    if (!operation) { throw new DurableDatabaseError('OBSERVATION_FENCE_OPERATION') }
    episode = (await tx.query<ObservationEpisodeRow>(`UPDATE durable_runtime.observation_episodes SET state='FENCING',
      fence_operation_id=$3,revision=revision+1 WHERE id=$1 AND revision=$2 AND state='OPEN'
      AND fence_operation_id IS NULL RETURNING *`, [episode.id, episode.revision, operation.id])).rows[0]
    if (!episode) { throw new DurableDatabaseError('OBSERVATION_EPISODE_REVISION') }
    const blocked = (await tx.query<RuntimeUnitRow>(`UPDATE durable_runtime.runtime_units SET phase='BLOCKED',revision=revision+1
      WHERE id=$1 RETURNING *`, [unit.id])).rows[0]
    await recordObservationEvent(tx, { actorId: request.authority.principalId, target: request.target, episode,
      operationId: operation.id, unitRevision: blocked.revision, kind: 'OBSERVATION_FENCE_RESERVED',
      event: { operationId: operation.id, reason: 'OBSERVATION_FENCE_UNVERIFIED', policyRef: policy.revisionRef,
        externalResourceName: operation.external_resource_name, operationDeadlineAt: operation.deadline_at?.toISOString() ?? null },
      sourceRefs: [episode.start_source_ref, policy.revisionRef] })
    return { disposition: 'RESERVED', episode: episodeResponse(episode), operationId: operation.id,
      externalResourceName: operation.external_resource_name, operationDeadlineAt: operation.deadline_at?.toISOString() ?? null }
  })
}
