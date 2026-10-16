import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from '../db/connection.ts'
import { readMigrations } from '../db/migrate.ts'
import { LockedGatewayAuthority } from '../runtime/gateway/authority.ts'
import { submitCommand, originalIdentity } from '../runtime/gateway/store.ts'
import { claimCommand, markCommandUnknown } from '../runtime/gateway/claim.ts'
import { inputDigest } from '../runtime/gateway/input.ts'
import type { VerifiedControllerIdentity } from '../runtime/gateway/types.ts'
import type { PayloadHash } from '../runtime/runtime-evidence.ts'
import { createAgentPodPlanner } from '../runtime/agent-pod-plan.ts'
import { recordAgentPodPlan } from '../runtime/agent-pod-plan-records.ts'
import { prepareReconcileStep } from './controller.ts'
import { ensureIntentOperation, LIFECYCLE_CONTROLLER_SCOPE, requestUnitIntent } from './intent.ts'
import { joinPendingUnitIntent } from './pending.ts'
import { lockUnitMembers } from './locks.ts'
import { readUnitProjection } from './projection.ts'
import { executor, fixture, intent, policy, stoppedMetadataAttempt } from './verification-fixtures.mts'

// Root allocates the existing isolated SQL23 DB/current lease. No schema/reset,
// controller acquisition, provider call, physical proof or live activation here.
const database = process.env.ORCA_DEADLINE_DATABASE, oid = process.env.ORCA_DEADLINE_DATABASE_OID
const migrationsPath = process.env.ORCA_DEADLINE_MIGRATIONS
const owner = process.env.ORCA_DEADLINE_CONTROLLER_OWNER, term = process.env.ORCA_DEADLINE_CONTROLLER_TERM
if (process.env.ORCA_DEADLINE_APPROVED !== 'root-first-verification' || database !== 'orca_execution_targets_20261015' ||
    process.env.PGDATABASE !== database || oid !== '92238' || !migrationsPath || !owner || !term) {
  throw new Error('Root-approved isolated SQL23 database/OID/current lease inputs required')
}
// Fixture-only nominal identity; actual same-Pool lease validation precedes seed.
// This does not issue production authority or authenticate a provider.
const controller = Object.freeze({ scope: LIFECYCLE_CONTROLLER_SCOPE, owner,
  term: counter('controller-term', term) }) as unknown as VerifiedControllerIdentity
