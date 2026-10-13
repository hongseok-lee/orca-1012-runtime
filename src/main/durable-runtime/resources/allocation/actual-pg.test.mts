import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createDurablePool, DurableDatabaseError } from '../../db/connection.ts'
import { readMigrations, applyMigrations } from '../../db/migrate.ts'
import { prepareResourceOperation, reserveExistingResourcePlan, listDueResourceReservations } from './index.ts'
import type { PrepareResourceRequest, ResourceFacts } from './types.ts'
import { fixture, register, request, response, unitRevision, hookPool, gate, authority, authorizer } from './test-support.mts'

assert.match(process.env.PGDATABASE ?? '', /^orca_p122_[a-z0-9_]+$/)
assert.ok(process.env.P122_MIGRATIONS)
const pool = createDurablePool({ max: 12 })
const cases: { name: string; passed: boolean; errorCode?: string }[] = []
const facts: Record<string, unknown> = {}
let schema: { version: string; checksum: string }[] = []
before(async () => {
  const files = await readMigrations(process.env.P122_MIGRATIONS!)
  assert.equal(files.length, 19)
  schema = (await applyMigrations(pool, files)).map(({ version, checksum }) => ({ version, checksum }))
})
after(async () => {
  if (process.env.P122_EVIDENCE) {
    await writeFile(process.env.P122_EVIDENCE, `${JSON.stringify({
      scope: 'ACTUAL_OWNED_PG_ALLOCATION_WITH_SYNTHETIC_TRUSTED_INPUTS', source: process.env.P122_SOURCE_REVISION,
      baseline: '7aa2f3177768b1dfaf25d122b3348bdb28f9eace', policySource: '8857ea44614867f6c2410dad6bf8b79e65585ac9',
      db019Source: '730850ee335c41290af38ea8825484b5f4cc0b6f', schema, cases, facts,
      productionIssuerVerified: false, actualAdmissionVerified: false, externalCapacityVerified: false,
      actualAgentOomVerified: false, actualResizeExecuted: false, actualFenceExecuted: false, podCreated: false,
      actualSleepWakeExecuted: false, providerExecuted: false, physicalHaVerified: false,
      faultScope: '소유 PG row-lock 대기와 ledger SQL 직전 driver hook이며 공유 PG/Pod/Node fault는 아닙니다.'
    }, null, 2)}\n`, { mode: 0o600 })
  }
  await pool.end()
})
function check(name: string, body: () => Promise<void>) {
  test(name, { timeout: 120000 }, async () => {
    try { await body(); cases.push({ name, passed: true }) } catch (error) {
      cases.push({ name, passed: false, errorCode: error instanceof DurableDatabaseError ? error.code : 'FIXTURE_FAILURE' }); throw error
    }
  })
}
check('두 Unit의 실제 공유 scope 예약 경합은 memory와 CPU 한도를 넘기지 않는다', async () => {
  const a = await fixture(pool), b = await fixture(pool, { ...a, controller: { ...a.controller, scope: `p122-controller:${randomUUID()}` } })
  assert.equal(a.scope, b.scope); assert.equal(a.domain, b.domain); assert.notEqual(a.controller.scope, b.controller.scope)
  const memory = String(256n * 1048576n)
  await register(pool, a, memory, '500'); await register(pool, b, memory, '500')
  const parent = await pool.connect(), entered = gate(), backendPids = new Set<number>()
  await parent.query('BEGIN')
  await parent.query('SELECT scope FROM durable_runtime.resource_budget_scopes WHERE scope=$1 FOR UPDATE', [a.scope])
  const wrapped = hookPool(pool, async (sql, execute, client) => {
    if (sql.includes('FROM durable_runtime.resource_budget_scopes') && sql.includes('FOR UPDATE')) {
      backendPids.add((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      if (backendPids.size === 2) { entered.enter() }
    }
    return execute()
  })
  const pending = Promise.allSettled([prepareResourceOperation(wrapped, request(a)), prepareResourceOperation(wrapped, request(b))])
  try {
    await entered.entered
    let observed = false
    for (let n = 0; n < 80; n += 1) {
      const waits = (await pool.query("SELECT pid,wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=ANY($1::int[])", [[...backendPids]])).rows
      observed = waits.length === 2 && waits.every(row => row.waiting === true)
      if (observed) { break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(observed, true)
    facts.actualBudgetSqlLockObserved = { distinctControllerScopes: true, distinctBackendPids: [...backendPids], waitingConnections: 2 }
    await parent.query('COMMIT')
  } finally { await parent.query('ROLLBACK'); parent.release() }
  const settled = await pending
  const results = settled.map(result => { if (result.status === 'rejected') { throw result.reason }; return result.value })
  assert.deepEqual(results.map(x => response(x).status).sort(), ['RESERVED', 'RESOURCE_WAIT'])
  const totals = (await pool.query(`SELECT
    (SELECT SUM(accounted_memory_bytes) FROM durable_runtime.resource_unit_state WHERE budget_scope=$1)+
    COALESCE((SELECT SUM(additional_memory_charge_bytes) FROM durable_runtime.resource_reservation_accounting a
      JOIN durable_runtime.resource_reservations r ON r.operation_id=a.operation_id WHERE budget_scope=$1 AND r.state='RESERVED'),0) AS memory,
    (SELECT SUM(accounted_cpu_millicores) FROM durable_runtime.resource_unit_state WHERE budget_scope=$1)+
    COALESCE((SELECT SUM(additional_cpu_charge_millicores) FROM durable_runtime.resource_reservation_accounting a
      JOIN durable_runtime.resource_reservations r ON r.operation_id=a.operation_id WHERE budget_scope=$1 AND r.state='RESERVED'),0) AS cpu`, [a.scope])).rows[0]
  assert.ok(BigInt(totals.memory) <= BigInt(memory)); assert.ok(BigInt(totals.cpu) <= 500n)
  assert.equal((await pool.query(`SELECT count(*) AS n FROM durable_runtime.resource_growth_ledger l
    JOIN durable_runtime.resource_unit_state u ON u.runtime_unit_id=l.runtime_unit_id WHERE u.budget_scope=$1`, [a.scope])).rows[0].n, '1')
  facts.sharedScopeOvershoot = 0
})
check('첫 capacity WAIT의 원 목표와 provenance를 재사용하며 같은 incident와 operation은 중복 charge가 없다', async () => {
  const f = await fixture(pool); await register(pool, f)
  const original = request(f, false), opened = await prepareResourceOperation(pool, original), waiting = response(opened)
  assert.equal(waiting.status, 'RESOURCE_WAIT'); assert.ok(waiting.targetMemoryBytes); assert.ok(waiting.operationId)
  const before = (await pool.query('SELECT * FROM durable_runtime.resource_operation_plans WHERE operation_id=$1', [waiting.operationId])).rows[0]
  assert.equal(before.facts.policyDecision.kind, 'RESOURCE_WAIT'); assert.equal(before.facts.policyDecision.targetMemoryBytes, waiting.targetMemoryBytes)
  const reused = response(await prepareResourceOperation(pool, { ...original, operationKey: randomUUID(), expectedUnitRevision: await unitRevision(pool, f) }))
  assert.equal(reused.operationId, waiting.operationId); assert.equal(reused.targetProfileRevision, waiting.targetProfileRevision)
  const fresh = { ...request(f, true), expectedUnitRevision: await unitRevision(pool, f) }
  const reservedRequest = { ...fresh, operationId: waiting.operationId }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The response UUID is checked above and resolved against the actual owned PG plan; fixture-only logical operation type.
  const fixed = { ...reservedRequest, operationId: waiting.operationId as Parameters<typeof reserveExistingResourcePlan>[1]['operationId'] }
  const reserved = response(await reserveExistingResourcePlan(pool, fixed)); assert.equal(reserved.status, 'RESERVED')
  assert.equal(reserved.targetMemoryBytes, waiting.targetMemoryBytes); assert.equal(reserved.targetProfileRevision, waiting.targetProfileRevision)
  const replay = await reserveExistingResourcePlan(pool, fixed); assert.equal(replay.status, 'REPLAYED')
  const newKey = response(await reserveExistingResourcePlan(pool, { ...fixed, operationKey: randomUUID() }))
  assert.equal(newKey.operationId, waiting.operationId)
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.resource_growth_ledger WHERE runtime_unit_id=$1', [f.target.runtimeUnitId])).rows[0].n, '1')
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$1', [f.target.runtimeUnitId])).rows[0].n, '2')
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.resource_operation_plans WHERE operation_id=$1', [waiting.operationId])).rows[0], before)
  facts.originalWaitTargetRepeatedCalculations = 0
})
check('REPLACE는 원 승인 크기로 replacement만 한 번 소비한다', async () => {
  const f = await fixture(pool); await register(pool, f)
  const result = response(await prepareResourceOperation(pool, request(f, true, 'REPLACE')))
  assert.equal(result.status, 'RESERVED'); assert.equal(result.targetMemoryBytes, f.profile.memoryBytes)
  const episode = (await pool.query('SELECT growth_count,replacement_count FROM durable_runtime.recovery_episodes WHERE runtime_unit_id=$1', [f.target.runtimeUnitId])).rows[0]
  assert.equal(episode.growth_count, '0'); assert.equal(episode.replacement_count, '1')
  const state = (await pool.query('SELECT approved_profile_revision,desired_profile_revision FROM durable_runtime.resource_unit_state WHERE runtime_unit_id=$1', [f.target.runtimeUnitId])).rows[0]
  assert.equal(state.approved_profile_revision, '0'); assert.equal(state.desired_profile_revision, result.targetProfileRevision)
})
check('실제 lease row-lock 대기 뒤 만료를 다시 판정하고 예약을 거절한다', async () => {
  const f = await fixture(pool); await register(pool, f)
  const waiting = response(await prepareResourceOperation(pool, request(f, false))); assert.ok(waiting.operationId)
  const parent = await pool.connect(), entered = gate(); let backendPid = 0, postLockClockQuery = false
  await parent.query('BEGIN')
  await parent.query("UPDATE durable_runtime.controller_leases SET expires_at=clock_timestamp()+interval '700 milliseconds' WHERE scope=$1", [f.controller.scope])
  await parent.query('SELECT scope FROM durable_runtime.controller_leases WHERE scope=$1 FOR UPDATE', [f.controller.scope])
  const wrapped = hookPool(pool, async (sql, execute, client) => {
    if (sql.includes('SELECT scope FROM durable_runtime.controller_leases') && sql.includes('FOR UPDATE')) {
      backendPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; entered.enter()
    }
    if (sql.includes('owner=$2') && sql.includes('expires_at>clock_timestamp()')) { postLockClockQuery = true }
    return execute()
  })
  const fresh = request(f, true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Owned plan UUID, not an authority assertion.
  const reserve = { ...fresh, operationId: waiting.operationId as Parameters<typeof reserveExistingResourcePlan>[1]['operationId'], expectedUnitRevision: await unitRevision(pool, f) }
  const pending = reserveExistingResourcePlan(wrapped, reserve)
  const rejected = assert.rejects(pending, e => e instanceof DurableDatabaseError && e.code === 'RESOURCE_STALE_LEASE')
  try {
    await entered.entered
    let observed = false
    for (let n = 0; n < 80; n += 1) {
      observed = (await pool.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [backendPid])).rows[0]?.waiting === true
      if (observed) { break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(observed, true); facts.actualLeaseSqlLockObserved = true
    await parent.query('SELECT pg_sleep(0.8)')
    await parent.query('COMMIT'); await rejected
    assert.equal(postLockClockQuery, true)
    assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.resource_reservations WHERE runtime_unit_id=$1', [f.target.runtimeUnitId])).rows[0].n, '0')
  } finally { await parent.query('ROLLBACK'); parent.release() }
})
check('첫 await 뒤 원 body와 callback 변이에는 snapshot을 쓰며 원 receipt는 현재 lifecycle로 다시 판정하지 않는다', async () => {
  const f = await fixture(pool); await register(pool, f)
  const input = request(f), blocked = gate(), receiver = { calls: 0,
    async authorize(a: ReturnType<typeof authority>) { this.calls += 1; assert.equal(a.principalId, 'p122-fixture-operator'); blocked.enter(); await blocked.waiting } }
  const mutable = JSON.parse(JSON.stringify(input.facts))
  // Nominal proof is already a fixture assertion; only data fields are mutable.
  const original: PrepareResourceRequest = { ...input, facts: mutable, authorizer: receiver }
  const pending = prepareResourceOperation(pool, original)
  await blocked.entered
  mutable.target.podUid = 'changed-pod'; mutable.declared.containers[0].memoryBytes = '1'; mutable.profile.cpuMillicores = '1'
  receiver.authorize = async () => { throw new Error('changed callback must not execute') }
  blocked.release()
  const first = response(await pending); assert.equal(first.status, 'RESERVED'); assert.equal(receiver.calls, 1)
  await pool.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSED' WHERE id=$1", [f.session])
  await pool.query("UPDATE durable_runtime.runtime_units SET desired_mode='DELETED',intent_revision=intent_revision+1,revision=revision+1 WHERE id=$1", [f.target.runtimeUnitId])
  const replay = await prepareResourceOperation(pool, input); assert.equal(replay.status, 'REPLAYED'); assert.deepEqual(response(replay), first)
  const different: ResourceFacts = { ...input.facts, declared: { ...input.facts.declared, containers: [{ ...input.facts.declared.containers[0], cpuMillicores: '201' }] } }
  await assert.rejects(prepareResourceOperation(pool, { ...input, facts: different }), e => e instanceof DurableDatabaseError && e.code === 'RECEIPT_PAYLOAD_CONFLICT')
  const stale = await fixture(pool); await register(pool, stale)
  const staleInput = request(stale)
  await pool.query('UPDATE durable_runtime.runtime_units SET intent_revision=intent_revision+1,revision=revision+1 WHERE id=$1', [stale.target.runtimeUnitId])
  await assert.rejects(prepareResourceOperation(pool, staleInput), e => e instanceof DurableDatabaseError && e.code === 'RESOURCE_STALE_INTENT')
  const newAttempt = randomUUID()
  await pool.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status)
    VALUES($1,$2,2,'COLD','fixture-new-pod','fixture-new-incarnation',0,$3::jsonb,'READY')`,
    [newAttempt, stale.target.runtimeUnitId, JSON.stringify(stale.shape)])
  await pool.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2,execution_epoch=2,revision=revision+1 WHERE id=$1',
    [stale.target.runtimeUnitId, newAttempt])
  await assert.rejects(prepareResourceOperation(pool, { ...staleInput, operationKey: randomUUID(),
    expectedUnitRevision: await unitRevision(pool, stale), expectedIntentRevision: '1' }),
    e => e instanceof DurableDatabaseError && e.code === 'RESOURCE_STALE_INCIDENT')
})
check('실제 ledger INSERT 직전 SQL 실패는 profile·plan·예약·episode·receipt·audit·outbox 전체를 rollback한다', async () => {
  const f = await fixture(pool); await register(pool, f); let reached = false
  const wrapped = hookPool(pool, async (sql, execute) => {
    if (sql.includes('INSERT INTO durable_runtime.resource_growth_ledger')) { reached = true; throw new DurableDatabaseError('P122_LEDGER_FIXTURE_FAULT') }
    return execute()
  })
  await assert.rejects(prepareResourceOperation(wrapped, request(f)), e => e instanceof DurableDatabaseError && e.code === 'P122_LEDGER_FIXTURE_FAULT')
  assert.equal(reached, true); facts.actualLedgerWriteBoundaryReached = true
  for (const table of ['operations', 'resource_operation_plans', 'resource_reservations', 'resource_growth_ledger', 'recovery_episodes']) {
    assert.equal((await pool.query(`SELECT count(*) AS n FROM durable_runtime.${table} WHERE runtime_unit_id=$1`, [f.target.runtimeUnitId])).rows[0].n, '0')
  }
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$1', [f.target.runtimeUnitId])).rows[0].n, '1')
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$1', [f.target.runtimeUnitId])).rows[0].n, '0')
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.outbox_events WHERE aggregate_id=$1', [f.target.runtimeUnitId])).rows[0].n, '0')
  assert.equal((await pool.query(`SELECT count(*) AS n FROM durable_runtime.rpc_receipts
    WHERE method='resource.operation.prepare' AND session_scope=$1`,
    [JSON.stringify(['resource-unit', 'orca-1012-dev-v1', f.domain, f.target.runtimeUnitId])])).rows[0].n, '0')
  const state = (await pool.query('SELECT desired_profile_revision,current_episode_id FROM durable_runtime.resource_unit_state WHERE runtime_unit_id=$1', [f.target.runtimeUnitId])).rows[0]
  assert.equal(state.desired_profile_revision, null); assert.equal(state.current_episode_id, null)
})
check('예약 expiry와 논리 sleep/wake 뒤에도 원 점유·승인 profile·ledger와 episode 예산은 보존된다', async () => {
  const f = await fixture(pool); await register(pool, f)
  const first = response(await prepareResourceOperation(pool, request(f))); assert.equal(first.status, 'RESERVED')
  const original = (await pool.query('SELECT * FROM durable_runtime.resource_reservations WHERE operation_id=$1', [first.operationId])).rows[0]
  await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.03) FROM durable_runtime.resource_reservations WHERE operation_id=$1', [first.operationId])
  const due = await listDueResourceReservations(pool, { authority: authority(f), authorizer: authorizer(), limit: 100 })
  assert.ok(due.some(r => r.operationId === first.operationId && r.releaseAuthorized === false))
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.resource_reservations WHERE operation_id=$1', [first.operationId])).rows[0], original)
  // Fixture-only logical mode transitions and operation settlement. No actual
  // sleep/wake, fence, resize or application controller is activated.
  await pool.query("UPDATE durable_runtime.runtime_units SET desired_mode='SUSPENDED',intent_revision=intent_revision+1,revision=revision+1 WHERE id=$1", [f.target.runtimeUnitId])
  await pool.query("UPDATE durable_runtime.runtime_units SET desired_mode='RUNNING',intent_revision=intent_revision+1,revision=revision+1 WHERE id=$1", [f.target.runtimeUnitId])
  await pool.query('UPDATE durable_runtime.operations SET result=$2::jsonb WHERE id=$1', [first.operationId, JSON.stringify({ fixtureLogicalSettlement: true })])
  const nextIncident = randomUUID()
  await pool.query(`INSERT INTO durable_runtime.failure_incidents(id,runtime_unit_id,attempt_id,pod_uid,container_id,restart_identity,evidence_key,classification,evidence_refs,observed_at)
    SELECT $1,runtime_unit_id,attempt_id,pod_uid,container_id,restart_identity,$2,classification,evidence_refs,clock_timestamp()
    FROM durable_runtime.failure_incidents WHERE id=$3`, [nextIncident, `fixture-new-memory-cause:${nextIncident}`, f.incidentId])
  await pool.query(`INSERT INTO durable_runtime.failure_incident_state(incident_id,runtime_unit_id,attempt_id,execution_epoch,collection_started_at,deadline_at,state,classification_revision,evidence_ids)
    SELECT $1,runtime_unit_id,attempt_id,execution_epoch,clock_timestamp(),clock_timestamp()+interval '1 minute','CLASSIFIED',1,evidence_ids
    FROM durable_runtime.failure_incident_state WHERE incident_id=$2`, [nextIncident, f.incidentId])
  const fresh = { ...request(f), incidentId: nextIncident, expectedUnitRevision: await unitRevision(pool, f), expectedIntentRevision: '2' }
  const exhausted = response(await prepareResourceOperation(pool, fresh)); assert.equal(exhausted.status, 'BLOCKED')
  assert.ok(exhausted.reasons.includes('EPISODE_GROWTH_EXHAUSTED')); assert.ok(exhausted.reasons.includes('ROLLING_GROWTH_EXHAUSTED'))
  const head = (await pool.query('SELECT * FROM durable_runtime.resource_unit_state WHERE runtime_unit_id=$1', [f.target.runtimeUnitId])).rows[0]
  assert.equal(head.approved_profile_revision, '0'); assert.equal(head.accounted_memory_bytes, f.profile.memoryBytes)
  assert.equal(head.breaker, 'OPEN')
  const episode = (await pool.query('SELECT growth_count,replacement_count FROM durable_runtime.recovery_episodes WHERE runtime_unit_id=$1', [f.target.runtimeUnitId])).rows[0]
  assert.equal(episode.growth_count, '1'); assert.equal(episode.replacement_count, '1')
  facts.expiryReleasedOccupancy = false; facts.logicalModeTransitionsOnly = true
})
