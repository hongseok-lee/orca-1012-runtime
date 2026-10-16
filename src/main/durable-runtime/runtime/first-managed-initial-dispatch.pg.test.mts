import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool } from '../db/connection.ts'
import { readMigrations } from '../db/migrate.ts'
import { CONTROLLER_SCOPE } from '../ha/instance.ts'
import { createControllerWorker, type ControllerWorker } from '../ha/worker.ts'
import { until } from '../ha/worker-fixtures.mts'
import type { CommandClaim, GatewayContext } from './gateway/types.ts'
import { harness } from './kubernetes-pod-auth-fixtures.mts'
import { createFirstManagedInitialDispatch } from './first-managed-initial-dispatch.ts'
import { prepareAgentPodPlan } from './agent-pod-plan-records.ts'
import { dispatchFixture, composerPool } from './first-managed-initial-dispatch-fixtures.mts'
import { requireInitialFixtureDatabase } from '../storage/first-managed-initial-fixtures.mts'

// Source only until Root assigns the existing isolated SQL23 DB and first slot.
const database = process.env.ORCA_FIRST_MANAGED_DISPATCH_DATABASE, oid = process.env.ORCA_FIRST_MANAGED_DISPATCH_DATABASE_OID
const system = process.env.ORCA_FIRST_MANAGED_DISPATCH_SYSTEM, migrationsPath = process.env.ORCA_FIRST_MANAGED_DISPATCH_MIGRATIONS
if (process.env.ORCA_FIRST_MANAGED_DISPATCH_APPROVED !== 'root-first-verification' ||
    !database || database === 'orca_dev' || !/^orca_[a-z0-9_]+$/u.test(database) || database !== process.env.PGDATABASE ||
    !oid || !/^[1-9][0-9]*$/u.test(oid) || !system || !/^[1-9][0-9]*$/u.test(system) || !migrationsPath) {
  throw new Error('Root-approved existing isolated SQL23 database/system/OID/ledger required')
}
const pool = createDurablePool({ database, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000,
  application_name: 'first-managed-dispatch-first' })
const expected = { database, oid, system }
const tables = ['agents', 'workspaces', 'sessions', 'runtime_units', 'runtime_members', 'runtime_member_storage_bindings',
  'operations', 'runtime_commands', 'runtime_command_history', 'rpc_receipts', 'agent_pod_plans', 'resource_profiles',
  'resource_unit_state', 'resource_reservations', 'attempts', 'execution_grants', 'storage_domains', 'storage_bindings',
  'storage_namespace_profiles', 'storage_namespace_holds', 'storage_write_grants', 'storage_mounts', 'runtime_audit_events', 'outbox_events'] as const
const workerPolicy = { lease: { revision: 'first-managed-dispatch-fixture', durationMs: 60000 },
  renewIntervalMs: 10000, standbyPollIntervalMs: 1000, passPollIntervalMs: 1000, maximumWork: 1000, externalBudgetMs: 60000 }
async function rows() {
  const result: Record<string, string[]> = {}
  for (const table of tables) {
    result[table] = (await pool.query<{ body: string }>(`SELECT to_jsonb(t)::text AS body FROM durable_runtime.${table} t`)).rows
      .map(row => createHash('sha256').update(row.body).digest('hex')).sort()
  }
  return result
}
type Seed = Awaited<ReturnType<typeof dispatchFixture>>
async function requireUnused(f: Seed) {
  for (const table of ['attempts', 'execution_grants', 'resource_unit_state']) {
    assert.equal((await pool.query(`SELECT 1 FROM durable_runtime.${table} WHERE runtime_unit_id=$1`, [f.plan.identity.unitId])).rowCount, 0)
  }
  assert.equal((await pool.query('SELECT 1 FROM durable_runtime.storage_namespace_holds WHERE id=$1', [f.config.pinId])).rowCount, 0)
}
async function originalAuditPreserved(f: Seed) {
  assert.deepEqual((await pool.query('SELECT to_jsonb(a) AS body FROM durable_runtime.runtime_audit_events a WHERE id=$1',
    [f.config.originalAuditId])).rows[0].body, f.auditBefore)
}

