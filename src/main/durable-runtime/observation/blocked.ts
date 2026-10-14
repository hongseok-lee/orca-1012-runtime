import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { ObservationEpisodeRow, RuntimeUnitRow } from '../db/rows.ts'
import type { JsonValue, MutationOutcome } from '../db/atomic.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { LifecycleOperation } from '../lifecycle/types.ts'
import { mutateEpisode } from './mutation.ts'
import { episodeReceipt, snapshotEpisodeRequest } from './request.ts'
import { readOriginalEpisode, episodeResponse, recordObservationEvent } from './store.ts'
import { assertCurrentObservationTarget } from './target.ts'
import type { ObservationFenceBlockedRequest } from './types.ts'

// Explicit authorized failure evidence is retained as provenance, never promoted
// to physical-stop proof. This entry neither calls P125 nor issues its authority.
export async function recordObservationFenceBlocked(pool: Pool, caller: ObservationFenceBlockedRequest): Promise<MutationOutcome> {
  const request = snapshotEpisodeRequest(caller)
  logicalId('operation', request.fenceOperationId)
  if (typeof request.reason !== 'string' || !request.reason ||
      typeof request.failureSourceRef !== 'string' || !request.failureSourceRef) {
    throw new DurableDatabaseError('OBSERVATION_BLOCKED_EVIDENCE')
  }
  const identity = episodeReceipt(request, 'observation.fence-blocked', { target: request.target,
    episodeId: request.episodeId, expectedEpisodeRevision: request.expectedEpisodeRevision,
    fenceOperationId: request.fenceOperationId, reason: request.reason, failureSourceRef: request.failureSourceRef })
  return mutateEpisode(pool, request.target.runtimeUnitId, identity, async tx => {
    let episode = await readOriginalEpisode(tx, request.episodeId, request.target)
    if (episode.fence_operation_id !== request.fenceOperationId || !['FENCING', 'BLOCKED'].includes(episode.state)) {
      throw new DurableDatabaseError('OBSERVATION_FENCE_OPERATION')
    }
    const operation = (await tx.query<LifecycleOperation>(`SELECT * FROM durable_runtime.operations
      WHERE id=$1 AND runtime_unit_id=$2 AND kind='OBSERVATION_FENCE' AND expected_pod_uid=$3 AND execution_epoch=$4`,
      [request.fenceOperationId, request.target.runtimeUnitId, request.target.podUid, request.target.executionEpoch])).rows[0]
    if (!operation) { throw new DurableDatabaseError('OBSERVATION_FENCE_OPERATION') }
    const existing = (await tx.query<{ id: string; event: JsonValue; matches: boolean }>(`SELECT id,event,
      (event->'detail'->>'reasonCode'=$4) AS matches FROM durable_runtime.outbox_events
      WHERE aggregate_id=$1 AND event->>'kind'='OBSERVATION_FENCE_BLOCKED'
      AND event->>'episodeId'=$2 AND event->>'operationId'=$3 AND event->'detail'->>'failureSourceRef'=$5`,
      [request.target.runtimeUnitId, episode.id, operation.id, request.reason, request.failureSourceRef])).rows[0]
    if (existing) {
      if (!existing.matches) { throw new DurableDatabaseError('OBSERVATION_BLOCKED_EVIDENCE_CONFLICT') }
      return { disposition: 'ORIGINAL_BLOCKED', episode: episodeResponse(episode), sourceEventId: existing.id,
        incidentKey: `observation-fence:${episode.id}`, operationId: operation.id }
    }
    if (episode.revision !== request.expectedEpisodeRevision) { throw new DurableDatabaseError('OBSERVATION_EPISODE_REVISION') }
    const unit = await assertCurrentObservationTarget(tx, request.target)
    episode = (await tx.query<ObservationEpisodeRow>(`UPDATE durable_runtime.observation_episodes SET state='BLOCKED',reason=$3,
      revision=revision+1 WHERE id=$1 AND revision=$2 AND state IN ('FENCING','BLOCKED') AND fence_operation_id=$4 RETURNING *`,
      [episode.id, episode.revision, request.reason, operation.id])).rows[0]
    if (!episode) { throw new DurableDatabaseError('OBSERVATION_EPISODE_REVISION') }
    const blocked = (await tx.query<RuntimeUnitRow>(`UPDATE durable_runtime.runtime_units SET phase='BLOCKED',revision=revision+1
      WHERE id=$1 AND revision=$2 RETURNING *`, [unit.id, unit.revision])).rows[0]
    if (!blocked) { throw new DurableDatabaseError('OBSERVATION_TARGET_STALE') }
    const sourceEventId = await recordObservationEvent(tx, { actorId: request.authority.principalId, target: request.target,
      episode, operationId: operation.id, unitRevision: blocked.revision, kind: 'OBSERVATION_FENCE_BLOCKED',
      event: { reasonCode: request.reason, failureSourceRef: request.failureSourceRef,
        incidentKey: `observation-fence:${episode.id}`, targetRef: { runtimeUnitId: unit.id, operationId: operation.id },
        actionRef: operation.id, physicalFenceVerified: false }, sourceRefs: [request.failureSourceRef, episode.start_source_ref] })
    return { disposition: 'BLOCKED', episode: episodeResponse(episode), sourceEventId,
      incidentKey: `observation-fence:${episode.id}`, operationId: operation.id }
  })
}
