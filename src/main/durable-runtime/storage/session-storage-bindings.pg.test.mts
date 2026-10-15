import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from '../db/connection.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { applyMigrations, readMigrations } from '../db/migrate.ts'
import type { AppliedMigration } from '../db/migrate.ts'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { RuntimeUnitId, SessionId, StorageBindingId } from '../../../shared/durable-runtime/identity.ts'
import { StorageStore } from './store.ts'
import type { Binding, StorageScope, StorageTarget } from './store.ts'
import type { CanonicalCandidate } from './canonical.ts'
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence, VerifiedMountEvidence,
  VerifiedPermanentComputeStop, ExecutionTarget } from './evidence.ts'
import { prepareReconcileStep } from '../lifecycle/controller.ts'
import type { VerifiedControllerIdentity, ExecutorId } from '../runtime/gateway/types.ts'
import { projectOpsUnit } from '../ops/unit.ts'
import type { OpsActor } from '../ops/types.ts'

// Root supplies the existing isolated DB name/OID and fixed migration directory
// at the later first-run dispatch. This source does not select/create a database.
const database = process.env.ORCA_SESSION_BINDINGS_DATABASE
const oid = process.env.ORCA_SESSION_BINDINGS_DATABASE_OID
const migrationsDirectory = process.env.ORCA_SESSION_BINDINGS_MIGRATIONS
if (process.env.ORCA_SESSION_BINDINGS_APPROVED !== 'root-first-verification' ||
    !database || !/^orca_[a-z0-9_]+$/.test(database) || database === 'orca_dev' ||
    database !== process.env.PGDATABASE || !oid || !/^[1-9][0-9]*$/.test(oid) || !migrationsDirectory) {
  throw new Error('Root-approved existing isolated database and migration inputs required')
}
const migrationPath = migrationsDirectory
const pool = createDurablePool({ database, max: 4, application_name: 'session-storage-bindings-first' })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const revision = () => counter('row:runtime-unit', '0')
const bindingId = () => logicalId('storage-binding', randomUUID())
const unitId = () => logicalId('runtime-unit', randomUUID())
const sessionId = () => logicalId('session', randomUUID())
const rejectCode = (result: Promise<unknown>, code: string) => assert.rejects(result,
  error => error instanceof DurableDatabaseError && error.code === code)

// Narrow reuse of storage/postgres.test.mts's synthetic directory authority.
// These assertions are fixture-only, not directory authentication or mount proof.
class FixtureAuthority implements StorageEvidenceAuthority {
  directories = new Map<string, VerifiedDirectoryEvidence>()
  directory(reference: string) { return this.directories.get(reference) ?? null }
  directoryPinValid(value: VerifiedDirectoryEvidence) { return this.directories.get(value.evidenceRef) === value }
  mount(_reference: string): VerifiedMountEvidence | null { return null }
  mountPinValid(_value: VerifiedMountEvidence) { return false }
  executionTarget(_attempt: string): ExecutionTarget | null { return null }
  executionTargetPinValid(_value: ExecutionTarget) { return false }
  permanentComputeStop(_reference: string): VerifiedPermanentComputeStop | null { return null }
  computeStopPinValid(_value: VerifiedPermanentComputeStop) { return false }
  directoryFixture(binding: StorageBindingId, exportId: string, directory: string) {
    const reference = `synthetic-member-directory:${binding}`
    const candidate: CanonicalCandidate = Object.freeze({
      domain: Object.freeze({ backendId: 'synthetic-member-pv', exportId, pvUid: exportId }),
      canonicalDirectory: directory, podUid: 'synthetic-directory-server', generation: 'synthetic-1',
      device: '123', inode: String(this.directories.size + 1)
    })
    const held = Object.freeze({ evidenceRef: reference, topologyPinId: `synthetic-pin:${binding}`, candidate }) as VerifiedDirectoryEvidence
    this.directories.set(reference, held)
    return { reference, candidate }
  }
}

