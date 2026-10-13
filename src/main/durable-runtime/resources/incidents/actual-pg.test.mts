import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { logicalId, counter } from '../../../../shared/durable-runtime/identity.ts'
import { createDurablePool, DurableDatabaseError } from '../../db/connection.ts'
import { applyMigrations, readMigrations } from '../../db/migrate.ts'
import { processRuntimeEvent } from '../../events/store.ts'
import { prepareFailureObservation } from '../evidence/normalize.ts'
import type { FailureTarget } from '../evidence/types.ts'
import { ingestFailureEvidence, handleFailureEvidenceEvent, listDueFailureIncidents, expireFailureEvidenceWithReceipt } from './index.ts'
import { fixture, fixtureProof, observation, request, result, unitRow, stateRow, count, errorCode, hookPool, gate, queueClaim, decode } from './test-support.mts'

// First owned incident-module run only. Existing collector/P112/DB suites are
// not imported or executed. Nominal fixture authority is not authentication.
assert.match(process.env.PGDATABASE ?? '', /^orca_p121_[a-z0-9_]+$/)
assert.ok(process.env.P121_MIGRATIONS)
const pool = createDurablePool({ max: 12 })
const cases: { name: string; passed: boolean; errorCode?: string }[] = []
const observations: Record<string, unknown> = {}
let migrations: { version: string; checksum: string }[] = []
before(async () => {
  const files = await readMigrations(process.env.P121_MIGRATIONS!)
  assert.equal(files.length, 15)
  migrations = (await applyMigrations(pool, files)).map(({ version, checksum }) => ({ version, checksum }))
})
after(async () => {
  if (process.env.P121_EVIDENCE) {
    await writeFile(process.env.P121_EVIDENCE, `${JSON.stringify({
      scope: 'ACTUAL_PG_INCIDENT_MODULE_WITH_FIXTURE_EVIDENCE', recordedAt: new Date().toISOString(),
      sourceRevision: process.env.P121_SOURCE_REVISION, verificationBaseRevision: process.env.P121_BASE_REVISION,
      productSourceReviewed: 'dffb4aa434eca28973fb83cbb89ee21242961796',
      evidenceSource: 'f07c504260cf3bd91071c8409b8c3b00c1ee990b', db015Source: '9eaae10abd99f518737b518f09b633b955eae731',
      migrations, cases, observations, collectorAuthenticationVerified: false,
      actualAgentOomVerified: false, physicalIsolationVerified: false, resourceActionExecuted: false,
      providerExecuted: false, physicalHaFencingVerified: false,
      faultScope: '동일 TX의 handler 예외와 실제 receipt INSERT 전 driver hook입니다. 공유 PG/Pod/Node 장애는 주입하지 않습니다.'
    }, null, 2)}\n`, { mode: 0o600 })
  }
  await pool.end()
})
function check(name: string, body: () => Promise<void>): void {
  test(name, { timeout: 120000 }, async () => {
    try { await body(); cases.push({ name, passed: true }) } catch (error) {
      const code = error instanceof DurableDatabaseError ? error.code : 'FIXTURE_ASSERTION_OR_FAILURE'
      cases.push({ name, passed: false, errorCode: code }); throw error
    }
  })
}

check('동시 동일 원 종료는 하나의 incident로 합류하며 원 receipt가 재생된다', async () => {
  const f = await fixture(pool); const a = request(f); const b = request(f)
  const originalUnit = await unitRow(pool, f)
  const [one, two] = await Promise.all([ingestFailureEvidence(pool, a), ingestFailureEvidence(pool, b)])
  assert.equal(result(one).incidentId, result(two).incidentId)
  assert.equal(await count(pool, 'failure_incidents', f), '1')
  assert.equal(await count(pool, 'failure_observations', f), '2')
  const replay = await ingestFailureEvidence(pool, a)
  assert.equal(replay.status, 'REPLAYED'); assert.deepEqual(result(replay), result(one))
  assert.deepEqual(await unitRow(pool, f), originalUnit)
  observations.concurrentCanonicalIncidentCount = 1
})

