import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from '../db/connection.ts'
import { applyMigrations, readMigrations } from '../db/migrate.ts'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createAgentPodPlanner } from './agent-pod-plan.ts'
import type { GatewayContext, VerifiedControllerIdentity } from './gateway/types.ts'
import { recordAgentPodPlan, readAgentPodPlan } from './agent-pod-plan-records.ts'

// Root supplies the existing isolated DB and SQL directory at the first run.
// No live DB selection, create/reset/drop or production authority is supplied.
const database = process.env.ORCA_AGENT_POD_PLANS_DATABASE
const oid = process.env.ORCA_AGENT_POD_PLANS_DATABASE_OID
const migrationsPath = process.env.ORCA_AGENT_POD_PLANS_MIGRATIONS
if (process.env.ORCA_AGENT_POD_PLANS_APPROVED !== 'root-first-verification' ||
  !database || !/^orca_[a-z0-9_]+$/.test(database) || database === 'orca_dev' ||
  database !== process.env.PGDATABASE || !oid || !/^[1-9][0-9]*$/.test(oid) || !migrationsPath) {
  throw new Error('Root-approved existing isolated database/OID and migration directory required')
}
const pool = createDurablePool({ database, max: 3, application_name: 'agent-pod-plan-records-first' })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const scope = `synthetic-agent-pod-plans:${randomUUID()}`
const owner = `synthetic-controller:${randomUUID()}`
// SAFETY: fixture-only nominal controller identity for synthetic SQL seeds.
// This is not a production identity issuer or authenticated external evidence.
const controller = Object.freeze({ scope, owner, term: counter('controller-term', '1') }) as VerifiedControllerIdentity
const rejectCode = (promise: Promise<unknown>, code: string) => assert.rejects(promise,
  error => error instanceof DurableDatabaseError && error.code === code)