await test('fixed managed callbacks preserve the original worker context and settled boundaries', async t => {
  t.after(() => pool.end())
  await requireInitialFixtureDatabase(pool, expected)
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  const migrations = await readMigrations(migrationsPath)
  assert.equal(migrations.length, 23)
  assert.deepEqual(ledger.map(row => [row.version, row.checksum]), migrations.map(row => [row.version, row.checksum]))
  const lease = (await pool.query('SELECT expires_at>clock_timestamp() AS live FROM durable_runtime.controller_leases WHERE scope=$1', [CONTROLLER_SCOPE])).rows[0]
  assert.notEqual(lease?.live, true, 'Root must allocate an absent/expired isolated controller lease; never force expiry')
  const before = await rows()

  await t.test('real worker supplies claim/context; plan/profile settle before fresh owner; original lookup is GET-only', async () => {
    const f = await dispatchFixture(pool, expected), db = composerPool(pool)
    const wire = harness([{ status: 404 }, { status: 201, body: f.observedPod }, { body: f.observedPod }])
    const httpRequest = wire.transport.request.bind(wire.transport), collectRequest = f.fresh.wire.dependencies.https.request.bind(f.fresh.wire.dependencies.https)
    const checkSettled = () => {
      assert.equal(db.active.size, 0)
      for (const event of ['COMMIT1', 'CLEANUP1', 'COMMIT2', 'CLEANUP2']) { assert.ok(db.events.includes(event)) }
    }
    const dispatch = createFirstManagedInitialDispatch({ ...f.config, pool: db.pool,
      readOwnerToken: f.config.readOwnerToken.bind(f.config) }, { request(...args: Parameters<typeof httpRequest>) {
      checkSettled(); return httpRequest(...args)
    } }, { ...f.fresh.wire.dependencies, https: { request(...args: Parameters<typeof collectRequest>) {
      checkSettled(); return collectRequest(...args)
    } } })
    const captured: { claim: CommandClaim | null; context: Readonly<GatewayContext> | null; executes: number; lookups: number } =
      { claim: null, context: null, executes: 0, lookups: 0 }
    const keys: string[] = []
    const worker = createControllerWorker(pool, workerPolicy, {
      planStep(operation, unit) {
        const count = db.connects, step = dispatch.planStep(operation, unit)
        if (step) {
          assert.equal(dispatch.planStep({ ...operation, kind: 'SLEEP' }, unit), null)
          assert.equal(dispatch.planStep(operation, { ...unit, id: randomUUID() }), null)
          assert.equal(dispatch.planStep({ ...operation, external_resource_name: 'different-resource' }, unit), null)
          const again = dispatch.planStep(operation, unit); assert.ok(again)
          assert.notEqual(step.mutationKey, again.mutationKey)
          assert.deepEqual(step.input, again.input); assert.equal(step.step, 'ENSURE_ATTEMPT')
          assert.deepEqual(step.input, { mode: 'COLD', planDigest: prepareAgentPodPlan(f.plan).planDigest,
            attemptId: f.plan.identity.attemptId, resourceProfileRevision: '0' })
          keys.push(step.mutationKey)
        }
        assert.equal(db.connects, count, 'pure selection performs no DB call')
        return step
      },
      async executeCommitted(claim, signal, context) {
        captured.claim = claim; captured.context = context; captured.executes++
        assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.controller))
        assert.equal(claim.controllerTerm, context.controller.term)
        assert.equal(context.runtimeUnitId, f.plan.identity.unitId); assert.equal(context.operationId, f.plan.identity.operationId)
        await dispatch.executeCommitted(claim, signal, context)
        assert.equal(dispatch.snapshot().status, 'FINISHED')
        assert.equal(dispatch.snapshot().preparationOutcome, 'RESERVED'); assert.equal(dispatch.snapshot().pinState, 'RELEASED')
      },
      async lookupOriginal(command, signal, context) {
        const original = captured.claim; assert.ok(original)
        assert.equal(command.id, original.commandId); assert.equal(command.execution_token, original.executionToken)
        assert.equal(command.original_controller_term, original.identity.originalEnvelope.controllerTerm)
        const connections = db.connects, collectorRequests = f.fresh.wire.api.requests.length, tokenReads = f.tokenReads
        await dispatch.lookupOriginal(command, signal, context)
        assert.equal(db.connects, connections + 2, 'lookup uses target and assignment transactions only')
        assert.equal(f.fresh.wire.api.requests.length, collectorRequests); assert.equal(f.tokenReads, tokenReads)
        assert.equal(dispatch.snapshot().createRequested, false); captured.lookups++
      },
    })
    try {
      assert.equal(worker.start(), true)
      await until(() => captured.lookups === 1 && worker.snapshot().lastPass?.items.some(item => item.disposition === 'LOOKUP_ORIGINAL') === true)
    } finally { await worker.stop() }
    assert.equal(captured.executes, 1); assert.equal(captured.lookups, 1); assert.equal(f.tokenReads, 1)
    assert.equal(new Set(keys).size, keys.length); assert.ok(keys.length >= 2)
    assert.deepEqual(wire.requests.map(row => row.options.method), ['GET', 'POST', 'GET'])
    assert.equal(wire.requests[1].request.body, JSON.stringify(f.plan.pod))
    const snapshot = dispatch.snapshot()
    assert.equal(snapshot.gate, 'CLOSED'); assert.equal(snapshot.providerReady, false); assert.equal(snapshot.writerGrantActivated, false)
    assert.equal(snapshot.assignment?.disposition, 'REPLAYED'); assert.equal(db.active.size, 0); assert.equal(db.ends, 0)
    const claim = captured.claim; assert.ok(claim)
    for (const secret of [f.ownerToken, claim.executionToken, f.f.issued, f.f.reviewerToken]) { assert.equal(JSON.stringify(snapshot).includes(secret), false) }
    await originalAuditPreserved(f); wire.assertCleanup(); await f.fresh.wire.assertCleanup(); await f.f.wire.assertCleanup()
  })

  for (const scenario of ['PLAN_UNKNOWN', 'PROFILE_UNKNOWN', 'PROFILE_CLEANUP', 'ABORT_AFTER_PROFILE', 'WRONG_CLAIM', 'WRONG_CONTEXT'] as const) {
    await t.test(`${scenario}: no later owner, token reader or Pod request`, async () => {
      const f = await dispatchFixture(pool, expected), wire = harness([])
      let worker: ControllerWorker | null = null, calls = 0, callbackSettled = false
      const fault = scenario === 'PLAN_UNKNOWN' ? { ordinal: 1, kind: 'COMMIT_UNKNOWN' } as const :
        scenario === 'PROFILE_UNKNOWN' ? { ordinal: 2, kind: 'COMMIT_UNKNOWN' } as const :
          scenario === 'PROFILE_CLEANUP' ? { ordinal: 2, kind: 'CLEANUP' } as const : null
      const db = composerPool(pool, fault, scenario === 'ABORT_AFTER_PROFILE' ? () => { void worker?.stop() } : undefined)
      const dispatch = createFirstManagedInitialDispatch({ ...f.config, pool: db.pool,
        readOwnerToken: f.config.readOwnerToken.bind(f.config) }, wire.transport, f.fresh.wire.dependencies)
      worker = createControllerWorker(pool, workerPolicy, { planStep: dispatch.planStep,
        async executeCommitted(claim, signal, context) {
          calls++
          try {
            await dispatch.executeCommitted(scenario === 'WRONG_CLAIM' ? { ...claim,
              identity: { ...claim.identity, command: 'fenceAttempt' } } : claim, signal,
            scenario === 'WRONG_CONTEXT' ? { ...context, runtimeUnitId: logicalId('runtime-unit', randomUUID()) } : context)
          } finally { callbackSettled = true }
        }, lookupOriginal: dispatch.lookupOriginal })
      try {
        assert.equal(worker.start(), true)
        await until(() => worker?.snapshot().phase === 'STOPPED' && callbackSettled)
      } finally { await worker.stop() }
      const snapshot = dispatch.snapshot()
      assert.equal(calls, 1); assert.equal(snapshot.status, 'FAILED')
      assert.equal(f.tokenReads, 0); assert.equal(f.fresh.wire.api.requests.length, 0); assert.equal(wire.requests.length, 0)
      assert.equal(snapshot.preparationOutcome, null); assert.equal(snapshot.createRequested, false)
      assert.equal(db.active.size, 0); assert.equal(db.ends, 0)
      if (scenario === 'PLAN_UNKNOWN') { assert.equal(db.connects, 1); assert.equal(snapshot.plan?.commitOutcome, 'UNKNOWN'); assert.equal(snapshot.profile, null) }
      if (scenario === 'PROFILE_UNKNOWN') { assert.equal(db.connects, 2); assert.equal(snapshot.profile?.commitOutcome, 'UNKNOWN') }
      if (scenario === 'PROFILE_CLEANUP') { assert.equal(db.connects, 2); assert.equal(snapshot.profile?.settlement, 'COMMITTED'); assert.equal(snapshot.profile?.cleanupFailed, true) }
      if (scenario === 'ABORT_AFTER_PROFILE') { assert.equal(db.connects, 2); assert.equal(snapshot.errorCode, 'FIRST_MANAGED_DISPATCH_ABORTED') }
      if (scenario === 'WRONG_CLAIM' || scenario === 'WRONG_CONTEXT') { assert.equal(db.connects, 0) }
      await requireUnused(f); await originalAuditPreserved(f); wire.assertCleanup(); await f.fresh.wire.assertCleanup(); await f.f.wire.assertCleanup()
    })
  }
  await requireInitialFixtureDatabase(pool, expected)
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  const after = await rows()
  for (const table of tables) { for (const original of before[table]) { assert.ok(after[table].includes(original), `original ${table} row changed`) } }
})