check('lastState 반복과 같은 원 eviction/OOM은 합류하며 unresolved 원문은 proof로만 연결된다', async () => {
  const f = await fixture(pool); const original = request(f)
  const one = result(await ingestFailureEvidence(pool, original))
  const relist = request(f, observation(f, { evidence: { resourceVersion: 'opaque-relist', fixtureProjection: true } }))
  assert.equal(result(await ingestFailureEvidence(pool, relist)).incidentId, one.incidentId)
  const eviction = request(f, observation(f, { signals: { ...original.observation.signals, oomKilled: false, memoryEviction: true } }))
  assert.equal(result(await ingestFailureEvidence(pool, eviction)).incidentId, one.incidentId)
  const unresolved = request(f, observation(f, { target: { ...f.target, containerName: null, runtimeContainerId: null, incarnation: null },
    termination: null, signals: { ...original.observation.signals, oomKilled: false, memoryEviction: true } }))
  const unknown = result(await ingestFailureEvidence(pool, unresolved))
  assert.equal(unknown.status, 'OBSERVATION_ONLY'); assert.equal(unknown.incidentId, null)
  const rawBefore = (await pool.query('SELECT evidence,container_id,incarnation FROM durable_runtime.failure_observations WHERE id=$1', [unresolved.observation.observationId])).rows[0]
  assert.equal(rawBefore.container_id, null); assert.equal(rawBefore.incarnation, null)
  const resolved = request(f); const prepared = prepareFailureObservation(resolved.observation)
  assert.ok(prepared.canonicalKey)
  const linked = { ...resolved, linkObservations: [{ observationId: unresolved.observation.observationId,
    provenance: { target: { ...f.target }, eventKey: prepared.canonicalKey, sourceRef: unresolved.observation.sourceRef,
      observedAt: '2026-10-13T12:00:00.123456789Z' } }] }
  assert.equal(result(await ingestFailureEvidence(pool, linked)).incidentId, one.incidentId)
  const rawAfter = (await pool.query('SELECT evidence,container_id,incarnation FROM durable_runtime.failure_observations WHERE id=$1', [unresolved.observation.observationId])).rows[0]
  assert.deepEqual(rawAfter, rawBefore)
  assert.equal((await pool.query('SELECT incident_id FROM durable_runtime.failure_incident_observations WHERE observation_id=$1', [unresolved.observation.observationId])).rows[0].incident_id, one.incidentId)
  assert.equal(await count(pool, 'failure_incidents', f), '1')
})

check('다른 container와 새 attempt/incarnation의 종료 identity는 분리된다', async () => {
  const f = await fixture(pool); const one = result(await ingestFailureEvidence(pool, request(f)))
  const other = { ...f, target: { ...f.target, containerName: 'sidecar', runtimeContainerId: `containerd://fixture-${randomUUID()}` } }
  const two = result(await ingestFailureEvidence(pool, request(other)))
  assert.notEqual(one.incidentId, two.incidentId)
  const newAttempt = logicalId('attempt', randomUUID())
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: New fixture original incarnation is installed in its actual owned PG attempt; no authority proof is manufactured.
  const incarnation = `fixture-restart-${randomUUID()}` as FailureTarget['incarnation']
  await pool.query("INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status) VALUES($1,$2,2,'COLD',$3,$4,0,'{}','READY')", [newAttempt, f.target.runtimeUnitId, f.target.podUid, incarnation])
  await pool.query('UPDATE durable_runtime.runtime_units SET execution_epoch=2,active_attempt_id=$2 WHERE id=$1', [f.target.runtimeUnitId, newAttempt])
  const restarted = { ...f, target: { ...f.target, attemptId: newAttempt, executionEpoch: counter('execution-epoch', '2'), incarnation } }
  const three = result(await ingestFailureEvidence(pool, request(restarted)))
  assert.notEqual(three.incidentId, one.incidentId); assert.notEqual(three.incidentId, two.incidentId)
  assert.equal(await count(pool, 'failure_incidents', f), '3')
})

