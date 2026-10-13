import type { Pool } from 'pg'
import type { ObservationChallengeRow, ObservationEpisodeRow } from '../db/rows.ts'
import type { JsonValue, MutationOutcome } from '../db/atomic.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { mutateEpisode } from './mutation.ts'
import { snapshotEpisodeRequest, episodeReceipt } from './request.ts'
import { snapshotObservationSource } from './snapshot.ts'
import { assertCurrentObservationTarget, assertObservationProducerBinding } from './target.ts'
import { readOriginalEpisode, episodeResponse, recordObservationEvent } from './store.ts'
import type { IssueObservationChallengeRequest } from './types.ts'

export function challengeResponse(row: ObservationChallengeRow): JsonValue {
  return { challengeId: row.id, episodeId: row.episode_id, runtimeUnitId: row.runtime_unit_id,
    attemptId: row.attempt_id, podUid: row.pod_uid, executionEpoch: row.execution_epoch,
    issuedAt: row.issued_at.toISOString(), requestSourceRef: row.request_source_ref,
    producerId: row.expected_producer_id, producerIncarnation: row.expected_producer_incarnation,
    watermark: row.expected_watermark }
}
export async function issueObservationChallenge(pool: Pool, caller: IssueObservationChallengeRequest): Promise<MutationOutcome> {
  const values = snapshotEpisodeRequest(caller)
  const source = snapshotObservationSource({ kind: 'TRUSTED_RUNTIME', reference: values.requestSourceRef,
    stream: values.expectedStream, watermark: values.expectedWatermark })
  const request = Object.freeze({ ...values, expectedStream: source.stream, expectedWatermark: source.watermark })
  if (typeof request.challengeId !== 'string' || !request.challengeId ||
      (request.supersedeChallengeId !== null && (typeof request.supersedeChallengeId !== 'string' ||
      !request.supersedeChallengeId || request.supersedeChallengeId === request.challengeId))) {
    throw new DurableDatabaseError('OBSERVATION_CHALLENGE_INPUT')
  }
  const identity = episodeReceipt(request, 'observation.issue-challenge', { target: request.target,
    episodeId: request.episodeId, expectedEpisodeRevision: request.expectedEpisodeRevision,
    challengeId: request.challengeId, requestSourceRef: request.requestSourceRef,
    expectedStream: request.expectedStream, expectedWatermark: request.expectedWatermark,
    supersedeChallengeId: request.supersedeChallengeId })
  return mutateEpisode(pool, request.target.runtimeUnitId, identity, async tx => {
    const unit = await assertCurrentObservationTarget(tx, request.target)
    let episode = await readOriginalEpisode(tx, request.episodeId, request.target)
    if (episode.state !== 'OPEN') { return { disposition: 'HISTORY_ONLY', episode: episodeResponse(episode) } }
    if (episode.revision !== request.expectedEpisodeRevision) { throw new DurableDatabaseError('OBSERVATION_EPISODE_REVISION') }
    if (request.expectedStream !== null) { await assertObservationProducerBinding(tx, request.target, request.expectedStream) }
    const existing = (await tx.query<ObservationChallengeRow>(
      'SELECT * FROM durable_runtime.observation_challenges WHERE id=$1', [request.challengeId])).rows[0]
    if (existing) {
      if (existing.episode_id !== episode.id || existing.runtime_unit_id !== request.target.runtimeUnitId ||
          existing.attempt_id !== request.target.attemptId || existing.pod_uid !== request.target.podUid ||
          existing.execution_epoch !== request.target.executionEpoch || existing.request_source_ref !== request.requestSourceRef ||
          existing.expected_producer_id !== (request.expectedStream?.producerId ?? null) ||
          existing.expected_producer_incarnation !== (request.expectedStream?.incarnation ?? null) ||
          existing.expected_watermark !== request.expectedWatermark) { throw new DurableDatabaseError('OBSERVATION_CHALLENGE_CONFLICT') }
      return { disposition: existing.consumed_at || existing.superseded_at ? 'HISTORY_ONLY' : 'PENDING',
        episode: episodeResponse(episode), challenge: challengeResponse(existing) }
    }
    const pending = (await tx.query<ObservationChallengeRow>(`SELECT * FROM durable_runtime.observation_challenges
      WHERE episode_id=$1 AND consumed_at IS NULL AND superseded_at IS NULL`, [episode.id])).rows[0]
    if ((pending?.id ?? null) !== request.supersedeChallengeId) { throw new DurableDatabaseError('OBSERVATION_CHALLENGE_SUPERSEDE') }
    if (pending) {
      await tx.query(`UPDATE durable_runtime.observation_challenges SET superseded_at=clock_timestamp(),superseded_by=$2
        WHERE id=$1 AND consumed_at IS NULL AND superseded_at IS NULL`, [pending.id, request.challengeId])
    }
    const challenge = (await tx.query<ObservationChallengeRow>(`INSERT INTO durable_runtime.observation_challenges
      (id,episode_id,runtime_unit_id,attempt_id,pod_uid,execution_epoch,request_source_ref,
       expected_producer_id,expected_producer_incarnation,expected_watermark)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [request.challengeId, episode.id, request.target.runtimeUnitId, request.target.attemptId, request.target.podUid,
      request.target.executionEpoch, request.requestSourceRef, request.expectedStream?.producerId ?? null,
      request.expectedStream?.incarnation ?? null, request.expectedWatermark])).rows[0]
    episode = (await tx.query<ObservationEpisodeRow>(`UPDATE durable_runtime.observation_episodes SET revision=revision+1
      WHERE id=$1 AND revision=$2 AND state='OPEN' RETURNING *`, [episode.id, episode.revision])).rows[0]
    if (!episode) { throw new DurableDatabaseError('OBSERVATION_EPISODE_REVISION') }
    await recordObservationEvent(tx, { actorId: request.authority.principalId, target: request.target,
      episode, unitRevision: unit.revision, kind: 'OBSERVATION_CHALLENGE_ISSUED',
      event: { challenge: challengeResponse(challenge), supersededChallengeId: pending?.id ?? null }, sourceRefs: [request.requestSourceRef] })
    // Only committed/replayed outcome carries an authoritative receipt. No I/O here.
    return { disposition: 'PENDING', episode: episodeResponse(episode), challenge: challengeResponse(challenge) }
  })
}