// Explicitly limited to the existing rows these seeds/mutations can affect.
// Only hashes are compared; existing payloads/rows are not printed or exported.
const originalTables = ['dataset_metadata', 'agents', 'workspaces', 'sessions', 'tabs',
  'runtime_units', 'resource_profiles', 'attempts', 'execution_grants', 'runtime_members',
  'storage_domains', 'storage_bindings', 'storage_write_grants', 'storage_mounts',
  'catalog_project_groups', 'catalog_workspace_metadata', 'operations', 'controller_leases',
  'runtime_commands', 'rpc_receipts', 'session_events', 'runtime_audit_events', 'outbox_events'] as const
async function rowHashes() {
  const rows: Record<string, string[]> = {}
  for (const table of originalTables) {
    rows[table] = (await pool.query<{ body: string }>(
      `SELECT to_jsonb(t)::text AS body FROM durable_runtime.${table} t`)).rows.map(row => hash(row.body)).sort()
  }
  return rows
}
function assertRetained(before: Record<string, string[]>, after: Record<string, string[]>) {
  for (const table of originalTables) {
    const counts = new Map<string, number>()
    for (const item of after[table]) { counts.set(item, (counts.get(item) ?? 0) + 1) }
    for (const item of before[table]) {
      assert.ok((counts.get(item) ?? 0) > 0, `original row missing in ${table}`)
      counts.set(item, counts.get(item)! - 1)
    }
  }
}
async function identity(owner: Pool) {
  const value = (await owner.query<{ database: string; oid: string; system: string; backend_pid: number }>(
    `SELECT current_database() AS database,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS backend_pid`)).rows[0]
  assert.equal(value.database, database)
  assert.equal(value.oid, oid)
  assert.equal(value.system, '7696101282789175327')
  const dataset = (await owner.query<{ dataset_name: string }>(
    'SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows
  assert.deepEqual(dataset, [{ dataset_name: 'orca-1012-dev-v1' }])
  return value
}
async function workspace(tx: DurableTransaction, id: string, unit: RuntimeUnitId, group: string) {
  await tx.query(`INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state)
    VALUES($1,$2,'session storage binding fixture','READY')`, [id, `member-fixture:${id}`])
  await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata
    (workspace_id,kind,project_group_id,reserved_path,payload,create_request,runtime_unit_id)
    VALUES($1,'FOLDER_WORKSPACE',$2,$3,'{}','{}',$4)`, [id, group, `/synthetic-member/${id}`, unit])
}
async function session(tx: DurableTransaction, id: SessionId, unit: RuntimeUnitId,
  agent: string, workspaceId: string, primary?: StorageBindingId) {
  await tx.query(`INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle)
    VALUES($1,$2,$3,'OPEN')`, [id, agent, workspaceId])
  if (primary) {
    await tx.query(`INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id)
      VALUES($1,$2,$3)`, [unit, id, primary])
  }
}
async function activeAttempt(tx: DurableTransaction, unit: RuntimeUnitId) {
  const attempt = logicalId('attempt', randomUUID()), pod = `synthetic-member-pod:${attempt}`
  await tx.query(`INSERT INTO durable_runtime.resource_profiles
    (runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)`, [unit])
  await tx.query(`INSERT INTO durable_runtime.attempts
    (id,runtime_unit_id,execution_epoch,mode,resource_profile_revision,effective_resources,pod_uid,incarnation,status)
    VALUES($1,$2,0,'COLD',0,'{}',$3,$4,'READY')`, [attempt, unit, pod, `synthetic-incarnation:${attempt}`])
  await tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1', [unit, attempt])
  await tx.query(`INSERT INTO durable_runtime.execution_grants(id,runtime_unit_id,attempt_id,execution_epoch,state)
    VALUES($1,$2,$3,0,'ACTIVE')`, [randomUUID(), unit, attempt])
  return { attempt, pod }
}
const scope = (unit: RuntimeUnitId, member: SessionId): StorageScope => ({
  unitId: unit, sessionId: member, expectedUnitRevision: revision(), actorId: 'synthetic-member-actor'
})
const bindingRow = async (id: StorageBindingId) => (await pool.query<Binding>(
  'SELECT * FROM durable_runtime.storage_bindings WHERE id=$1', [id])).rows[0]
async function history(member: SessionId, binding: StorageBindingId) {
  return (await pool.query<{ journal: string; audit: string; outbox: string }>(`SELECT
    (SELECT count(*)::text FROM durable_runtime.session_events WHERE session_id=$1) AS journal,
    (SELECT count(*)::text FROM durable_runtime.runtime_audit_events WHERE session_id=$1) AS audit,
    (SELECT count(*)::text FROM durable_runtime.outbox_events WHERE aggregate_id=$2) AS outbox`, [member, binding])).rows[0]
}

await test('Session storage bindings: migration021 and focused Store/lifecycle/Ops integration', async t => {
  t.after(() => pool.end())
  // First actual read is the same Pool's DB/system/OID/dataset guard, before any seed or DDL.
  const firstIdentity = await identity(pool)
  const migrations = await readMigrations(migrationPath)
  assert.equal(migrations.length, 21)
  assert.equal(migrations[20].version, '021-runtime-member-storage-bindings.sql')
  const ledgerBefore = (await pool.query<AppliedMigration>(
    'SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledgerBefore.length, 20, 'first 021 execution requires the existing ledger001–020')
  assert.deepEqual(ledgerBefore.map(row => [row.version, row.checksum]),
    migrations.slice(0, 20).map(row => [row.version, row.checksum]))
  assert.equal((await pool.query("SELECT to_regclass('durable_runtime.runtime_member_storage_bindings') AS table_name")).rows[0].table_name, null)
  const originalRows = await rowHashes()
  console.log(JSON.stringify({ phase: 'SESSION_BINDINGS_IDENTITY_BEFORE_SEED_AND_DDL', ...firstIdentity,
    dataset: 'orca-1012-dev-v1', ledgerRows: ledgerBefore.length, at: new Date().toISOString() }))

  const authority = new FixtureAuthority(), store = new StorageStore(authority), exportId = `member-export:${randomUUID()}`
  const a = unitId(), b = unitId(), empty = unitId(), primaryAfter021 = unitId()
  const sa = sessionId(), sa2 = sessionId(), hidden = sessionId(), sb = sessionId(), se = sessionId(), sd = sessionId()
  const primary = bindingId(), hiddenPrimary = bindingId(), primaryB = bindingId(), primaryEmpty = bindingId()
  const wa = randomUUID(), wh = randomUUID(), wb = randomUUID(), we = randomUUID(), wd = randomUUID()
  const agent = randomUUID(), group = `member-group:${randomUUID()}`, tab = randomUUID()
  const heldPrimary = authority.directoryFixture(primary, exportId, '/primary-a')
  const { aa, ab } = await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'synthetic')", [agent])
    await tx.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,jsonb_build_object(\'id\',$1::text))', [group])
    for (const unit of [a, b, empty, primaryAfter021]) {
      await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [unit])
    }
    await tx.query('INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)',
      [heldPrimary.candidate.domain.backendId, exportId])
    for (const [id, directory, reference] of [
      [primary, '/primary-a', heldPrimary.reference], [hiddenPrimary, '/hidden-primary', 'synthetic-hidden-primary'],
      [primaryB, '/primary-b', 'synthetic-primary-b'], [primaryEmpty, '/primary-empty', 'synthetic-primary-empty']
    ]) {
      await tx.query(`INSERT INTO durable_runtime.storage_bindings
        (id,backend_id,export_id,canonical_directory,identity_proof_ref,identity_verified_at,access_state)
        VALUES($1,'synthetic-member-pv',$2,$3,$4,clock_timestamp(),'VERIFIED')`, [id, exportId, directory, reference])
    }
    await workspace(tx, wa, a, group); await workspace(tx, wh, a, group)
    await workspace(tx, wb, b, group); await workspace(tx, we, empty, group); await workspace(tx, wd, primaryAfter021, group)
    await session(tx, sa, a, agent, wa, primary); await session(tx, sa2, a, agent, wa, primary)
    await session(tx, hidden, a, agent, wh, hiddenPrimary); await session(tx, sb, b, agent, wb, primaryB)
    await session(tx, se, empty, agent, we, primaryEmpty); await session(tx, sd, primaryAfter021, agent, wd)
    await tx.query(`INSERT INTO durable_runtime.tabs(id,workspace_id,session_id,kind,ui_order,lifecycle)
      VALUES($1,$2,$3,'fixture',0,'OPEN')`, [tab, wa, sa])
    return { aa: await activeAttempt(tx, a), ab: await activeAttempt(tx, b) }
  })
  const primaryRows = (await pool.query(`SELECT * FROM durable_runtime.runtime_members
    WHERE runtime_unit_id=ANY($1::uuid[]) ORDER BY session_id`, [[a, b, empty, primaryAfter021]])).rows
  const publicIds = (await pool.query(`SELECT w.id,w.public_id,s.id AS session_id,s.agent_id
    FROM durable_runtime.workspaces w JOIN durable_runtime.sessions s ON s.workspace_id=w.id
    WHERE w.id=ANY($1::uuid[]) ORDER BY s.id`, [[wa, wh, wb, we, wd]])).rows
  const tabBefore = (await pool.query('SELECT * FROM durable_runtime.tabs WHERE id=$1', [tab])).rows[0]
  const beforeBackfill = (await pool.query('SELECT count(*)::text AS n FROM durable_runtime.runtime_members')).rows[0].n
  await applyMigrations(pool, migrations)
  assert.equal((await pool.query('SELECT count(*)::text AS n FROM durable_runtime.runtime_member_storage_bindings')).rows[0].n, beforeBackfill)
  assert.equal((await pool.query(`SELECT count(*)::text AS n FROM durable_runtime.runtime_members m
    WHERE NOT EXISTS(SELECT 1 FROM durable_runtime.runtime_member_storage_bindings x
      WHERE x.runtime_unit_id=m.runtime_unit_id AND x.session_id=m.session_id AND x.storage_binding_id=m.storage_binding_id)`)).rows[0].n, '0')

  // Primary creation after 021 uses the real registerBinding + INSERT trigger.
  const postPrimary = bindingId(), postHeld = authority.directoryFixture(postPrimary, exportId, '/post-021-primary')
  await rejectCode(withDurableTransaction(pool, tx => store.attachBinding(tx,
    { ...scope(primaryAfter021, sd), bindingId: primary })), 'STORAGE_MEMBER_MISSING')
  await withDurableTransaction(pool, tx => store.registerBinding(tx, {
    ...scope(primaryAfter021, sd), bindingId: postPrimary, directoryEvidenceRef: postHeld.reference
  }))
  assert.equal((await pool.query(`SELECT storage_binding_id FROM durable_runtime.runtime_member_storage_bindings
    WHERE runtime_unit_id=$1 AND session_id=$2`, [primaryAfter021, sd])).rows[0].storage_binding_id, postPrimary)

  // Existing membership registers a new secondary binding without replacing primary.
  const home = bindingId(), direct = bindingId(), privateHome = bindingId()
  const homeHeld = authority.directoryFixture(home, exportId, '/additional-home')
  await withDurableTransaction(pool, tx => store.registerBinding(tx, {
    ...scope(a, sa), bindingId: home, directoryEvidenceRef: homeHeld.reference
  }))
  const directHeld = authority.directoryFixture(direct, exportId, '/additional-direct')
  await withDurableTransaction(pool, tx => store.registerBinding(tx, {
    ...scope(a, sa), bindingId: direct, directoryEvidenceRef: directHeld.reference
  }))
  const privateHeld = authority.directoryFixture(privateHome, exportId, '/additional-hidden')
  await withDurableTransaction(pool, tx => store.registerBinding(tx, {
    ...scope(a, hidden), bindingId: privateHome, directoryEvidenceRef: privateHeld.reference
  }))

  const bindingBefore = await bindingRow(home)
  const unitBefore = (await pool.query('SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [a])).rows[0]
  const historyBefore = await history(sa2, home)
  await rejectCode(withDurableTransaction(pool, async tx => {
    await store.attachBinding(tx, { ...scope(a, sa2), bindingId: home })
    throw new DurableDatabaseError('SESSION_BINDING_FIXTURE_ROLLBACK')
  }), 'SESSION_BINDING_FIXTURE_ROLLBACK')
  assert.equal((await pool.query(`SELECT count(*)::text AS n FROM durable_runtime.runtime_member_storage_bindings
    WHERE runtime_unit_id=$1 AND session_id=$2 AND storage_binding_id=$3`, [a, sa2, home])).rows[0].n, '0')
  assert.deepEqual(await history(sa2, home), historyBefore)
  assert.deepEqual(await bindingRow(home), bindingBefore)
  const firstAttach = await withDurableTransaction(pool, tx => store.attachBinding(tx, { ...scope(a, sa2), bindingId: home }))
  assert.deepEqual(firstAttach, bindingBefore)
  const firstHistory = await history(sa2, home)
  assert.equal(BigInt(firstHistory.journal), BigInt(historyBefore.journal) + 1n)
  assert.equal(BigInt(firstHistory.audit), BigInt(historyBefore.audit) + 1n)
  assert.equal(BigInt(firstHistory.outbox), BigInt(historyBefore.outbox) + 1n)
  const replay = await withDurableTransaction(pool, tx => store.attachBinding(tx, { ...scope(a, sa2), bindingId: home }))
  assert.deepEqual(replay, bindingBefore)
  assert.deepEqual(await history(sa2, home), firstHistory)
  assert.deepEqual(await bindingRow(home), bindingBefore)
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [a])).rows[0], unitBefore)
  assert.equal((await pool.query(`SELECT count(*)::text AS n FROM durable_runtime.runtime_member_storage_bindings
    WHERE runtime_unit_id=$1 AND session_id=$2 AND storage_binding_id=$3`, [a, sa2, home])).rows[0].n, '1')

  await rejectCode(withDurableTransaction(pool, tx => store.attachBinding(tx,
    { ...scope(b, sa), bindingId: home })), 'STORAGE_MEMBER_UNIT_MISMATCH')
  const refused = bindingId(), refusedHeld = authority.directoryFixture(refused, exportId, '/wrong-unit')
  await rejectCode(withDurableTransaction(pool, tx => store.registerBinding(tx,
    { ...scope(b, sa), bindingId: refused, directoryEvidenceRef: refusedHeld.reference })), 'STORAGE_MEMBER_UNIT_MISMATCH')
  assert.equal((await pool.query('SELECT count(*)::text AS n FROM durable_runtime.storage_bindings WHERE id=$1', [refused])).rows[0].n, '0')
  await rejectCode(withDurableTransaction(pool, tx => store.attachBinding(tx,
    { ...scope(a, sa), expectedUnitRevision: counter('row:runtime-unit', '99'), bindingId: home })), 'STORAGE_UNIT_STALE')
  await rejectCode(withDurableTransaction(pool, tx => store.attachBinding(tx,
    { ...scope(a, sa), bindingId: refused })), 'STORAGE_BINDING_MISSING')
  await rejectCode(withDurableTransaction(pool, tx => tx.query(`INSERT INTO durable_runtime.runtime_member_storage_bindings
    (runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)`, [b, sa, home])), '23503')
  await rejectCode(withDurableTransaction(pool, tx => tx.query(`UPDATE durable_runtime.runtime_member_storage_bindings
    SET storage_binding_id=$4 WHERE runtime_unit_id=$1 AND session_id=$2 AND storage_binding_id=$3`, [a, sa2, home, direct])), '23514')
  await rejectCode(withDurableTransaction(pool, tx => tx.query(`DELETE FROM durable_runtime.runtime_member_storage_bindings
    WHERE runtime_unit_id=$1 AND session_id=$2 AND storage_binding_id=$3`, [a, sa2, home])), '23514')

  // Real Store and direct grant SQL both accept an additional binding. Duplicate
  // same-Unit Session associations must not multiply the membership result.
  const target: StorageTarget = { ...scope(a, sa2), bindingId: home, attemptId: aa.attempt,
    podUid: aa.pod, executionEpoch: counter('execution-epoch', '0'), storageEpoch: counter('storage-epoch', '0'),
    expectedBindingRevision: counter('row:storage-binding', '0') }
  const grant = randomUUID()
  assert.equal((await withDurableTransaction(pool, tx => store.reserveWriter(tx, { ...target, grantId: grant }))).status, 'APPLIED')
  await withDurableTransaction(pool, tx => store.attachBinding(tx, { ...scope(a, sa2), bindingId: direct }))
  const directGrant = randomUUID()
  await withDurableTransaction(pool, tx => tx.query(`INSERT INTO durable_runtime.storage_write_grants
    (id,storage_binding_id,attempt_id,storage_epoch,state) VALUES($1,$2,$3,0,'RESERVED')`, [directGrant, direct, aa.attempt]))
  const wrongGrant = randomUUID()
  await rejectCode(withDurableTransaction(pool, tx => tx.query(`INSERT INTO durable_runtime.storage_write_grants
    (id,storage_binding_id,attempt_id,storage_epoch,state) VALUES($1,$2,$3,0,'RESERVED')`, [wrongGrant, direct, ab.attempt])), '23514')
  assert.equal((await pool.query('SELECT count(*)::text AS n FROM durable_runtime.storage_write_grants WHERE id=$1', [wrongGrant])).rows[0].n, '0')
  await withDurableTransaction(pool, tx => store.attachBinding(tx, { ...scope(b, sb), bindingId: home }))
  await rejectCode(withDurableTransaction(pool, tx => tx.query(`INSERT INTO durable_runtime.storage_write_grants
    (id,storage_binding_id,attempt_id,storage_epoch,state) VALUES($1,$2,$3,0,'RESERVED')`, [randomUUID(), home, ab.attempt])), '23505')
  const contender: StorageTarget = { ...scope(b, sb), bindingId: home, attemptId: ab.attempt, podUid: ab.pod,
    executionEpoch: counter('execution-epoch', '0'), storageEpoch: counter('storage-epoch', '0'),
    expectedBindingRevision: counter('row:storage-binding', '1') }
  const blocked = await withDurableTransaction(pool, tx => store.reserveWriter(tx, { ...contender, grantId: randomUUID() }))
  assert.equal(blocked.status, 'BLOCKED')
  if (blocked.status !== 'BLOCKED') { assert.fail('second writer must be blocked') }
  assert.equal(blocked.reason, 'WRITER_HELD')
  assert.equal((await pool.query("SELECT count(*)::text AS n FROM durable_runtime.storage_write_grants WHERE storage_binding_id=$1 AND state<>'REVOKED'", [home])).rows[0].n, '1')

  // This Unit has no earlier attempt of its own: only the secondary shared
  // binding's old writer can make the real lifecycle guard refuse ensure.
  await withDurableTransaction(pool, tx => store.attachBinding(tx, { ...scope(empty, se), bindingId: home }))
  const operation = logicalId('operation', randomUUID()), controllerScope = `member-controller:${randomUUID()}`
  const owner = `synthetic-member-controller:${randomUUID()}`
  await withDurableTransaction(pool, async tx => {
    await tx.query(`INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at)
      VALUES($1,$2,1,clock_timestamp()+interval '1 hour')`, [controllerScope, owner])
    await tx.query(`INSERT INTO durable_runtime.operations
      (id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch,external_resource_name,deadline_at)
      VALUES($1,$2,'WAKE',0,$3,1,'INITIAL',0,$4,clock_timestamp()+interval '1 hour')`,
      [operation, empty, controllerScope, `synthetic-member-external:${operation}`])
  })
  // Explicit fixture controller identity, not a production authentication result.
  const controller = Object.freeze({ scope: controllerScope, owner, term: counter('controller-term', '1') }) as VerifiedControllerIdentity
  const prepared = await prepareReconcileStep(pool, { context: { runtimeUnitId: empty, operationId: operation, controller },
    mutationKey: randomUUID(), expectedUnitRevision: revision(), expectedIntentRevision: counter('intent-revision', '0'),
    expectedStepRevision: counter('step-revision', '0'), step: 'ENSURE_ATTEMPT',
    executorId: `synthetic-member-executor:${randomUUID()}` as ExecutorId, input: {} })
  assert.equal(prepared.mutation.status, 'COMMITTED')
  assert.equal(prepared.execution.disposition, 'NO_EXECUTION')
  if (prepared.execution.disposition !== 'NO_EXECUTION') { assert.fail('secondary held writer must prevent an execution claim') }
  assert.equal(prepared.execution.reason, 'PHYSICAL_FENCE_UNVERIFIED')
  assert.equal((await pool.query('SELECT phase FROM durable_runtime.runtime_units WHERE id=$1', [empty])).rows[0].phase, 'BLOCKED')
  assert.equal((await pool.query('SELECT count(*)::text AS n FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1', [empty])).rows[0].n, '0')

  const actor: OpsActor = Object.freeze({ principalId: 'synthetic-member-ops', authorizationRef: 'synthetic-no-real-auth',
    datasetName: 'orca-1012-dev-v1', namespaceId: 'synthetic-member-namespace', workspaceIds: Object.freeze([wa]) })
  const projected = await withDurableTransaction(pool, tx => projectOpsUnit(tx, actor, a, false))
  assert.deepEqual(projected.mounts.map(row => row.id).sort(), [primary, home, direct].sort())
  assert.equal(new Set(projected.mounts.map(row => row.id)).size, projected.mounts.length)
  assert.equal(projected.mounts.some(row => row.id === privateHome || row.id === hiddenPrimary), false)
  await rejectCode(withDurableTransaction(pool, tx => projectOpsUnit(tx, { ...actor, workspaceIds: [wb] }, a, false)), 'OPS_TARGET_FORBIDDEN')
  await rejectCode(withDurableTransaction(pool, tx => projectOpsUnit(tx, { ...actor, datasetName: 'synthetic-other-dataset' }, a, false)), 'OPS_TARGET_FORBIDDEN')

  const primaryAfter = (await pool.query(`SELECT * FROM durable_runtime.runtime_members
    WHERE runtime_unit_id=ANY($1::uuid[]) AND session_id<>$2 ORDER BY session_id`, [[a, b, empty, primaryAfter021], sd])).rows
  assert.deepEqual(primaryAfter, primaryRows)
  assert.deepEqual((await pool.query(`SELECT w.id,w.public_id,s.id AS session_id,s.agent_id
    FROM durable_runtime.workspaces w JOIN durable_runtime.sessions s ON s.workspace_id=w.id
    WHERE w.id=ANY($1::uuid[]) ORDER BY s.id`, [[wa, wh, wb, we, wd]])).rows, publicIds)
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.tabs WHERE id=$1', [tab])).rows[0], tabBefore)
  assert.equal((await pool.query('SELECT count(*)::text AS n FROM durable_runtime.tabs WHERE workspace_id=ANY($1::uuid[])', [[wa, wh, wb, we, wd]])).rows[0].n, '1')
  const ledgerAfter = (await pool.query<AppliedMigration>(
    'SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledgerAfter.length, 21)
  assert.deepEqual(ledgerAfter.slice(0, 20), ledgerBefore)
  assertRetained(originalRows, await rowHashes())
  await identity(pool)
  console.log(JSON.stringify({ phase: 'SESSION_BINDINGS_CASES', callbackCount: 1,
    cases: ['021-backfill-and-primary-insert-trigger', 'register-secondary-primary-preserved', 'attach-and-history-rollback-together',
      'attach-replay-no-new-event-or-binding-state-change', 'wrong-unit-revision-binding-and-relation-mutation-refused',
      'store-and-direct-sql-exact-membership-and-writer-conflict', 'secondary-writer-blocks-lifecycle-with-no-local-prior-attempt',
      'ops-all-authorized-bindings-no-duplicates-or-private-workspace', 'original-ids-rows-and-ledger20-preserved'],
    syntheticAuthority: true, live: false, ledgerBefore: 20, ledgerAfter: 21 }))
})
