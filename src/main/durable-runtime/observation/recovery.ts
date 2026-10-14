import type { Pool } from 'pg'
import type { ObservationChallengeRow, ObservationEpisodeRow, RuntimeUnitRow } from '../db/rows.ts'
import type { JsonValue, MutationOutcome } from '../db/atomic.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { snapshotObservationRecovery } from './snapshot.ts'
import { assertCurrentObservationTarget, assertObservationProducerBinding } from './target.ts'
import { mutateEpisode } from './mutation.ts'
import { readOriginalEpisode, recordObservationEvent, episodeResponse } from './store.ts'
import type { ObservationRecoveryRequest, RecoverySnapshot } from './types.ts'

function checkWatermark(value: RecoverySnapshot, id: string | null, incarnation: string | null, watermark: string | null): void {
  if (id === null && incarnation === null && watermark === null) { return }
  if (value.stream === null || value.watermark === null || value.stream.producerId !== id ||
      value.stream.incarnation !== incarnation || watermark === null || BigInt(value.watermark) < BigInt(watermark)) {
    throw new DurableDatabaseError('OBSERVATION_RESPONSE_STREAM')
  }
}
export async function acceptFreshObservation(pool: Pool, caller: ObservationRecoveryRequest): Promise<MutationOutcome> {
  const prepared = snapshotObservationRecovery(caller)
  const { value, identity } = prepared
  return mutateEpisode(pool, value.target.runtimeUnitId, identity, async (tx): Promise<JsonValue> => {
    const unit = await assertCurrentObservationTarget(tx, value.target)
    const episode = await readOriginalEpisode(tx, value.episodeId, value.target)
    const challenge = (await tx.query<ObservationChallengeRow>(`SELECT * FROM durable_runtime.observation_challenges
      WHERE id=$1 AND episode_id=$2 AND runtime_unit_id=$3 AND attempt_id=$4 AND pod_uid=$5 AND execution_epoch=$6`,
      [value.challengeId, episode.id, value.target.runtimeUnitId, value.target.attemptId, value.target.podUid,
      value.target.executionEpoch])).rows[0]
    if (!challenge || challenge.request_source_ref !== value.requestSourceRef) {
      throw new DurableDatabaseError('OBSERVATION_RESPONSE_CHALLENGE')
    }
    if (episode.state !== 'OPEN' || challenge.consumed_at !== null || challenge.superseded_at !== null) {
      await recordObservationEvent(tx, { actorId: identity.key.principalId, target: value.target, episode,
        unitRevision: unit.revision, kind: 'OBSERVATION_RESPONSE_HISTORY',
        event: { challengeId: value.challengeId, state: value.state, disposition: 'HISTORY_ONLY' },
        sourceRefs: [value.requestSourceRef, value.responseSourceRef] })
      return { disposition: 'HISTORY_ONLY', episode: episodeResponse(episode) }
    }
    if (episode.revision !== value.expectedEpisodeRevision) { throw new DurableDatabaseError('OBSERVATION_EPISODE_REVISION') }
    if (new Date(value.observedAtISO).getTime() < challenge.issued_at.getTime()) {
      throw new DurableDatabaseError('OBSERVATION_RESPONSE_OLD')
    }
    // Both persisted barriers retain the exact producer UUID + incarnation.
    // A high sequence from a different incarnation has no ordering meaning.
    checkWatermark(value, episode.start_producer_id, episode.start_producer_incarnation, episode.start_watermark)
    checkWatermark(value, challenge.expected_producer_id, challenge.expected_producer_incarnation, challenge.expected_watermark)
    await assertObservationProducerBinding(tx, value.target, {
      producerId: value.workload.producerId, incarnation: value.workload.incarnation })
    prepared.assertCurrentPin()
    // No await/I/O between synchronous owner recheck and the accepting SQL.
    // This DB clock is the resolution time; Node time never defines the deadline.
    const resolved = (await tx.query<ObservationEpisodeRow>(`WITH clock AS (SELECT clock_timestamp() AS now),
      accepted AS (UPDATE durable_runtime.observation_episodes SET state='RESOLVED',resolved_at=clock.now,revision=revision+1
        FROM clock WHERE id=$1 AND revision=$2 AND state='OPEN' RETURNING observation_episodes.*),
      consumed AS (UPDATE durable_runtime.observation_challenges SET consumed_at=accepted.resolved_at FROM accepted
        WHERE observation_challenges.id=$3 AND observation_challenges.episode_id=accepted.id
        AND consumed_at IS NULL AND superseded_at IS NULL RETURNING observation_challenges.id)
      SELECT accepted.* FROM accepted JOIN consumed ON true`, [episode.id, episode.revision, challenge.id])).rows[0]
    if (!resolved) { throw new DurableDatabaseError('OBSERVATION_EPISODE_REVISION') }
    const updated = (await tx.query<RuntimeUnitRow>(`UPDATE durable_runtime.runtime_units SET observation_lost_at=NULL,revision=revision+1
      WHERE id=$1 AND active_attempt_id=$2 AND execution_epoch=$3 AND observation_lost_at=$4 RETURNING *`,
      [value.target.runtimeUnitId, value.target.attemptId, value.target.executionEpoch, episode.started_at])).rows[0]
    if (!updated) { throw new DurableDatabaseError('OBSERVATION_TARGET_STALE') }
    await recordObservationEvent(tx, { actorId: identity.key.principalId, target: value.target, episode: resolved,
      unitRevision: updated.revision, kind: 'OBSERVATION_RESOLVED', event: { challengeId: challenge.id,
        state: value.state, observedAt: value.observedAtISO, stream: value.stream, watermark: value.watermark,
        response: value.body }, sourceRefs: [value.requestSourceRef, value.responseSourceRef, value.workload.authenticationEvidenceRef] })
    // Does not change readiness, work/idle clocks, desired mode, grant or identity.
    return { disposition: 'RESOLVED', episode: episodeResponse(resolved), state: value.state }
  })
}