check('source 원문·alias 충돌과 receipt 직전 실패는 전체 rollback하며 첫 await snapshot을 유지한다', async () => {
  const f = await fixture(pool); const initial = request(f)
  await ingestFailureEvidence(pool, initial)
  const conflicting = { ...initial, observation: { ...initial.observation, evidence: { fixtureProjection: true, changed: true } },
    receiptKey: { ...initial.receiptKey, operationKey: randomUUID() } }
  await errorCode(() => ingestFailureEvidence(pool, conflicting), 'INCIDENT_SOURCE_CONFLICT')
  assert.equal(await count(pool, 'failure_observations', f), '1')

  const counterOnly = request(f, observation(f, { termination: null, counterTransition: {
    cgroupIdentity: 'fixture-cgroup', processIdentity: 'fixture-process', incarnation: f.target.incarnation!,
    counter: 'oom_kill', previous: '0', current: '1', previousSampleId: 'sample-before', currentSampleId: 'sample-after' } }))
  await ingestFailureEvidence(pool, counterOnly)
  assert.equal(await count(pool, 'failure_incidents', f), '2')
  const bridge = request(f, observation(f, { counterTransition: counterOnly.observation.counterTransition }))
  await errorCode(() => ingestFailureEvidence(pool, bridge), 'INCIDENT_ALIAS_CONFLICT')
  assert.equal(await count(pool, 'failure_observations', f), '2')

  const rollback = request(f, observation(f, { termination: { ...initial.observation.termination!, finishedAt: '2026-10-13T12:00:09Z' } }))
  const failing = hookPool(pool, async (sql, execute) => {
    if (sql.startsWith('INSERT INTO durable_runtime.rpc_receipts')) { throw new DurableDatabaseError('P121_RECEIPT_FAULT') }
    return execute()
  })
  await errorCode(() => ingestFailureEvidence(failing, rollback), 'P121_RECEIPT_FAULT')
  assert.equal(await count(pool, 'failure_incidents', f), '2'); assert.equal(await count(pool, 'failure_observations', f), '2')
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.runtime_audit_events WHERE next_state->>'observationId'=$1", [rollback.observation.observationId])).rows[0].n, '0')
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.outbox_events WHERE event->'decision'->>'observationId'=$1", [rollback.observation.observationId])).rows[0].n, '0')
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.rpc_receipts WHERE operation_key=$1', [rollback.receiptKey.operationKey])).rows[0].n, '0')

  const date = new Date('2026-10-13T12:00:02Z'); const mutable = request(f, observation(f, { observedAt: date,
    termination: { ...initial.observation.termination!, finishedAt: '2026-10-13T12:00:10Z' } }))
  const ownedProof = { ...fixtureProof }; const input = { ...mutable, verifiedSource: ownedProof }
  const id = input.observation.observationId; const key = input.receiptKey.operationKey
  const pause = gate(); let once = true
  const delayed = hookPool(pool, async (sql, execute) => {
    const value = await execute()
    if (once && sql.startsWith('SELECT id FROM durable_runtime.sessions')) { once = false; pause.enter(); await pause.waiting }
    return value
  })
  const running = ingestFailureEvidence(delayed, input)
  await pause.entered
  try {
    date.setTime(0); input.receiptKey.operationKey = 'caller-mutated-key'
    Reflect.set(input.observation.target, 'runtimeUnitId', logicalId('runtime-unit', randomUUID()))
    Reflect.set(input.collectionPolicy, 'budgetMs', 1); Reflect.set(ownedProof, 'evidenceRef', 'caller-mutated-proof')
    pause.release(); await running
  } finally { pause.release() }
  const row = (await pool.query('SELECT evidence,observed_at FROM durable_runtime.failure_observations WHERE id=$1', [id])).rows[0]
  assert.equal(row.observed_at.toISOString(), '2026-10-13T12:00:02.000Z')
  assert.equal(row.evidence.target.runtimeUnitId, f.target.runtimeUnitId)
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.rpc_receipts WHERE operation_key=$1', [key])).rows[0].n, '1')
})

