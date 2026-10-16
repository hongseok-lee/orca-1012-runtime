import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import type { VerifiedControllerIdentity } from '../runtime/gateway/types.ts'
import { prepareReconcileStep } from '../lifecycle/controller.ts'
import { runInitialWakeExpiryCases } from '../lifecycle/initial-wake-expiry.pg.cases.mts'
import { requestUnitIntent } from '../lifecycle/intent.ts'
import { executor, fixture, intent } from '../lifecycle/verification-fixtures.mts'
import { CONTROLLER_DATASET, CONTROLLER_SCOPE, ControllerInstance, type LeaseRecord } from './instance.ts'
import { releaseControllerLease } from './lease.ts'
import { ControllerLeaseSession } from './session.ts'
import { runControllerPass, type ControllerPassRequest } from './pass.ts'
import { observedPool } from './worker-fixtures.mts'

// One parent owns a real session for both the DB cases and the actual pass.
// No outer runner lease, forced expiry/reset, fake session, provider or Pod I/O.
const database = process.env.ORCA_UNHANDLED_WAKE_DATABASE
const databaseOid = process.env.ORCA_UNHANDLED_WAKE_DATABASE_OID
const evidenceDirectory = process.env.ORCA_UNHANDLED_WAKE_LEASE_EVIDENCE_DIRECTORY
const leaseDurationMs = Number(process.env.ORCA_UNHANDLED_WAKE_LEASE_DURATION_MS)

async function seed(pool: Pool, expired: boolean, futureRetry = false) {
  const f = await fixture(pool, 1)
  assert.equal((await requestUnitIntent(pool, await intent(pool, f))).status, 'COMMITTED')
  const operation = (await pool.query<{ id: string }>(
    'SELECT id FROM durable_runtime.operations WHERE runtime_unit_id=$1 AND result IS NULL', [f.unit])).rows[0]
  assert.ok(operation)
  await pool.query("UPDATE durable_runtime.runtime_units SET phase='BLOCKED' WHERE id=$1", [f.unit])
  await pool.query(`UPDATE durable_runtime.operations SET deadline_at=clock_timestamp()+$2::interval,
    retry_at=CASE WHEN $3 THEN clock_timestamp()+interval '1 hour' ELSE NULL END WHERE id=$1`,
  [operation.id, expired ? '-1 minute' : '1 hour', futureRetry])
  return { ...f, operationId: logicalId('operation', operation.id) }
}
type Seed = Awaited<ReturnType<typeof seed>>

async function state(pool: Pool, f: Seed) {
  const unit = (await pool.query(`SELECT id,desired_mode,phase,revision::text,intent_revision::text,
    execution_epoch::text,active_attempt_id FROM durable_runtime.runtime_units WHERE id=$1`, [f.unit])).rows[0]
  const operation = (await pool.query(`SELECT id,runtime_unit_id,kind,step,step_revision::text,revision::text,
    execution_epoch::text,intent_revision::text,expected_pod_uid,external_resource_name,
    deadline_at::text,retry_at::text,result FROM durable_runtime.operations WHERE id=$1`, [f.operationId])).rows[0]
  const sessions = (await pool.query('SELECT to_jsonb(s)::text AS body FROM durable_runtime.sessions s WHERE id=ANY($1::uuid[]) ORDER BY id', [f.sessions])).rows
  const binding = (await pool.query('SELECT to_jsonb(b)::text AS body FROM durable_runtime.storage_bindings b WHERE id=$1', [f.binding])).rows
  const counts = (await pool.query(`SELECT
    (SELECT count(*)::text FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1) AS commands,
    (SELECT count(*)::text FROM durable_runtime.agent_pod_plans WHERE runtime_unit_id=$1) AS plans,
    (SELECT count(*)::text FROM durable_runtime.attempts WHERE runtime_unit_id=$1) AS attempts,
    (SELECT count(*)::text FROM durable_runtime.execution_grants WHERE runtime_unit_id=$1) AS executions,
    (SELECT count(*)::text FROM durable_runtime.storage_write_grants WHERE storage_binding_id=$3) AS writers,
    (SELECT count(*)::text FROM durable_runtime.storage_mounts WHERE storage_binding_id=$3) AS mounts,
    (SELECT count(*)::text FROM durable_runtime.runtime_audit_events WHERE operation_id=$2 AND kind='RECONCILE_OPERATION_DEADLINE_EXPIRED') AS terminal_audits,
    (SELECT count(*)::text FROM durable_runtime.outbox_events WHERE aggregate_id=$1 AND event->>'kind'='RECONCILE_OPERATION_DEADLINE_EXPIRED') AS terminal_outbox,
    (SELECT count(*)::text FROM durable_runtime.rpc_receipts WHERE session_scope=$4 AND method='lifecycle.expire-initial-wake') AS expiry_receipts`,
  [f.unit, f.operationId, f.binding, `runtime-unit:${f.unit}`])).rows[0]
  return { unit, operation, sessions, binding, counts }
}