// Narrow reuse of the reviewed pure planner fixture policy/request layout.
function policy() {
  return { namespace: 'agent-plan-record-fixture', dataset: 'orca-1012-dev-v1',
    image: `example.invalid/agent@sha256:${'1'.repeat(64)}`,
    entrypoint: { command: ['/opt/agent/entrypoint'], args: ['--resume-mode', 'cold', ''] },
    paths: { home: '/agent/home', claudeState: '/agent/home/.claude', codexState: '/agent/home/.codex', checkout: '/agent/project' },
    protectedMounts: [{ key: 'main', clientPath: '/agent' }], nfsServer: 'nfs.fixture.svc.cluster.local',
    protectedExportRoot: '/exports/runtime-domains/orca-1012-dev-v1',
    shared: { claimName: 'shared-fixture', claimUid: 'shared-claim-opaque', pvUid: 'shared-pv-opaque', serverPath: '/exports/shared/orca-1012-dev-v1' } }
}
function request() {
  const unitId = randomUUID(), operationId = randomUUID(), leafId = randomUUID()
  return { identity: { unitId, operationId, attemptId: randomUUID(), resourceName: `orca-unit-${operationId}`,
    executionEpoch: '3', intentRevision: '5', specHash: 'a'.repeat(64) },
    protectedBindings: [{ key: 'main', bindingId: randomUUID(), leafId, claimName: 'protected-fixture',
      claimUid: 'protected-claim-opaque', pvUid: 'protected-pv-opaque',
      serverPath: `/exports/runtime-domains/orca-1012-dev-v1/${leafId}`, mode: 'RW' }],
    profile: { revision: '7', cpuMilli: 777, memoryMi: 1024, ephemeralMi: 2048, temporaryMi: 256 } }
}
const context = (r: ReturnType<typeof request>): GatewayContext => Object.freeze({
  runtimeUnitId: logicalId('runtime-unit', r.identity.unitId), operationId: logicalId('operation', r.identity.operationId), controller
})
async function identity() {
  const row = (await pool.query<{ database: string; oid: string; system: string; backend_pid: number }>(
    `SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS backend_pid`)).rows[0]
  assert.equal(row.database, database); assert.equal(row.oid, oid); assert.equal(row.system, '7696101282789175327')
  assert.deepEqual((await pool.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows,
    [{ dataset_name: 'orca-1012-dev-v1' }])
  return row
}
const protectedTables = ['runtime_units','operations','attempts','execution_grants','runtime_members',
  'storage_bindings','storage_write_grants','storage_mounts','messages','input_components',
  'rpc_receipts','session_events','session_context_records','runtime_audit_events','outbox_events'] as const
async function rowHashes() {
  const rows: Record<string, string[]> = {}
  for (const table of protectedTables) {
    rows[table] = (await pool.query<{ body: string }>(`SELECT to_jsonb(t)::text AS body FROM durable_runtime.${table} t`)).rows.map(row => hash(row.body)).sort()
  }
  return rows
}
function retained(before: Record<string, string[]>, after: Record<string, string[]>) {
  for (const table of protectedTables) {
    const counts = new Map<string, number>()
    for (const item of after[table]) { counts.set(item, (counts.get(item) ?? 0) + 1) }
    for (const item of before[table]) { assert.ok((counts.get(item) ?? 0) > 0, `Original ${table} row missing`); counts.set(item, (counts.get(item) ?? 0) - 1) }
  }
}
async function history(operation: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::text FROM durable_runtime.agent_pod_plans WHERE operation_id=$1) AS plans,
    (SELECT count(*)::text FROM durable_runtime.runtime_audit_events WHERE operation_id=$1 AND kind='AGENT_POD_PLAN_RECORDED') AS audit,
    (SELECT count(*)::text FROM durable_runtime.outbox_events WHERE event->>'operationId'=$1) AS outbox`, [operation])).rows[0]
}

await test('Agent Pod plan records: first023 immutable plan, exact replay and authority boundaries', async t => {
  t.after(() => pool.end())
  const firstIdentity = await identity() // Same Pool actual system/OID/dataset before DDL or seed.
  const migrations = await readMigrations(migrationsPath)
  assert.equal(migrations.length, 23); assert.equal(migrations[22].version, '023-agent-pod-plans.sql')
  const ledgerBefore = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledgerBefore.length, 22)
  assert.deepEqual(ledgerBefore.map(row => [row.version, row.checksum]), migrations.slice(0, 22).map(row => [row.version, row.checksum]))
  assert.equal((await pool.query("SELECT to_regclass('durable_runtime.agent_pod_plans') IS NULL AS absent")).rows[0].absent, true)
  const originals = await rowHashes(), applied = await applyMigrations(pool, migrations)
  assert.equal(applied.length, 23); assert.deepEqual(applied.slice(0, 22), ledgerBefore)
  const seedIdentity = await identity(), a = request(), b = request(), c = request()
  await withDurableTransaction(pool, async tx => {
    await tx.query(`INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at)
      VALUES($1,$2,1,clock_timestamp()+interval '5 minutes')`, [scope, owner])
    for (const value of [a,b,c]) {
      await tx.query(`INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase,execution_epoch,intent_revision)
        VALUES($1,'RUNNING','ABSENT',3,5)`, [value.identity.unitId])
      await tx.query(`INSERT INTO durable_runtime.operations
        (id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch,external_resource_name)
        VALUES($1,$2,'WAKE',5,$3,1,'ENSURE_ATTEMPT',3,$4)`,
      [value.identity.operationId, value.identity.unitId, scope, value.identity.resourceName])
    }
  })
  const seedRows = async () => (await pool.query<{ body: string }>(`SELECT to_jsonb(u)::text AS body FROM durable_runtime.runtime_units u WHERE id=ANY($1::uuid[])
    UNION ALL SELECT to_jsonb(o)::text FROM durable_runtime.operations o WHERE id=ANY($2::uuid[])
    UNION ALL SELECT to_jsonb(c)::text FROM durable_runtime.controller_leases c WHERE scope=$3`,
  [[a,b,c].map(r => r.identity.unitId),[a,b,c].map(r => r.identity.operationId),scope])).rows.map(row => hash(row.body)).sort()
  const seedBefore = await seedRows(), planner = createAgentPodPlanner(policy()), plan = planner.plan(a)
  const recorded = await withDurableTransaction(pool, tx => recordAgentPodPlan(tx, context(a), plan))
  assert.equal(recorded.disposition, 'RECORDED'); assert.deepEqual(recorded.record.plan, plan)
  assert.ok(Object.isFrozen(recorded)); assert.ok(Object.isFrozen(recorded.record)); assert.ok(Object.isFrozen(recorded.record.plan.pod.spec.containers))
  assert.equal(new Date(recorded.record.recordedAt).toISOString(), recorded.record.recordedAt)
  assert.equal(recorded.record.plan.kind, 'UNAUTHORIZED_PLAN'); assert.equal(recorded.record.plan.storageGrantIssued, false)
  assert.equal(recorded.record.plan.physicalPinIssued, false); assert.equal(recorded.record.plan.readinessObserved, false)
  const replayed = await withDurableTransaction(pool, tx => recordAgentPodPlan(tx, context(a), plan))
  assert.equal(replayed.disposition, 'REPLAYED'); assert.deepEqual(replayed.record, recorded.record)
  assert.deepEqual(await withDurableTransaction(pool, tx => readAgentPodPlan(tx, context(a).operationId)), recorded.record)
  assert.deepEqual(await history(a.identity.operationId), { plans:'1', audit:'1', outbox:'1' })
  const changedClaim = structuredClone(a); changedClaim.protectedBindings[0].claimUid = 'different-protected-claim'
  const changedProfile = structuredClone(a); changedProfile.profile.cpuMilli = 888
  const changedPolicy = policy(); changedPolicy.entrypoint.command = ['/opt/agent/other-entrypoint']
  for (const other of [planner.plan(changedClaim),planner.plan(changedProfile),createAgentPodPlanner(changedPolicy).plan(a)]) {
    await rejectCode(withDurableTransaction(pool, tx => recordAgentPodPlan(tx, context(a), other)), 'AGENT_POD_PLAN_CONFLICT')
  }
  const stale: GatewayContext = { ...context(b), controller: { ...controller, term: counter('controller-term', '0') } }
  await rejectCode(withDurableTransaction(pool, tx => recordAgentPodPlan(tx, stale, planner.plan(b))), 'COMMAND_AUTHORITY_STALE')
  await rejectCode(withDurableTransaction(pool, tx => recordAgentPodPlan(tx, context(b), plan)), 'AGENT_POD_PLAN_SCOPE')
  const wrongName = structuredClone(b); wrongName.identity.resourceName = 'wrong-original-resource-name'
  await rejectCode(withDurableTransaction(pool, tx => recordAgentPodPlan(tx, context(b), planner.plan(wrongName))), 'AGENT_POD_PLAN_STALE')
  const duplicateAttempt = structuredClone(b); duplicateAttempt.identity.attemptId = a.identity.attemptId
  await rejectCode(withDurableTransaction(pool, tx => recordAgentPodPlan(tx, context(b), planner.plan(duplicateAttempt))), 'AGENT_POD_PLAN_CONFLICT')
  // Non-production malformed candidate on this fixture's new operation only.
  // Keep the key present but set its JSON value to null; immutable history and
  // all original rows/triggers remain untouched.
  const bPlan = planner.plan(b)
  await rejectCode(withDurableTransaction(pool, tx => tx.query(`INSERT INTO durable_runtime.agent_pod_plans
    (operation_id,runtime_unit_id,dataset_name,attempt_id,execution_epoch,intent_revision,namespace,resource_name,spec_hash,pod_spec_sha256,plan_digest,plan)
    VALUES($1,$2,'orca-1012-dev-v1',$3,3,5,$4,$5,$6,$7,$8,jsonb_set($9::jsonb,'{identity,operationId}','null'::jsonb))`,
  [b.identity.operationId,b.identity.unitId,b.identity.attemptId,bPlan.pod.metadata.namespace,b.identity.resourceName,
    b.identity.specHash,bPlan.podSpecSHA256,'b'.repeat(64),JSON.stringify(bPlan)])), '23514')
  assert.deepEqual(await history(b.identity.operationId), { plans:'0', audit:'0', outbox:'0' })
  let getters = 0
  const getterPlan = structuredClone(plan)
  Object.defineProperty(getterPlan, 'pod', { get() { getters++; throw new Error('fixture getter must not execute') } })
  await rejectCode(withDurableTransaction(pool, tx => recordAgentPodPlan(tx, context(a), getterPlan)), 'AGENT_POD_PLAN_INPUT_INVALID')
  assert.equal(getters, 0)
  for (const field of ['storageGrantIssued','physicalPinIssued','readinessObserved']) {
    const forged = structuredClone(plan); Object.defineProperty(forged, field, { value:true })
    await rejectCode(withDurableTransaction(pool, tx => recordAgentPodPlan(tx, context(a), forged)), 'AGENT_POD_PLAN_INPUT_INVALID')
  }
  const wrongDigest = structuredClone(plan); Object.defineProperty(wrongDigest, 'podSpecSHA256', { value:'0'.repeat(64) })
  await rejectCode(withDurableTransaction(pool, tx => recordAgentPodPlan(tx, context(a), wrongDigest)), 'AGENT_POD_PLAN_INPUT_INVALID')
  const cPlan = planner.plan(c)
  await rejectCode(withDurableTransaction(pool, async tx => {
    assert.equal((await recordAgentPodPlan(tx, context(c), cPlan)).disposition, 'RECORDED')
    throw new DurableDatabaseError('PLAN_FIXTURE_ROLLBACK')
  }), 'PLAN_FIXTURE_ROLLBACK')
  assert.equal(await withDurableTransaction(pool, tx => readAgentPodPlan(tx, context(c).operationId)), null)
  assert.deepEqual(await history(c.identity.operationId), { plans:'0', audit:'0', outbox:'0' })
  const mutablePlan = structuredClone(cPlan), mutableContext: GatewayContext = { ...context(c), controller: { ...controller } }
  const captured = await withDurableTransaction(pool, async tx => {
    const pending = recordAgentPodPlan(tx, mutableContext, mutablePlan)
    Object.defineProperty(mutablePlan, 'storageGrantIssued', { value:true })
    Object.defineProperty(mutableContext.controller, 'owner', { value:'changed-after-first-await' })
    return pending
  })
  assert.deepEqual(captured.record.plan, cPlan)
  for (const sql of ['UPDATE durable_runtime.agent_pod_plans SET plan=plan WHERE operation_id=$1',
    'DELETE FROM durable_runtime.agent_pod_plans WHERE operation_id=$1']) {
    await rejectCode(withDurableTransaction(pool, tx => tx.query(sql,[a.identity.operationId])), '23514')
  }
  assert.deepEqual(await history(a.identity.operationId), { plans:'1', audit:'1', outbox:'1' })
  assert.deepEqual(await seedRows(), seedBefore)
  assert.equal((await pool.query('SELECT count(*)::text AS n FROM durable_runtime.attempts WHERE runtime_unit_id=ANY($1::uuid[])',
    [[a,b,c].map(r => r.identity.unitId)])).rows[0].n, '0')
  const audit = (await pool.query<{ next_state: Record<string, unknown> }>(
    "SELECT next_state FROM durable_runtime.runtime_audit_events WHERE operation_id=$1 AND kind='AGENT_POD_PLAN_RECORDED'",[a.identity.operationId])).rows[0].next_state
  for (const key of ['plan','pod','command','env','mountExpectations']) { assert.equal(Object.hasOwn(audit,key), false) }
  retained(originals, await rowHashes())
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, applied)
  t.diagnostic(JSON.stringify({ firstIdentity,seedIdentity,finalIdentity:await identity(),ledgerBefore:22,ledgerAfter:23,
    productCallbacks:1,originalRowsPreserved:true,syntheticControllerIdentity:true,actualAttemptOrPodCreated:false,physicalPermissionIssued:false }))
})
