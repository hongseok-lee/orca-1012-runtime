import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { withDurableTransaction, DurableDatabaseError } from '../db/connection.ts'
import { lockUnitMembers } from '../lifecycle/locks.ts'
import { requestObservationLoss, recordObservationLoss } from './loss.ts'
import { acceptFreshObservation } from './recovery.ts'
import { reserveObservationFence } from './fence.ts'
import { listDueObservationEpisodes } from './due.ts'
import { recordObservationFenceBlocked } from './blocked.ts'
import type { CurrentObservationPin, PreparedFreshObservation } from './types.ts'
import type { Incarnation } from '../runtime/runtime-evidence.ts'
import { ownPool, fixture, episode, challenge, response, readEpisode, fenceRequest, businessState } from './verification-fixtures.mts'

const enabled = /^orca_p115_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')
function failure(code: string) { return (error: unknown) => error instanceof DurableDatabaseError && error.code === code }
function committed(outcome: Awaited<ReturnType<typeof reserveObservationFence>>) {
  assert.notEqual(outcome.status, 'UNCERTAIN')
  if (outcome.status === 'UNCERTAIN') { throw new Error('Unexpected uncertain fixture COMMIT') }
  return outcome.receipt.response as Record<string, unknown>
}

test('concurrent/repeated loss retains one PG first time +6h and receipt replay preserves the original result', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool)
    const request = { authority: f.authority, operationKey: randomUUID(), target: f.target,
      source: { kind: 'TRUSTED_RUNTIME' as const, reference: 'fixture-loss-reference', stream: f.stream,
        watermark: counter('sequence:observation', '4') } }
    const results = await Promise.all([requestObservationLoss(pool, request), requestObservationLoss(pool, { ...request, operationKey: randomUUID() })])
    assert.ok(results.every(x => x.status === 'COMMITTED'))
    const rows = await pool.query(`SELECT *,deadline_at-started_at=interval '6 hours' AS six_hours
      FROM durable_runtime.observation_episodes WHERE runtime_unit_id=$1`, [f.unit])
    assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].six_hours, true)
    await requestObservationLoss(pool, { ...request, operationKey: randomUUID() })
    assert.deepEqual(await readEpisode(pool, rows.rows[0].id), rows.rows[0].six_hours === true ?
      Object.fromEntries(Object.entries(rows.rows[0]).filter(([key]) => key !== 'six_hours')) : null)
    assert.equal((await requestObservationLoss(pool, request)).status, 'REPLAYED')
  } finally { await pool.end() }
})

for (const state of ['IDLE', 'WAITING_INPUT'] as const) {
  test(`5h59m fresh ${state} resolves original episode without changing work/idle/desired/readiness`, { skip: !enabled }, async () => {
    const pool = ownPool()
    try {
      const f = await fixture(pool), initial = await episode(pool, f, '5 hours 59 minutes')
      const c = await challenge(pool, f, initial), before = await businessState(pool, f)
      assert.equal(committed(await acceptFreshObservation(pool, await response(pool, f, c, state))).disposition, 'RESOLVED')
      assert.deepEqual(await businessState(pool, f), before)
      const row = await readEpisode(pool, initial.id)
      assert.equal(row.state, 'RESOLVED'); assert.deepEqual(row.deadline_at, initial.deadline_at)
      assert.equal((await pool.query('SELECT observation_lost_at FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows[0].observation_lost_at, null)
      assert.equal(committed(await reserveObservationFence(pool, fenceRequest(f, c.episode))).disposition, 'NO_RESERVATION')
    } finally { await pool.end() }
  })
}

test('same producer UUID but another persisted incarnation cannot recover with a higher watermark', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool), initial = await episode(pool, f, '5 hours 59 minutes'), c = await challenge(pool, f, initial)
    await pool.query(`INSERT INTO durable_runtime.runtime_event_producers
      (producer_id,incarnation,agent_id,runtime_unit_id,attempt_id,pod_uid,execution_epoch)
      SELECT producer_id,'fixture-other-incarnation',agent_id,runtime_unit_id,attempt_id,pod_uid,execution_epoch
      FROM durable_runtime.runtime_event_producers WHERE producer_id=$1 AND incarnation=$2`, [f.stream.producerId, f.stream.incarnation])
    const request = await response(pool, f, c)
    const prepared = Object.freeze({ ...request.prepared,
      workload: Object.freeze({ ...request.prepared.workload, incarnation: 'fixture-other-incarnation' as Incarnation }),
      stream: Object.freeze({ producerId: f.stream.producerId, incarnation: 'fixture-other-incarnation' as Incarnation }),
      watermark: counter('sequence:observation', '999999') }) as PreparedFreshObservation
    await assert.rejects(acceptFreshObservation(pool, { ...request, prepared }), failure('OBSERVATION_RESPONSE_STREAM'))
    assert.equal((await readEpisode(pool, initial.id)).state, 'OPEN')
  } finally { await pool.end() }
})