export async function runUnhandledWakeExpiryPassCases(t: TestContext, pool: Pool,
  session: ControllerLeaseSession, controller: VerifiedControllerIdentity): Promise<void> {
  const options = { controller, maximumWork: 100, externalBudgetMs: 10000 }
  for (const mode of ['null planner', 'no planner with future retry'] as const) {
    await t.test(`actual pass expires initial WAKE with ${mode} without execution callbacks`, async () => {
      const f = await seed(pool, true, mode === 'no planner with future retry')
      const before = await state(pool, f)
      let plannerCalls = 0, dueQueries = 0
      const observed = observedPool(pool, async (sql, _values, _client, execute) => {
        if (sql.includes('SELECT u.id FROM durable_runtime.runtime_units u')) dueQueries++
        return execute()
      })
      const request: ControllerPassRequest = { ...options,
        ...(mode === 'null planner' ? { planStep: (_operation, unit) => { if (unit.id === f.unit) plannerCalls++; return null } } : {}) }
      const result = await runControllerPass(observed, session, request)
      assert.equal(result.status, 'FINISHED')
      assert.ok(result.items.some(item => item.identity === f.operationId && item.disposition === 'DEADLINE_EXPIRED'))
      assert.equal(plannerCalls, 0)
      if (mode === 'no planner with future retry') assert.equal(dueQueries, 0)
      const after = await state(pool, f)
      assert.equal(after.unit.phase, 'BLOCKED')
      assert.equal(BigInt(after.unit.revision), BigInt(before.unit.revision) + 1n)
      assert.equal(after.operation.step, 'FAILED')
      assert.deepEqual(after.operation.result, { state: 'FAILED', reason: 'DEADLINE_EXPIRED_BEFORE_ACCEPTANCE' })
      for (const field of ['id', 'external_resource_name', 'deadline_at', 'retry_at', 'intent_revision', 'execution_epoch']) {
        assert.deepEqual(after.operation[field], before.operation[field])
      }
      assert.deepEqual(after.sessions, before.sessions)
      assert.deepEqual(after.binding, before.binding)
      assert.deepEqual(after.counts, { commands: '0', plans: '0', attempts: '0', executions: '0', writers: '0', mounts: '0',
        terminal_audits: '1', terminal_outbox: '1', expiry_receipts: '1' })
      const again = await runControllerPass(pool, session, options)
      assert.equal(again.status, 'FINISHED')
      assert.deepEqual(await state(pool, f), after, 'a later pass does not renew or repeat the terminal mutation')
    })
  }

  await t.test('future unmatched WAKE preserves the original operation and no-planner due skip', async () => {
    const f = await seed(pool, false)
    const before = await state(pool, f)
    let effects = 0, dueQueries = 0
    const observed = observedPool(pool, async (sql, _values, _client, execute) => {
      if (sql.includes('SELECT u.id FROM durable_runtime.runtime_units u')) dueQueries++
      return execute()
    })
    const unsupported = await runControllerPass(observed, session, {
      ...options, planStep: () => null, executeCommitted: async () => { effects++ }, lookupOriginal: async () => { effects++ } })
    assert.equal(unsupported.status, 'FINISHED')
    assert.ok(unsupported.items.some(item => item.identity === f.operationId && item.disposition === 'NO_STEP_HANDLER'))
    const beforeAbsent = dueQueries
    const absent = await runControllerPass(observed, session, options)
    assert.equal(absent.status, 'FINISHED')
    assert.equal(dueQueries, beforeAbsent)
    assert.equal(absent.items.some(item => item.identity === f.unit || item.identity === f.operationId), false)
    assert.equal(effects, 0)
    assert.deepEqual(await state(pool, f), before)
  })

  await t.test('pending original command retains lookup instead of expiry or re-execution', async () => {
    const f = await seed(pool, false)
    const initial = await state(pool, f)
    const context = { controller, runtimeUnitId: f.unit, operationId: f.operationId }
    const prepared = await prepareReconcileStep(pool, { context, mutationKey: randomUUID(),
      expectedUnitRevision: counter('row:runtime-unit', initial.unit.revision),
      expectedIntentRevision: counter('intent-revision', initial.unit.intent_revision),
      expectedStepRevision: counter('step-revision', initial.operation.step_revision),
      step: 'ENSURE_ATTEMPT', executorId: executor, input: { fixtureOnly: 'original-command-preservation' } })
    assert.equal(prepared.execution.disposition, 'COMMITTED_EXECUTE')
    if (prepared.execution.disposition !== 'COMMITTED_EXECUTE') throw new Error('Original fixture command claim required')
    const originalId = prepared.execution.claim.commandId
    await pool.query("UPDATE durable_runtime.operations SET deadline_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [f.operationId])
    let lookups = 0
    const planStep: NonNullable<ControllerPassRequest['planStep']> = (_operation, unit) => unit.id === f.unit
      ? { mutationKey: randomUUID(), step: 'ENSURE_ATTEMPT', executorId: executor, input: { fixtureOnly: 'original-command-preservation' } } : null
    const result = await runControllerPass(pool, session, { ...options, planStep,
      executeCommitted: async () => { assert.fail('a pending original must not execute again') },
      lookupOriginal: async command => { assert.equal(command.id, originalId); lookups++ } })
    assert.equal(result.status, 'FINISHED')
    assert.equal(lookups, 1)
    assert.ok(result.items.some(item => item.identity === originalId && item.disposition === 'LOOKUP_ORIGINAL'))
    const after = await state(pool, f)
    assert.equal(after.counts.commands, '1')
    assert.equal(after.counts.expiry_receipts, '0')
    assert.equal(after.counts.terminal_audits, '0')
    assert.equal(after.counts.terminal_outbox, '0')
    assert.equal(after.operation.result, null)
  })

  await t.test('actual transaction clock recheck preserves a now-future operation', async () => {
    const f = await seed(pool, true)
    const observation: { afterChange: Awaited<ReturnType<typeof state>> | null } = { afterChange: null }
    const takeovers = new WeakSet<object>()
    let changed = false
    const observed = observedPool(pool, async (sql, _values, client, execute) => {
      const result = await execute()
      if (sql.includes('AS deadline_expired')) {
        assert.equal(result.rows.find(row => row.id === f.operationId)?.deadline_expired, true)
        takeovers.add(client)
      }
      if (sql === 'COMMIT' && takeovers.has(client) && !changed) {
        changed = true
        await pool.query("UPDATE durable_runtime.operations SET deadline_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [f.operationId])
        observation.afterChange = await state(pool, f)
      }
      return result
    })
    const result = await runControllerPass(observed, session, options)
    assert.equal(result.status, 'FINISHED')
    assert.ok(result.items.some(item => item.identity === f.operationId && item.disposition === 'DEADLINE_NOT_EXPIRED'))
    const afterChange = observation.afterChange
    assert.ok(afterChange)
    const after = await state(pool, f)
    assert.deepEqual(after.unit, afterChange.unit)
    assert.deepEqual(after.operation, afterChange.operation)
    assert.deepEqual(after.sessions, afterChange.sessions)
    assert.deepEqual(after.binding, afterChange.binding)
    assert.deepEqual(after.counts, { ...afterChange.counts, expiry_receipts: '1' })
  })

  await t.test('expiry-only candidates consume the original finite work budget', async () => {
    const a = await seed(pool, true), b = await seed(pool, true)
    // These new fixture deadlines precede all clock-relative DB case seeds.
    // The real unfiltered takeover order therefore makes the budget assertion
    // deterministic without a fake scope/snapshot or touching earlier rows.
    await pool.query("UPDATE durable_runtime.operations SET deadline_at='2000-01-01T00:00:00Z' WHERE id=$1", [a.operationId])
    await pool.query("UPDATE durable_runtime.operations SET deadline_at='2000-01-02T00:00:00Z' WHERE id=$1", [b.operationId])
    const result = await runControllerPass(pool, session, { ...options, maximumWork: 1 })
    assert.equal(result.status, 'FINISHED')
    assert.equal(result.reason, 'WORK_BUDGET')
    assert.equal(result.items.filter(item => item.disposition === 'DEADLINE_EXPIRED').length, 1)
    const states = await Promise.all([state(pool, a), state(pool, b)])
    assert.equal(states.filter(value => value.operation.step === 'FAILED').length, 1)
    assert.equal(states.filter(value => value.operation.step === 'INTENT_QUEUED').length, 1)
    assert.equal(states.reduce((sum, value) => sum + Number(value.counts.commands), 0), 0)
  })

}

test('planner-independent WAKE expiry shares one actual controller session across DB and pass cases', async t => {
  if (process.env.ORCA_UNHANDLED_WAKE_APPROVED !== 'root-first-verification' || database !== 'orca_unhandled_wake_expiry_20261016' ||
      process.env.PGDATABASE !== database || !databaseOid || !/^[1-9][0-9]*$/.test(databaseOid) || ['92238', '16384'].includes(databaseOid) || !evidenceDirectory || !path.isAbsolute(evidenceDirectory) ||
      !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error('Root-approved existing isolated DB/current lease policy/evidence directory required')
  }
  const pool = createDurablePool({ database, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 5000,
    application_name: 'unhandled-wake-expiry-shared-session-first' })
  const session = new ControllerLeaseSession(pool, new ControllerInstance(CONTROLLER_SCOPE),
    { revision: 'unhandled-wake-expiry-fixture-v1', durationMs: leaseDurationMs })
  let confirmed: LeaseRecord | null = null, released = false, poolEnded = false, releaseErrorCode: string | null = null
  const evidence = (name: string, value: unknown) => writeFile(path.join(evidenceDirectory, name),
    JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  t.after(async () => {
    try {
      if (confirmed) {
        const via = session.lease ? 'session.release' : 'releaseControllerLease-original-confirmed-instance'
        const result = session.lease ? await session.release() : await releaseControllerLease(pool, session.instance, confirmed)
        released = result.status === 'RELEASED'
        await evidence('lease-release.private.json', { phase: 'RELEASE', at: new Date().toISOString(), pid: process.pid, via, result })
        assert.equal(result.status, 'RELEASED')
      }
    } catch (error) { releaseErrorCode = error instanceof Error ? error.name : 'RELEASE_FAILURE'; throw error }
    finally {
      try { await pool.end(); poolEnded = true }
      finally { await evidence('lease-cleanup.private.json', { phase: 'CLEANUP', at: new Date().toISOString(), pid: process.pid,
        acquired: confirmed !== null, released, poolEnded, releaseErrorCode }) }
    }
  })
  const actual = await withDurableTransaction(pool, async tx => {
    const row = (await tx.query(`SELECT current_database() AS database,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS pid`)).rows[0]
    assert.equal(row.database, database); assert.equal(row.oid, databaseOid); assert.equal(row.system, '7696101282789175327')
    assert.deepEqual((await tx.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows, [{ dataset_name: CONTROLLER_DATASET }])
    return row
  })
  const acquired = await session.acquire()
  if (acquired.status === 'ACTIVE') confirmed = acquired.lease
  await evidence('lease-acquire.private.json', { phase: 'ACQUIRE', at: new Date().toISOString(), pid: process.pid, result: acquired })
  assert.equal(acquired.status, 'ACTIVE')
  if (acquired.status !== 'ACTIVE') throw new Error('Actual normal session acquisition required')
  assert.equal(acquired.transition, 'ACQUIRED')
  const current = await session.assertCurrent(pool, acquired.lease, new AbortController().signal)
  await evidence('lease-assert-current.private.json', { phase: 'ASSERT_CURRENT', at: new Date().toISOString(), pid: process.pid, lease: current })
  // Same fixture-only assertion convention as command-context.pg.test.mts.
  // Actual acquire/assertCurrent above and the original gateway validate PG;
  // this nominal type is not the private worker issuer or production auth proof.
  const controller = Object.freeze({ scope: current.scope, owner: current.owner, term: current.term }) as unknown as VerifiedControllerIdentity
  // A dedicated empty DB plus this order prevents the DB counterexample rows
  // from becoming candidates in a later global pass. No snapshot/session filter.
  await runUnhandledWakeExpiryPassCases(t, pool, session, controller)
  await session.assertCurrent(pool, acquired.lease, new AbortController().signal)
  await runInitialWakeExpiryCases(t, pool, controller, {
    database, oid: databaseOid, system: '7696101282789175327' })
  // The DB cases cover stale lease/CAS directly. Do not run another pass here.
  t.diagnostic(JSON.stringify({ databaseOid: actual.oid, system: actual.system, backendPid: actual.pid,
    actualSessionAcquireCalls: 1, forcedLeaseChanges: 0, fakeSession: false, providerCalls: 0, podCalls: 0,
    productionAuthenticationVerified: false, physicalFencingVerified: false }))
})