check('stale epoch의 이력은 보존하고 현재 Unit의 phase·pointer·desired·기한은 변경하지 않는다', async () => {
  const f = await fixture(pool); const attempt = logicalId('attempt', randomUUID())
  await pool.query("INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status) VALUES($1,$2,2,'COLD',$3,'fixture-current-incarnation',0,'{}','READY')", [attempt, f.target.runtimeUnitId, 'fixture-current-pod'])
  await pool.query("UPDATE durable_runtime.runtime_units SET execution_epoch=2,active_attempt_id=$2,idle_due_at=clock_timestamp()+interval '1 hour',reconcile_due_at=clock_timestamp()+interval '2 hours' WHERE id=$1", [f.target.runtimeUnitId, attempt])
  const beforeUnit = await unitRow(pool, f)
  const recorded = result(await ingestFailureEvidence(pool, request(f)))
  assert.equal(recorded.currentExecution, false); assert.equal(recorded.reason, 'STALE_EXECUTION')
  assert.deepEqual(await unitRow(pool, f), beforeUnit)
  assert.equal(await count(pool, 'failure_observations', f), '1')
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.target.runtimeUnitId])).rows[0].n, '0')
})

check('원 deadline은 추가 source·정책 변경에도 불변이며 만료 audit/outbox는 한 번만 남는다', async () => {
  const f = await fixture(pool)
  const known = observation(f)
  const signals = { ...known.signals, oomKilled: false }
  const termination = { ...known.termination!, reason: null }
  const unknown = request(f, observation(f, { signals, termination, resources: null, placement: null }))
  const first = { ...unknown, collectionPolicy: { revision: 'fixture-bounded-v1', budgetMs: 2000 } }
  const opened = result(await ingestFailureEvidence(pool, first)); assert.ok(opened.incidentId)
  assert.equal(opened.state, 'COLLECTING')
  const beforeState = await stateRow(pool, opened.incidentId)
  const extra = { ...request(f, observation(f, { signals, termination, resources: null, placement: null })),
    collectionPolicy: { revision: 'fixture-bounded-v2', budgetMs: 60000 } }
  await ingestFailureEvidence(pool, extra)
  const changed = await stateRow(pool, opened.incidentId)
  assert.equal(changed.original_start, beforeState.original_start); assert.equal(changed.original_deadline, beforeState.original_deadline)
  await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM deadline_at-clock_timestamp()))+0.03) FROM durable_runtime.failure_incident_state WHERE incident_id=$1', [opened.incidentId])
  const unitBefore = await unitRow(pool, f); const stateBefore = await stateRow(pool, opened.incidentId)
  const due = await listDueFailureIncidents(pool, { unitId: f.target.runtimeUnitId, limit: 10 })
  assert.equal(due.some(row => row.incident_id === opened.incidentId), true)
  assert.deepEqual(await stateRow(pool, opened.incidentId), stateBefore); assert.deepEqual(await unitRow(pool, f), unitBefore)
  const expiry = { incidentId: opened.incidentId, unitId: f.target.runtimeUnitId, expectedRevision: String(stateBefore.revision),
    receiptKey: { principalId: 'p121-fixture-controller', sessionScope: `unit:${f.target.runtimeUnitId}`, method: 'resource-failure.expire', operationKey: randomUUID() } }
  const [a, b] = await Promise.all([expireFailureEvidenceWithReceipt(pool, expiry), expireFailureEvidenceWithReceipt(pool, {
    ...expiry, receiptKey: { ...expiry.receiptKey, operationKey: randomUUID() } })])
  assert.ok(a.status !== 'UNCERTAIN' && b.status !== 'UNCERTAIN')
  if (a.status === 'UNCERTAIN' || b.status === 'UNCERTAIN') { throw new Error('fixture expiry uncertain') }
  const statuses = [a.receipt.response, b.receipt.response].map(value => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value.status
  })
  assert.deepEqual(statuses.sort(), ['BLOCKED', 'UNCHANGED'])
  assert.equal((await expireFailureEvidenceWithReceipt(pool, expiry)).status, 'REPLAYED')
  const blocked = await stateRow(pool, opened.incidentId)
  assert.equal(blocked.reason, 'RESOURCE_EVIDENCE_DEADLINE')
  await ingestFailureEvidence(pool, request(f, known))
  const later = await stateRow(pool, opened.incidentId)
  assert.equal(later.state, 'BLOCKED'); assert.equal(later.original_deadline, beforeState.original_deadline)
  assert.ok(BigInt(later.classification_revision) > BigInt(blocked.classification_revision))
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$1 AND kind='RESOURCE_EVIDENCE_DEADLINE'", [f.target.runtimeUnitId])).rows[0].n, '1')
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.outbox_events WHERE aggregate_id=$1 AND event->>'kind'='RESOURCE_EVIDENCE_DEADLINE'", [f.target.runtimeUnitId])).rows[0].n, '1')
  assert.deepEqual(await unitRow(pool, f), unitBefore)
})