test('superseded challenge and past response remain history and cannot resolve the current request', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool), initial = await episode(pool, f, '5 hours 59 minutes'), first = await challenge(pool, f, initial)
    const request = await response(pool, f, first), next = await challenge(pool, f, first.episode, first.row.id)
    // Both challenge events leave the Unit at revision 0. Their canonical
    // event identities must coexist under the real audit UNIQUE/positive guard.
    const records = await pool.query(`SELECT a.producer_id,a.producer_seq,o.id AS event_id,o.revision
      FROM durable_runtime.runtime_audit_events a JOIN durable_runtime.outbox_events o
      ON o.id::text=a.next_state->>'eventId'
      WHERE a.runtime_unit_id=$1 AND a.kind='OBSERVATION_CHALLENGE_ISSUED'`, [f.unit])
    assert.equal(records.rowCount, 2)
    assert.equal(new Set(records.rows.map(row => row.producer_id)).size, 2)
    for (const record of records.rows) {
      assert.equal(record.producer_id, record.event_id)
      assert.equal(record.producer_seq, '1'); assert.equal(record.revision, '0')
    }
    assert.equal((await pool.query('SELECT revision FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows[0].revision, '0')
    assert.equal(committed(await acceptFreshObservation(pool, request)).disposition, 'HISTORY_ONLY')
    const current = await response(pool, f, next)
    await assert.rejects(acceptFreshObservation(pool, { ...current, prepared: Object.freeze({ ...current.prepared,
      observedAt: new Date(first.row.issued_at.getTime() - 1) }) as PreparedFreshObservation }), failure('OBSERVATION_RESPONSE_OLD'))
    assert.equal((await readEpisode(pool, initial.id)).state, 'OPEN')
    assert.deepEqual((await readEpisode(pool, initial.id)).deadline_at, initial.deadline_at)
  } finally { await pool.end() }
})

test('pin invalidated during real Unit lock wait is rejected at accepting SQL with no recovery writes', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool), initial = await episode(pool, f, '5 hours 59 minutes'), c = await challenge(pool, f, initial)
    let current = true
    const request = { ...await response(pool, f, c), pin: { isCurrent: () => current } as CurrentObservationPin }
    let release!: () => void, locked!: () => void
    const ready = new Promise<void>(resolve => { locked = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const holding = withDurableTransaction(pool, async tx => { await lockUnitMembers(tx, f.unit, f.sessions); locked(); await gate })
    await ready
    const accepting = acceptFreshObservation(pool, request)
    // Snapshot happens synchronously before this call returns its pending promise.
    current = false; release(); await holding
    await assert.rejects(accepting, failure('OBSERVATION_PIN_STALE'))
    assert.equal((await readEpisode(pool, initial.id)).state, 'OPEN')
    assert.equal((await pool.query('SELECT consumed_at FROM durable_runtime.observation_challenges WHERE id=$1', [c.row.id])).rows[0].consumed_at, null)
  } finally { await pool.end() }
})

test('fresh first at an expired deadline wins; old timer is a no-op', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool), initial = await episode(pool, f, '6 hours 1 minute'), c = await challenge(pool, f, initial)
    await acceptFreshObservation(pool, await response(pool, f, c))
    assert.equal(committed(await reserveObservationFence(pool, fenceRequest(f, c.episode))).disposition, 'NO_RESERVATION')
    assert.equal((await pool.query('SELECT id FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])).rowCount, 0)
  } finally { await pool.end() }
})