const pool = createDurablePool({ database, max: 3, application_name: 'operation-deadline-terminal-first' })
const kind = 'RECONCILE_OPERATION_DEADLINE_EXPIRED'
const reason = 'DEADLINE_EXPIRED_BEFORE_ACCEPTANCE'
const failure = (code: string) => (error: unknown) => error instanceof DurableDatabaseError && error.code === code
type Fixture = Awaited<ReturnType<typeof fixture>>
async function seed() {
  const f = await fixture(pool, 1), request = await intent(pool, f)
  assert.equal((await requestUnitIntent(pool, request)).status, 'COMMITTED')
  const op = (await pool.query('SELECT * FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])).rows[0]
  const context = { runtimeUnitId: f.unit, operationId: logicalId('operation', op.id), controller }
  return { ...f, request, context }
}
type Seed = Awaited<ReturnType<typeof seed>>
async function expire(f: Seed) {
  // Synthetic expiry of this callback's newly inserted operation only. The
  // resulting original deadline/retry is captured before the product call.
  await pool.query(`UPDATE durable_runtime.operations SET deadline_at=clock_timestamp()-interval '1 minute',
    retry_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [f.context.operationId])
}
async function prepare(f: Seed) {
  const unit = (await pool.query('SELECT revision,intent_revision FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows[0]
  const op = (await pool.query('SELECT step_revision FROM durable_runtime.operations WHERE id=$1', [f.context.operationId])).rows[0]
  return { context: f.context, mutationKey: randomUUID(), expectedUnitRevision: counter('row:runtime-unit', unit.revision),
    expectedIntentRevision: counter('intent-revision', unit.intent_revision), expectedStepRevision: counter('step-revision', op.step_revision),
    step: 'ENSURE_ATTEMPT' as const, executorId: executor, input: {} }
}
async function snapshot(f: Fixture) {
  const result: Record<string, unknown> = {}
  const scopes = {
    runtime_units: ['id=$1', [f.unit]], operations: ['runtime_unit_id=$1', [f.unit]],
    runtime_commands: ['runtime_unit_id=$1', [f.unit]], agent_pod_plans: ['runtime_unit_id=$1', [f.unit]],
    attempts: ['runtime_unit_id=$1', [f.unit]], execution_grants: ['runtime_unit_id=$1', [f.unit]],
    resource_profiles: ['runtime_unit_id=$1', [f.unit]], storage_write_grants: ['storage_binding_id=$1', [f.binding]],
    storage_bindings: ['id=$1', [f.binding]], sessions: ['id=ANY($1::uuid[])', [f.sessions]],
    runtime_audit_events: ['runtime_unit_id=$1', [f.unit]],
    outbox_events: ['aggregate_id=ANY($1::uuid[])', [[f.unit, ...f.sessions, ...
      (await pool.query('SELECT id FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])).rows.map(r => r.id)]]],
    rpc_receipts: ['session_scope=ANY($1::text[])', [[`fixture-unit:${f.unit}`, `runtime-unit:${f.unit}`]]]
  } as const
  for (const [table, [where, values]] of Object.entries(scopes)) {
    result[table] = (await pool.query(`SELECT to_jsonb(t)::text AS body FROM durable_runtime.${table} t WHERE ${where} ORDER BY body`, [...values])).rows
  }
  return result
}
async function fixed(f: Seed) {
  return (await pool.query(`SELECT id,runtime_unit_id,kind,intent_revision,execution_epoch,expected_pod_uid,
    external_resource_name,deadline_at::text,retry_at::text,controller_scope,controller_term
    FROM durable_runtime.operations WHERE id=$1`, [f.context.operationId])).rows[0]
}
async function counts(f: Seed) {
  return (await pool.query(`SELECT
    (SELECT count(*)::text FROM durable_runtime.runtime_audit_events WHERE operation_id=$1 AND kind=$3) AS audit,
    (SELECT count(*)::text FROM durable_runtime.outbox_events WHERE aggregate_id=$2 AND event->>'kind'=$3) AS outbox,
    (SELECT count(*)::text FROM durable_runtime.rpc_receipts WHERE session_scope=$4 AND method='lifecycle.prepare-reconcile-step') AS receipts`,
  [f.context.operationId, f.unit, kind, `runtime-unit:${f.unit}`])).rows[0]
}
async function pending(f: Seed) {
  return withDurableTransaction(pool, tx => joinPendingUnitIntent(tx, {
    unitId: f.unit, actorId: 'deadline-fixture', discoveredMembers: f.sessions, policy }))
}
function failingPool(fragment: string): Pool {
  // Reviewed lifecycle fixture convention: actual client/transaction/ROLLBACK;
  // inject one SQL error, never replace the product callback or assertions.
  return new Proxy(pool, { get(target, key) {
    if (key === 'connect') {
      return async () => {
        const client = await target.connect()
        return new Proxy(client, { get(connection, field) {
          if (field === 'query') {
            return (sql: string, values: readonly unknown[] = []) =>
              connection.query(sql.includes(fragment) ? 'SELECT 1/0' : sql, sql.includes(fragment) ? [] : [...values])
          }
          const value = Reflect.get(connection, field)
          return typeof value === 'function' ? value.bind(connection) : value
        } })
      }
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
async function plan(f: Seed) {
  const leaf = randomUUID(), op = await fixed(f)
  const prepared = createAgentPodPlanner({ namespace: 'deadline-fixture', dataset: 'orca-1012-dev-v1',
    image: `example.invalid/agent@sha256:${'1'.repeat(64)}`,
    entrypoint: { command: ['/usr/local/bin/node'], args: ['-e', 'setInterval(() => {}, 3600000)'] },
    paths: { home: '/agent/home', claudeState: '/agent/home/.claude', codexState: '/agent/home/.codex', checkout: '/agent/project' },
    nfsServer: 'nfs.fixture.svc.cluster.local', protectedExportRoot: '/exports/runtime-domains/orca-1012-dev-v1',
    protectedMounts: [{ key: 'home', clientPath: '/agent' }], shared: { claimName: 'shared-fixture', claimUid: 'shared-claim',
      pvUid: 'shared-pv', serverPath: '/exports/shared/orca-1012-dev-v1' } }).plan({
    identity: { unitId: f.unit, operationId: f.context.operationId, attemptId: randomUUID(), executionEpoch: '0',
      intentRevision: '0', resourceName: op.external_resource_name, specHash: 'a'.repeat(64) },
    protectedBindings: [{ key: 'home', bindingId: f.binding, leafId: leaf, claimName: `protected-${leaf}`,
      claimUid: `claim-${leaf}`, pvUid: `pv-${leaf}`, serverPath: `/exports/runtime-domains/orca-1012-dev-v1/${leaf}`, mode: 'RW' }],
    profile: { revision: '0', cpuMilli: 100, memoryMi: 256, ephemeralMi: 256, temporaryMi: 64 } })
  await withDurableTransaction(pool, tx => recordAgentPodPlan(tx, f.context, prepared))
}

test('initial WAKE expiry is terminal only before every execution footprint and explicit reception renews it', async t => {
  t.after(() => pool.end())
  const actual = await withDurableTransaction(pool, async tx => {
    const row = (await tx.query(`SELECT current_database() AS database,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS backend_pid`)).rows[0]
    assert.equal(row.database, database); assert.equal(row.oid, oid); assert.equal(row.system, '7696101282789175327')
    assert.deepEqual((await tx.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows, [{ dataset_name: 'orca-1012-dev-v1' }])
    assert.equal((await tx.query(`SELECT scope FROM durable_runtime.controller_leases WHERE scope=$1 AND owner=$2
      AND term=$3 AND expires_at>clock_timestamp()`, [controller.scope, owner, term])).rowCount, 1)
    return row
  })
  t.diagnostic(`isolated identity ${JSON.stringify(actual)}`)
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  const migrations = await readMigrations(migrationsPath)
  assert.equal(ledger.length, 23)
  assert.deepEqual(ledger.map(({ version, checksum }) => ({ version, checksum })), migrations.map(({ version, checksum }) => ({ version, checksum })))
  const lease = (await pool.query('SELECT to_jsonb(c) AS body FROM durable_runtime.controller_leases c WHERE scope=$1', [controller.scope])).rows
  await t.test('expiry commits once; pending alone preserves terminal; new authenticated fixture key creates one operation', async () => {
    const f = await seed()
    // Additive synthetic pending Message; no input/authentication claim is made.
    await pool.query("INSERT INTO durable_runtime.messages(id,session_id,seq,body_or_blob_ref,intake_status) VALUES($1,$2,1,'{}','DURABLE')", [randomUUID(), f.sessions[0]])
    await expire(f)
    const original = await fixed(f), before = await snapshot(f), request = await prepare(f)
    const first = await prepareReconcileStep(pool, request)
    assert.equal(first.mutation.status, 'COMMITTED')
    assert.deepEqual(first.execution, { disposition: 'NO_EXECUTION', reason: 'DEADLINE_EXPIRED' })
    assert.equal(first.mutation.receipt.response && typeof first.mutation.receipt.response === 'object' &&
      'terminalRecorded' in first.mutation.receipt.response && first.mutation.receipt.response.terminalRecorded, true)
    const op = (await pool.query('SELECT step,step_revision,revision,result FROM durable_runtime.operations WHERE id=$1', [f.context.operationId])).rows[0]
    assert.deepEqual(op, { step: 'FAILED', step_revision: '1', revision: '1', result: { state: 'FAILED', reason } })
    assert.deepEqual(await fixed(f), original)
    const projection = await readUnitProjection(pool, f.unit)
    assert.equal(projection.unit.phase, 'BLOCKED'); assert.equal(projection.unit.revision, '2')
    assert.equal(projection.operations.length, 0)
    const after = await snapshot(f)
    for (const table of ['runtime_commands','agent_pod_plans','attempts','execution_grants','resource_profiles',
      'storage_write_grants','storage_bindings','sessions']) { assert.deepEqual(after[table], before[table]) }
    assert.deepEqual(await counts(f), { audit: '1', outbox: '1', receipts: '1' })
    const replay = await prepareReconcileStep(pool, request)
    assert.equal(replay.mutation.status, 'REPLAYED'); assert.equal(replay.execution.disposition, 'NO_EXECUTION')
    await assert.rejects(prepareReconcileStep(pool, await prepare(f)), failure('LIFECYCLE_STEP_STALE'))
    assert.deepEqual(await snapshot(f), after)
    const joined = await pending(f)
    assert.ok(joined); assert.equal(joined.blocked, true); assert.equal(joined.operation.id, f.context.operationId)
    assert.deepEqual(await snapshot(f), after)
    const ensured = await withDurableTransaction(pool, async tx => {
      await lockUnitMembers(tx, f.unit, f.sessions)
      const unit = (await tx.query<Parameters<typeof ensureIntentOperation>[1]>('SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows[0]
      return ensureIntentOperation(tx, unit, policy)
    })
    assert.equal(ensured.operation.id, f.context.operationId); assert.equal(ensured.blocked, true)
    const originalReplay = await requestUnitIntent(pool, f.request)
    assert.equal(originalReplay.status, 'REPLAYED'); assert.deepEqual(await snapshot(f), after)
    const next = await requestUnitIntent(pool, await intent(pool, f))
    assert.equal(next.status, 'COMMITTED')
    const active = (await pool.query('SELECT id,deadline_at::text AS deadline FROM durable_runtime.operations WHERE runtime_unit_id=$1 AND result IS NULL', [f.unit])).rows
    assert.equal(active.length, 1); assert.notEqual(active[0].id, f.context.operationId)
    await requestUnitIntent(pool, await intent(pool, f))
    assert.deepEqual((await pool.query('SELECT id,deadline_at::text AS deadline FROM durable_runtime.operations WHERE runtime_unit_id=$1 AND result IS NULL', [f.unit])).rows, active)
    const coalesced = await pending(f)
    assert.ok(coalesced); assert.equal(coalesced.blocked, false); assert.equal(coalesced.operation.id, active[0].id)
    assert.equal((await pool.query('SELECT id FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])).rowCount, 2)
    assert.deepEqual(await fixed(f), original); assert.deepEqual(await counts(f), { audit: '1', outbox: '1', receipts: '1' })
  })
  for (const state of ['ACCEPTED','EXECUTING','UNKNOWN'] as const) {
    await t.test(`expired ${state} command stays original lookup with unchanged identity/token`, async () => {
      const f = await seed()
      await withDurableTransaction(pool, async tx => {
        await lockUnitMembers(tx, f.unit, f.sessions)
        const authority = await LockedGatewayAuthority.acquire(tx, f.context)
        const result = await submitCommand(authority, { command: 'ensureAttempt', envelope: {
          operationId: f.context.operationId, controllerTerm: controller.term, stepRevision: counter('step-revision', '0'),
          executionEpoch: counter('execution-epoch', '0'), intentRevision: counter('intent-revision', '0'),
          // Computed digest branding only, not evidence or execution authority.
          podTarget: 'CREATE_WITHOUT_POD', expectedPodUid: null }, input: {}, inputHash: inputDigest({}) as PayloadHash, predecessor: { kind: 'NONE' } })
        assert.equal(result.disposition, 'ACCEPTED')
        if (state !== 'ACCEPTED') {
          const claimed = await claimCommand(authority, originalIdentity(result.command), executor)
          assert.equal(claimed.disposition, 'CLAIMED')
          if (claimed.disposition === 'CLAIMED' && state === 'UNKNOWN') { await markCommandUnknown(authority, claimed.claim) }
        }
      })
      await expire(f)
      const original = await fixed(f), before = await snapshot(f)
      assert.deepEqual((await prepareReconcileStep(pool, await prepare(f))).execution, { disposition: 'NO_EXECUTION', reason: 'LOOKUP_ORIGINAL' })
      const after = await snapshot(f)
      for (const table of ['operations','runtime_units','runtime_commands','attempts','storage_write_grants']) { assert.deepEqual(after[table], before[table]) }
      assert.equal((await requestUnitIntent(pool, await intent(pool, f))).status, 'COMMITTED')
      assert.equal((await pool.query('SELECT id FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])).rowCount, 1)
      assert.deepEqual(await fixed(f), original); assert.deepEqual(await counts(f), { audit: '0', outbox: '0', receipts: '1' })
    })
  }
  for (const footprint of ['past-attempt','plan','other-owner-writer','RESOLVED','REFUSED'] as const) {
    await t.test(`${footprint} prevents terminal inference without deleting any footprint`, async () => {
      const f = await seed()
      if (footprint === 'past-attempt') { await stoppedMetadataAttempt(pool, f, false) }
      if (footprint === 'plan') { await plan(f) }
      if (footprint === 'other-owner-writer') {
        const other = await fixture(pool, 1), attempt = await stoppedMetadataAttempt(pool, other, false)
        await pool.query('INSERT INTO durable_runtime.runtime_member_storage_bindings(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [other.unit, other.sessions[0], f.binding])
        await pool.query("UPDATE durable_runtime.storage_bindings SET identity_verified_at=clock_timestamp(),identity_proof_ref='synthetic-fixture-only' WHERE id=$1", [f.binding])
        await pool.query("INSERT INTO durable_runtime.storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch,state) VALUES($1,$2,$3,0,'ACTIVE')", [randomUUID(), f.binding, attempt.attempt])
      }
      if (footprint === 'RESOLVED' || footprint === 'REFUSED') {
        // Additive nonproduction terminal command row; no physical reconciliation proof.
        await pool.query(`INSERT INTO durable_runtime.runtime_commands(id,operation_id,runtime_unit_id,command_name,
          original_controller_term,step_revision,pod_target,execution_epoch,intent_revision,input_hash,input,state,
          owner_controller_term,settled_at,result,refusal_code) VALUES($1,$2,$3,'ensureAttempt',$4,0,'CREATE_WITHOUT_POD',0,0,$5,'{}',$6,$4,
          clock_timestamp(),$7::jsonb,$8)`, [randomUUID(), f.context.operationId, f.unit, term, inputDigest({}), footprint,
          footprint === 'RESOLVED' ? JSON.stringify({ synthetic: true }) : null, footprint === 'REFUSED' ? 'FIXTURE_ONLY' : null])
      }
      await expire(f)
      const before = await snapshot(f)
      assert.deepEqual((await prepareReconcileStep(pool, await prepare(f))).execution, { disposition: 'NO_EXECUTION', reason: 'DEADLINE_EXPIRED' })
      const after = await snapshot(f)
      for (const table of Object.keys(before).filter(name => name !== 'rpc_receipts')) { assert.deepEqual(after[table], before[table]) }
      assert.deepEqual(await counts(f), { audit: '0', outbox: '0', receipts: '1' })
    })
  }
  await t.test('stale owner/revision and failed outbox or receipt leave the whole pre-expiry tuple unchanged', async () => {
    const f = await seed(); await expire(f)
    const before = await snapshot(f), request = await prepare(f)
    await assert.rejects(prepareReconcileStep(pool, { ...request, context: { ...request.context,
      controller: { ...controller, owner: `${owner}-stale` } } }), failure('COMMAND_AUTHORITY_STALE'))
    await assert.rejects(prepareReconcileStep(pool, { ...request, expectedUnitRevision: counter('row:runtime-unit', '0') }), failure('LIFECYCLE_STEP_STALE'))
    for (const fragment of ['INSERT INTO durable_runtime.outbox_events','INSERT INTO durable_runtime.rpc_receipts']) {
      await assert.rejects(prepareReconcileStep(failingPool(fragment), request), failure('22012'))
      assert.deepEqual(await snapshot(f), before)
    }
  })
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  assert.deepEqual((await pool.query('SELECT to_jsonb(c) AS body FROM durable_runtime.controller_leases c WHERE scope=$1', [controller.scope])).rows, lease)
})