check('실제 P112 original row는 같은 TX에서 기록되며 handler 실패 때 incident 변경은 rollback한다', async () => {
  const f = await fixture(pool); const raw = observation(f); const claim = await queueClaim(pool, f, raw)
  const ranks: number[] = []
  const processed = await processRuntimeEvent(pool, claim, async (tx, original) => {
    assert.equal(tx.isLockHeld(2, f.target.runtimeUnitId), true); assert.equal(tx.isLockHeld(1, f.sessionId), true)
    const advance = tx.advanceLock.bind(tx)
    tx.advanceLock = (rank, key) => { ranks.push(rank); advance(rank, key) }
    try { await handleFailureEvidenceEvent(tx, original, { decode, collectionPolicy: { revision: 'fixture-queue-v1', budgetMs: 60000 } }) }
    finally { tx.advanceLock = advance }
  })
  assert.equal(processed.status, 'DONE'); assert.deepEqual(ranks, [])
  assert.equal((await pool.query('SELECT runtime_event_id FROM durable_runtime.failure_observations WHERE id=$1', [raw.observationId])).rows[0].runtime_event_id, claim.eventId)
  assert.equal((await pool.query('SELECT state FROM durable_runtime.runtime_event_queue WHERE event_id=$1', [claim.eventId])).rows[0].state, 'DONE')
  const failedFixture = await fixture(pool); const failedRaw = observation(failedFixture)
  const failedClaim = await queueClaim(pool, failedFixture, failedRaw)
  const priorUnit = await unitRow(pool, failedFixture)
  const failed = await processRuntimeEvent(pool, failedClaim, async (tx, original) => {
    await handleFailureEvidenceEvent(tx, original, { decode, collectionPolicy: { revision: 'fixture-queue-v1', budgetMs: 60000 } })
    throw new DurableDatabaseError('P121_HANDLER_FAULT')
  })
  assert.equal(failed.status, 'RETRY')
  assert.equal((await pool.query('SELECT last_error FROM durable_runtime.runtime_event_queue WHERE event_id=$1', [failedClaim.eventId])).rows[0].last_error, 'P121_HANDLER_FAULT')
  assert.equal(await count(pool, 'failure_observations', failedFixture), '0')
  assert.equal(await count(pool, 'failure_incidents', failedFixture), '0')
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$1 AND kind LIKE 'RESOURCE_%'", [failedFixture.target.runtimeUnitId])).rows[0].n, '0')
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.outbox_events WHERE aggregate_id=$1 AND event->>'kind' LIKE 'RESOURCE_%'", [failedFixture.target.runtimeUnitId])).rows[0].n, '0')
  assert.deepEqual(await unitRow(pool, failedFixture), priorUnit)
  observations.queueScope = '실제 P112 claim/process와 동일 TX incident 성공/실패를 확인하며 기존 P112 suite나 물리 worker 장애를 반복하지 않습니다.'
})