test('fence first serializes fresh to history; repeated and new Active requests preserve original operation/name/deadline', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool), initial = await episode(pool, f, '6 hours 1 minute'), c = await challenge(pool, f, initial)
    const fresh = await response(pool, f, c), request = fenceRequest(f, c.episode)
    const first = committed(await reserveObservationFence(pool, request))
    assert.equal(first.disposition, 'RESERVED')
    assert.equal(committed(await acceptFreshObservation(pool, fresh)).disposition, 'HISTORY_ONLY')
    const before = (await pool.query('SELECT * FROM durable_runtime.operations WHERE id=$1', [first.operationId])).rows[0]
    const adopted = committed(await reserveObservationFence(pool, { ...request, authority: { ...f.authority, principalId: 'fixture-new-active' }, operationKey: randomUUID() }))
    assert.equal(adopted.operationId, first.operationId)
    assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.operations WHERE id=$1', [first.operationId])).rows[0], before)
    assert.equal((await readEpisode(pool, initial.id)).state, 'FENCING')
    assert.equal((await businessState(pool, f)).desired_mode, 'RUNNING')
    assert.equal((await pool.query('SELECT id FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1', [f.unit])).rowCount, 0)
  } finally { await pool.end() }
})

test('due read does not fence ordinary long work or a before-deadline episode', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool), g = await fixture(pool)
    await pool.query("UPDATE durable_runtime.runtime_units SET last_work_event_at=clock_timestamp()-interval '7 hours' WHERE id=$1", [f.unit])
    const initial = await episode(pool, g, '5 hours 59 minutes'), before = await businessState(pool, f)
    assert.equal((await listDueObservationEpisodes(pool)).filter(x => x.runtime_unit_id === f.unit || x.runtime_unit_id === g.unit).length, 0)
    assert.equal(committed(await reserveObservationFence(pool, fenceRequest(g, initial))).disposition, 'NO_RESERVATION')
    assert.deepEqual(await businessState(pool, f), before)
    assert.equal((await pool.query('SELECT id FROM durable_runtime.operations WHERE runtime_unit_id=ANY($1::uuid[])', [[f.unit, g.unit]])).rowCount, 0)
  } finally { await pool.end() }
})

test('same failure source yields one canonical BLOCKED event and no new writer or physical stop', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool), initial = await episode(pool, f, '6 hours 1 minute')
    const reserved = committed(await reserveObservationFence(pool, fenceRequest(f, initial))), row = await readEpisode(pool, initial.id)
    const request = { authority: f.authority, operationKey: randomUUID(), target: f.target, episodeId: row.id,
      expectedEpisodeRevision: row.revision, fenceOperationId: row.fence_operation_id!,
      reason: 'FIXTURE_FENCE_UNKNOWN', failureSourceRef: 'fixture-fence-failure-reference' }
    const first = committed(await recordObservationFenceBlocked(pool, request))
    const second = committed(await recordObservationFenceBlocked(pool, { ...request, operationKey: randomUUID() }))
    assert.equal(first.sourceEventId, second.sourceEventId); assert.equal(first.operationId, reserved.operationId)
    assert.equal((await pool.query("SELECT id FROM durable_runtime.outbox_events WHERE aggregate_id=$1 AND event->>'kind'='OBSERVATION_FENCE_BLOCKED'", [f.unit])).rowCount, 1)
    assert.equal((await pool.query('SELECT stopped_at FROM durable_runtime.attempts WHERE id=$1', [f.target.attemptId])).rows[0].stopped_at, null)
    assert.equal((await pool.query('SELECT id FROM durable_runtime.storage_write_grants WHERE attempt_id=$1', [f.target.attemptId])).rowCount, 0)
    assert.equal((await readEpisode(pool, initial.id)).state, 'BLOCKED')
  } finally { await pool.end() }
})

test('actual SQL failure rolls back new episode, loss timestamp, audit and outbox in the same transaction', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool)
    await assert.rejects(withDurableTransaction(pool, async tx => {
      await lockUnitMembers(tx, f.unit, f.sessions)
      await recordObservationLoss(tx, { actorId: 'fixture-observation', target: f.target,
        source: { kind: 'K8S_LIST', reference: 'fixture-list-failure', stream: null, watermark: null } })
      await tx.query('SELECT 1/0')
    }))
    for (const relation of ['observation_episodes', 'runtime_audit_events']) {
      assert.equal((await pool.query(`SELECT id FROM durable_runtime.${relation} WHERE runtime_unit_id=$1`, [f.unit])).rowCount, 0)
    }
    assert.equal((await pool.query('SELECT id FROM durable_runtime.outbox_events WHERE aggregate_id=$1', [f.unit])).rowCount, 0)
    assert.equal((await pool.query('SELECT observation_lost_at FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows[0].observation_lost_at, null)
  } finally { await pool.end() }
})

