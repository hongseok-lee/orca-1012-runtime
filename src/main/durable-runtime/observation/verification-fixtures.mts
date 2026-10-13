import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { ObservationEpisodeRow, ObservationChallengeRow } from '../db/rows.ts'
import type { Incarnation, PodUid, RuntimeReference, VerifiedWorkloadIdentity } from '../runtime/runtime-evidence.ts'
import { fixture as memberFixture, stoppedMetadataAttempt } from '../lifecycle/verification-fixtures.mts'
import { lockUnitMembers } from '../lifecycle/locks.ts'
import { issueObservationChallenge } from './challenge.ts'
import type { ObservationAuthority, ObservationTarget, PreparedFreshObservation, CurrentObservationPin } from './types.ts'

// Only synthetic authenticated transport values in an isolated owned PG fixture.
// These casts cannot qualify actual Agent/provider, physical fence or HA proof.
export function ownPool(): Pool {
  const database = process.env.PGDATABASE ?? ''
  if (!/^orca_p115_[a-z0-9_]+$/.test(database)) { throw new Error('P115 owned verification database required') }
  return createDurablePool({ database })
}
export async function fixture(pool: Pool) {
  const members = await memberFixture(pool), attempt = await stoppedMetadataAttempt(pool, members, true)
  const target: ObservationTarget = { runtimeUnitId: members.unit, attemptId: attempt.attempt,
    podUid: attempt.podUid as PodUid, executionEpoch: counter('execution-epoch', '0') }
  const producerId = logicalId('producer', randomUUID()), incarnation = 'fixture-observation-incarnation' as Incarnation
  await pool.query(`INSERT INTO durable_runtime.runtime_event_producers
    (producer_id,incarnation,agent_id,runtime_unit_id,attempt_id,pod_uid,execution_epoch)
    SELECT $1,$2,s.agent_id,$3,$4,$5,$6 FROM durable_runtime.sessions s WHERE s.id=$7`,
    [producerId, incarnation, members.unit, target.attemptId, target.podUid, target.executionEpoch, members.sessions[0]])
  await pool.query(`UPDATE durable_runtime.runtime_units SET phase='READY',last_work_event_at=clock_timestamp()-interval '1 hour',
    idle_due_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [members.unit])
  const authority = { principalId: 'fixture-observation', scope: `fixture-unit:${members.unit}` } as ObservationAuthority
  const workload = { attemptId: target.attemptId, podUid: target.podUid, executionEpoch: target.executionEpoch,
    producerId, incarnation, principalRef: 'fixture-runtime-principal' as RuntimeReference<'workload-principal'>,
    authenticationEvidenceRef: 'fixture-authentication-reference' as RuntimeReference<'evidence-ref'> } as VerifiedWorkloadIdentity
  return { ...members, target, authority, workload, stream: { producerId, incarnation } }
}
export type Fixture = Awaited<ReturnType<typeof fixture>>
export async function episode(pool: Pool, f: Fixture, age: '5 hours 59 minutes' | '6 hours 1 minute', sourceStream = true): Promise<ObservationEpisodeRow> {
  // Initial INSERT only: real DB clock minus a fixture age. Immutable guards stay
  // enabled and production clocks/timers are neither advanced nor replaced.
  return withDurableTransaction(pool, async tx => {
    await lockUnitMembers(tx, f.unit, f.sessions)
    const row = (await tx.query<ObservationEpisodeRow>(`INSERT INTO durable_runtime.observation_episodes
      (id,runtime_unit_id,attempt_id,pod_uid,execution_epoch,started_at,start_source_ref,
       start_producer_id,start_producer_incarnation,start_watermark)
      VALUES($1,$2,$3,$4,$5,clock_timestamp()-$6::interval,'fixture-initial-loss',$7,$8,$9) RETURNING *`,
      [logicalId('observation-episode', randomUUID()), f.unit, f.target.attemptId, f.target.podUid, f.target.executionEpoch,
      age, sourceStream ? f.stream.producerId : null, sourceStream ? f.stream.incarnation : null, sourceStream ? '4' : null])).rows[0]
    await tx.query('UPDATE durable_runtime.runtime_units SET observation_lost_at=$2 WHERE id=$1', [f.unit, row.started_at])
    return row
  })
}
export async function challenge(pool: Pool, f: Fixture, row: ObservationEpisodeRow, old: string | null = null) {
  const challengeId = `fixture-challenge-${randomUUID()}`
  const request = { authority: f.authority, operationKey: randomUUID(), target: f.target, episodeId: row.id,
    expectedEpisodeRevision: row.revision, challengeId, requestSourceRef: `fixture-request:${challengeId}`,
    expectedStream: f.stream, expectedWatermark: counter('sequence:observation', '4'), supersedeChallengeId: old }
  const mutation = await issueObservationChallenge(pool, request)
  if (mutation.status === 'UNCERTAIN') { throw new Error('Unexpected uncertain fixture challenge COMMIT') }
  return { request, episode: await readEpisode(pool, row.id), row: (await pool.query<ObservationChallengeRow>(
    'SELECT * FROM durable_runtime.observation_challenges WHERE id=$1', [challengeId])).rows[0] }
}
export async function readEpisode(pool: Pool, id: string): Promise<ObservationEpisodeRow> {
  return (await pool.query<ObservationEpisodeRow>('SELECT * FROM durable_runtime.observation_episodes WHERE id=$1', [id])).rows[0]
}
export async function response(pool: Pool, f: Fixture, c: Awaited<ReturnType<typeof challenge>>, state: PreparedFreshObservation['state'] = 'IDLE') {
  const now = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now
  const prepared = Object.freeze({ target: Object.freeze({ ...f.target }), workload: Object.freeze({ ...f.workload }),
    episodeId: c.episode.id, expectedEpisodeRevision: c.episode.revision, challengeId: c.row.id,
    requestSourceRef: c.row.request_source_ref, responseSourceRef: `fixture-response:${randomUUID()}`, state, observedAt: now,
    stream: Object.freeze({ ...f.stream }), watermark: counter('sequence:observation', '5'), body: { fixture: 'current-request-response' } }) as PreparedFreshObservation
  return { authority: f.authority, operationKey: randomUUID(), prepared,
    pin: { isCurrent: () => true } as CurrentObservationPin }
}
export function fenceRequest(f: Fixture, row: ObservationEpisodeRow) {
  return { authority: f.authority, operationKey: randomUUID(), target: f.target, episodeId: row.id,
    expectedEpisodeRevision: row.revision, policy: { revisionRef: 'fixture-policy-v1', operationDeadlineMs: 60000 } }
}
export async function businessState(pool: Pool, f: Fixture) {
  return (await pool.query(`SELECT desired_mode,phase,execution_epoch,active_attempt_id,last_work_event_at,idle_due_at
    FROM durable_runtime.runtime_units WHERE id=$1`, [f.unit])).rows[0]
}