test('concurrent fresh and expired fence serialize to exactly one winning transition', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool), initial = await episode(pool, f, '6 hours 1 minute'), c = await challenge(pool, f, initial)
    const fresh = await response(pool, f, c)
    const results = await Promise.all([acceptFreshObservation(pool, fresh), reserveObservationFence(pool, fenceRequest(f, c.episode))])
    const row = await readEpisode(pool, initial.id), operations = await pool.query('SELECT id FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])
    assert.ok(results.every(x => x.status === 'COMMITTED'))
    if (row.state === 'RESOLVED') {
      assert.equal(operations.rowCount, 0)
    } else {
      assert.equal(row.state, 'FENCING'); assert.equal(operations.rowCount, 1)
      assert.equal(committed(results[0]).disposition, 'HISTORY_ONLY')
    }
  } finally { await pool.end() }
})

test('wrong UID or epoch cannot consume the original challenge or clear loss', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool), initial = await episode(pool, f, '5 hours 59 minutes'), c = await challenge(pool, f, initial)
    for (const target of [Object.freeze({ ...f.target, podUid: 'fixture-wrong-pod' }),
      Object.freeze({ ...f.target, executionEpoch: counter('execution-epoch', '1') })]) {
      const original = await response(pool, f, c)
      const prepared = Object.freeze({ ...original.prepared, target,
        workload: Object.freeze({ ...original.prepared.workload, podUid: target.podUid, executionEpoch: target.executionEpoch }) }) as PreparedFreshObservation
      await assert.rejects(acceptFreshObservation(pool, { ...original, prepared }), failure('OBSERVATION_TARGET_STALE'))
    }
    assert.equal((await readEpisode(pool, initial.id)).state, 'OPEN')
    assert.equal((await pool.query('SELECT consumed_at FROM durable_runtime.observation_challenges WHERE id=$1', [c.row.id])).rows[0].consumed_at, null)
  } finally { await pool.end() }
})

test('old expired timer and repeated original loss do not affect a new active attempt or reuse its old loss time', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool), original = await episode(pool, f, '6 hours 1 minute')
    const nextAttempt = logicalId('attempt', randomUUID()), nextPod = `fixture-new-pod-${nextAttempt}`
    await withDurableTransaction(pool, async tx => {
      await lockUnitMembers(tx, f.unit, f.sessions)
      await tx.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,
        resource_profile_revision,effective_resources,status) VALUES($1,$2,1,'COLD',$3,'fixture-new-incarnation',0,'{}','RUNNING')`,
        [nextAttempt, f.unit, nextPod])
      await tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2,execution_epoch=1 WHERE id=$1', [f.unit, nextAttempt])
    })
    const before = await businessState(pool, f)
    assert.equal(committed(await reserveObservationFence(pool, fenceRequest(f, original))).reason, 'STALE_TARGET')
    await requestObservationLoss(pool, { authority: f.authority, operationKey: randomUUID(), target: f.target,
      source: { kind: 'K8S_LIST', reference: 'fixture-old-list-failure', stream: null, watermark: null } })
    assert.deepEqual(await businessState(pool, f), before)
    const nextTarget = { ...f.target, attemptId: nextAttempt, podUid: nextPod as typeof f.target.podUid,
      executionEpoch: counter('execution-epoch', '1') }
    await requestObservationLoss(pool, { authority: f.authority, operationKey: randomUUID(), target: nextTarget,
      source: { kind: 'K8S_WATCH', reference: 'fixture-new-watch-failure', stream: null, watermark: null } })
    const next = (await pool.query('SELECT * FROM durable_runtime.observation_episodes WHERE attempt_id=$1', [nextAttempt])).rows[0]
    assert.ok(next.started_at > original.started_at)
    assert.equal(next.start_producer_id, null); assert.equal(next.start_producer_incarnation, null); assert.equal(next.start_watermark, null)
    assert.deepEqual((await pool.query('SELECT observation_lost_at FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows[0].observation_lost_at, next.started_at)
    assert.equal((await pool.query('SELECT id FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])).rowCount, 0)
  } finally { await pool.end() }
})
