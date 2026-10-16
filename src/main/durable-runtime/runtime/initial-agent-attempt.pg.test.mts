import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { test } from 'node:test'
import type { QueryResultRow } from 'pg'
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from '../db/connection.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { readMigrations } from '../db/migrate.ts'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence } from '../storage/evidence.ts'
import { createAgentPodPlanner } from './agent-pod-plan.ts'
import { recordAgentPodPlan } from './agent-pod-plan-records.ts'
import { LockedGatewayAuthority } from './gateway/authority.ts'
import { submitCommand, originalIdentity } from './gateway/store.ts'
import { claimCommand } from './gateway/claim.ts'
import { inputDigest } from './gateway/input.ts'
import type { GatewayContext, VerifiedControllerIdentity, ExecutorId } from './gateway/types.ts'
import { reserveInitialAgentAttempt, type InitialAgentAttemptInput } from './initial-agent-attempt.ts'

// Root supplies an existing isolated SQL23 DB after source review. No DDL/reset,
// real issuer, Pod/provider call, live configuration or automatic retry exists.
const database = process.env.ORCA_INITIAL_ATTEMPT_DATABASE, oid = process.env.ORCA_INITIAL_ATTEMPT_DATABASE_OID
const migrationPath = process.env.ORCA_INITIAL_ATTEMPT_MIGRATIONS
if (process.env.ORCA_INITIAL_ATTEMPT_APPROVED !== 'root-first-verification' ||
    !database || database === 'orca_dev' || !/^orca_[a-z0-9_]+$/u.test(database) || database !== process.env.PGDATABASE ||
    !oid || !/^[1-9][0-9]*$/u.test(oid) || !migrationPath) {
  throw new Error('Root-approved existing isolated SQL23 database/OID/migration inputs required')
}
const pool = createDurablePool({ database, max: 4, application_name: 'initial-agent-attempt-first' })
const dataset = 'orca-1012-dev-v1', scope = `synthetic-initial:${randomUUID()}`, owner = `synthetic-owner:${randomUUID()}`
// SAFETY: fixture-only nominal identity, not an authenticated controller issuer.
const controller = Object.freeze({ scope, owner, term: counter('controller-term', '1') }) as VerifiedControllerIdentity
const directories = new Map<string, VerifiedDirectoryEvidence>()
const authority: StorageEvidenceAuthority = Object.freeze({
  directory(reference: string) { return directories.get(reference) ?? null },
  directoryPinValid(evidence: VerifiedDirectoryEvidence) { return directories.get(evidence.evidenceRef) === evidence },
  mount() { return null }, mountPinValid() { return false }, executionTarget() { return null }, executionTargetPinValid() { return false },
  permanentComputeStop() { return null }, computeStopPinValid() { return false }
})
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const reject = (pending: Promise<unknown>, code: string) => assert.rejects(pending,
  error => error instanceof DurableDatabaseError && error.code === code)
const tables = ['controller_leases','runtime_units','operations','resource_profiles','attempts','execution_grants','storage_domains',
  'storage_bindings','storage_write_grants','storage_mounts','agents','workspaces','sessions','runtime_members',
  'runtime_member_storage_bindings','runtime_commands','runtime_command_history','agent_pod_plans','runtime_audit_events','outbox_events'] as const
async function rows() {
  const result: Record<string,string[]> = {}
  for (const table of tables) {
    result[table] = (await pool.query<{ body: string }>(`SELECT to_jsonb(t)::text AS body FROM durable_runtime.${table} t`)).rows.map(r => hash(r.body)).sort()
  }
  return result
}
async function identity(tx: DurableTransaction) {
  const actual = (await tx.query<{ database: string; oid: string; system: string; backend_pid: number }>(`SELECT current_database() AS database,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS backend_pid`)).rows[0]
  assert.equal(actual.database, database); assert.equal(actual.oid, oid); assert.equal(actual.system, '7696101282789175327')
  assert.deepEqual((await tx.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows, [{ dataset_name: dataset }])
  return actual
}
function binding(key: string, mode: 'RW' | 'RO', existing?: { bindingId: string; leafId: string; pvUid: string }) {
  const leafId = existing?.leafId ?? randomUUID()
  return { key, mode, bindingId: existing?.bindingId ?? randomUUID(), leafId,
    claimName: `protected-${leafId}`, claimUid: `claim-${leafId}`, pvUid: existing?.pvUid ?? `pv-${leafId}`,
    serverPath: `/exports/runtime-domains/${dataset}/${leafId}` }
}
async function seed(bindings = [binding('home','RW'),binding('project','RW'),binding('reference','RO')]) {
  const unit = logicalId('runtime-unit', randomUUID()), operation = logicalId('operation', randomUUID())
  const attempt = randomUUID(), session = randomUUID(), agent = randomUUID(), workspace = randomUUID()
  const context: GatewayContext = Object.freeze({ runtimeUnitId: unit, operationId: operation, controller })
  const policy = { namespace: 'initial-attempt-fixture', dataset, image: `example.invalid/agent@sha256:${'1'.repeat(64)}`,
    entrypoint: { command: ['/opt/agent/entrypoint'], args: ['--cold'] }, nfsServer: 'nfs.fixture.svc.cluster.local',
    paths: { home: '/agent/home', claudeState: '/agent/home/.claude', codexState: '/agent/home/.codex', checkout: '/agent/project' },
    protectedExportRoot: `/exports/runtime-domains/${dataset}`,
    protectedMounts: bindings.map(b => ({ key: b.key, clientPath: `/agent/${b.key}` })),
    shared: { claimName: 'shared-fixture', claimUid: 'shared-claim', pvUid: 'shared-pv', serverPath: `/exports/shared/${dataset}` } }
  const plan = createAgentPodPlanner(policy).plan({ identity: { unitId: unit, operationId: operation, attemptId: attempt,
    resourceName: `orca-unit-${operation}`, executionEpoch: '0', intentRevision: '0', specHash: 'a'.repeat(64) },
    protectedBindings: bindings, profile: { revision: '0', cpuMilli: 100, memoryMi: 128, ephemeralMi: 256, temporaryMi: 64 } })
  return withDurableTransaction(pool, async tx => {
    await identity(tx) // Same Pool/transaction actual identity before this fixture's additive seed.
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [unit])
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)", [unit])
    await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch,external_resource_name)
      VALUES($1,$2,'WAKE',0,$3,1,'ENSURE_ATTEMPT',0,$4)`, [operation,unit,scope,plan.identity.resourceName])
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'codex')", [agent])
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'synthetic initial reservation','READY')", [workspace,`initial:${workspace}`])
    await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [session,agent,workspace])
    for (const b of bindings) {
      const reference = `synthetic-initial-directory:${b.bindingId}`
      // SAFETY: synthetic prepared proof only; no authenticated physical pin issuer is qualified.
      const evidence = Object.freeze({ evidenceRef: reference, topologyPinId: `synthetic-pin:${b.bindingId}`,
        candidate: Object.freeze({ domain: Object.freeze({ backendId: 'initial-fixture', exportId: b.pvUid, pvUid: b.pvUid }),
          canonicalDirectory: `/${dataset}/${b.leafId}`, podUid: 'synthetic-nfs', generation: 'synthetic-1', device: '123', inode: '456' }) }) as VerifiedDirectoryEvidence
      directories.set(reference, evidence)
      await tx.query('INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2) ON CONFLICT DO NOTHING', ['initial-fixture',b.pvUid])
      await tx.query(`INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,identity_proof_ref,identity_verified_at,access_state)
        VALUES($1,$2,$3,$4,$5,clock_timestamp(),'VERIFIED') ON CONFLICT(id) DO NOTHING`,
      [b.bindingId,'initial-fixture',b.pvUid,`/${dataset}/${b.leafId}`,reference])
    }
    await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [unit,session,bindings[0].bindingId])
    for (const b of bindings.slice(1)) {
      await tx.query('INSERT INTO durable_runtime.runtime_member_storage_bindings(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [unit,session,b.bindingId])
    }
    const stored = await recordAgentPodPlan(tx, context, plan)
    const envelope = { operationId: operation, controllerTerm: controller.term, stepRevision: counter('step-revision', '0'),
      executionEpoch: plan.identity.executionEpoch, intentRevision: plan.identity.intentRevision,
      podTarget: 'CREATE_WITHOUT_POD' as const, expectedPodUid: null }
    const input = { planDigest: stored.record.planDigest }
    const locked = await LockedGatewayAuthority.acquire(tx, context)
    const submitted = await submitCommand(locked, { command: 'ensureAttempt', envelope, input, inputHash: inputDigest(input), predecessor: { kind:'NONE' } })
    // SAFETY: synthetic fixture executor string only, never a workload authentication issuer.
    const executor = `synthetic-executor:${operation}` as ExecutorId
    const claimed = await claimCommand(locked, originalIdentity(submitted.command), executor)
    assert.equal(claimed.disposition, 'CLAIMED')
    if (claimed.disposition !== 'CLAIMED') { throw new Error('fixture claim missing') }
    const request: InitialAgentAttemptInput = { claim: claimed.claim, planDigest: stored.record.planDigest,
      expectedUnitRevision: counter('row:runtime-unit','0'), bindings: bindings.map(b => ({ bindingId: logicalId('storage-binding',b.bindingId),
        expectedRevision: counter('row:storage-binding','0'), storageEpoch: counter('storage-epoch','0') })) }
    return { context, request, plan, bindings, session }
  })
}
const reserve = (f: Awaited<ReturnType<typeof seed>>, request = f.request) =>
  withDurableTransaction(pool, tx => reserveInitialAgentAttempt(tx, f.context, request, authority))
async function counts(f: Awaited<ReturnType<typeof seed>>) {
  return (await pool.query(`SELECT (SELECT count(*)::text FROM durable_runtime.attempts WHERE runtime_unit_id=$1) AS attempts,
    (SELECT count(*)::text FROM durable_runtime.execution_grants WHERE runtime_unit_id=$1) AS execution,
    (SELECT count(*)::text FROM durable_runtime.storage_write_grants WHERE attempt_id=$2) AS storage,
    (SELECT count(*)::text FROM durable_runtime.storage_mounts WHERE attempt_id=$2) AS mounts,
    (SELECT count(*)::text FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$1 AND kind='INITIAL_AGENT_ATTEMPT_RESERVED') AS audit,
    (SELECT count(*)::text FROM durable_runtime.outbox_events WHERE event->>'kind'='INITIAL_AGENT_ATTEMPT_RESERVED' AND aggregate_id=$1) AS outbox`,
  [f.context.runtimeUnitId,f.plan.identity.attemptId])).rows[0]
}

await test('initial attempt and complete protected writer reservation: focused SQL23 boundary', async t => {
  t.after(() => pool.end())
  const actual = await withDurableTransaction(pool, identity)
  const migrations = await readMigrations(migrationPath)
  assert.equal(migrations.length,23)
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.deepEqual(ledger.map(r => [r.version,r.checksum]), migrations.map(r => [r.version,r.checksum]))
  const original = await rows()
  await withDurableTransaction(pool, async tx => {
    await identity(tx)
    await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '10 minutes')", [scope,owner])
  })
  const a = await seed(), result = await reserve(a)
  assert.equal(result.disposition,'RESERVED'); assert.equal(result.attemptId,a.plan.identity.attemptId)
  assert.equal(result.kubernetesExecutionAuthorized,false); assert.equal(result.physicalPinIssuerImplemented,false)
  assert.equal(result.storageGrants.length,2); assert.equal(result.unitRevision,'1')
  assert.deepEqual(await counts(a), { attempts:'1', execution:'1', storage:'2', mounts:'0', audit:'1', outbox:'1' })
  const replay = await reserve(a)
  assert.deepEqual(replay,{ ...result,disposition:'REPLAYED' })
  assert.deepEqual(await counts(a), { attempts:'1', execution:'1', storage:'2', mounts:'0', audit:'1', outbox:'1' })
  const attempt = (await pool.query('SELECT pod_uid,incarnation,status,ready_at,effective_resources FROM durable_runtime.attempts WHERE id=$1',[result.attemptId])).rows[0]
  assert.deepEqual(attempt,{ pod_uid:null,incarnation:null,status:'RESERVED',ready_at:null,effective_resources:{} })
  const ro = a.bindings.find(b => b.mode==='RO')!
  assert.deepEqual((await pool.query('SELECT access_state,writer_attempt_id,revision FROM durable_runtime.storage_bindings WHERE id=$1',[ro.bindingId])).rows[0],
    { access_state:'VERIFIED',writer_attempt_id:null,revision:'0' })
  assert.ok(!result.storageGrants.some(g => g.bindingId==='shared-fixture'))
  const bad = await seed()
  await reject(reserve(bad,{ ...bad.request,planDigest:'0'.repeat(64) }),'INITIAL_AGENT_PLAN')
  await reject(reserve(bad,{ ...bad.request,bindings:bad.request.bindings.slice(1) }),'INITIAL_AGENT_PLAN')
  await reject(reserve(bad,{ ...bad.request,claim:{ ...bad.request.claim,executionToken:logicalId('runtime-command-execution',randomUUID()) } }),'INITIAL_AGENT_CLAIM')
  await reject(withDurableTransaction(pool, tx => reserveInitialAgentAttempt(tx,{ ...bad.context,controller:{ ...controller,term:counter('controller-term','0') } },
    { ...bad.request,claim:{ ...bad.request.claim,controllerTerm:counter('controller-term','0') } },authority)),'COMMAND_AUTHORITY_STALE')
  const badProof = bad.bindings.at(-1)!, held = directories.get(`synthetic-initial-directory:${badProof.bindingId}`)!
  directories.delete(held.evidenceRef)
  await reject(reserve(bad),'INITIAL_AGENT_DIRECTORY'); directories.set(held.evidenceRef,held)
  assert.deepEqual(await counts(bad),{ attempts:'0',execution:'0',storage:'0',mounts:'0',audit:'0',outbox:'0' })
  await reject(withDurableTransaction(pool,async tx => {
    await tx.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSED' WHERE id=$1",[bad.session])
    return reserveInitialAgentAttempt(tx,bad.context,bad.request,authority)
  }),'INITIAL_AGENT_SESSION_CLOSED')
  await reject(withDurableTransaction(pool,async tx => {
    await reserveInitialAgentAttempt(tx,bad.context,bad.request,authority)
    throw new DurableDatabaseError('INITIAL_FIXTURE_ROLLBACK')
  }),'INITIAL_FIXTURE_ROLLBACK')
  assert.deepEqual(await counts(bad),{ attempts:'0',execution:'0',storage:'0',mounts:'0',audit:'0',outbox:'0' })
  // Controlled query failure on the SECOND grant follows actual PG writes.
  // The original transaction method is restored before engine ROLLBACK.
  const partial = await seed()
  await reject(withDurableTransaction(pool,async tx => {
    const query = tx.query.bind(tx); let storageWrites=0
    tx.query = async function<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []) {
      if (sql.includes('INSERT INTO durable_runtime.storage_write_grants') && ++storageWrites===2) {
        throw new DurableDatabaseError('INITIAL_FIXTURE_SECOND_BINDING_FAILURE')
      }
      return query<Row>(sql,values)
    }
    try { return await reserveInitialAgentAttempt(tx,partial.context,partial.request,authority) }
    finally { tx.query=query }
  }),'INITIAL_FIXTURE_SECOND_BINDING_FAILURE')
  assert.deepEqual(await counts(partial),{ attempts:'0',execution:'0',storage:'0',mounts:'0',audit:'0',outbox:'0' })
  const captured = await seed(), mutable = structuredClone(captured.request)
  const mutableContext = { ...captured.context,controller:{ ...controller } }
  const capturedResult = await withDurableTransaction(pool,async tx => {
    const pending = reserveInitialAgentAttempt(tx,mutableContext,mutable,authority)
    Object.defineProperty(mutable,'planDigest',{ value:'0'.repeat(64) })
    Object.defineProperty(mutableContext.controller,'owner',{ value:'changed-after-first-await' })
    Object.defineProperty(mutable.claim.identity.originalEnvelope,'executionEpoch',{ value:'999' })
    return pending
  })
  assert.equal(capturedResult.disposition,'RESERVED'); assert.equal(capturedResult.planDigest,captured.request.planDigest)
  const shared = binding('home','RW'), first = await seed([shared,binding('project','RO')]), second = await seed([shared,binding('project','RO')])
  const race = await Promise.allSettled([reserve(first),reserve(second)])
  assert.equal(race.filter(r => r.status==='fulfilled').length,1)
  assert.equal(race.filter(r => r.status==='rejected').length,1)
  const failure = race.find(r => r.status==='rejected')
  assert.ok(failure && failure.status==='rejected' && failure.reason instanceof DurableDatabaseError)
  assert.equal(failure.reason.code,'INITIAL_AGENT_BINDING')
  // A parent-domain RESERVED writer blocks the exact managed child leaf too.
  const child = await seed(), parentUnit=randomUUID(), parentAttempt=randomUUID(), parentBinding=randomUUID()
  const leaf = child.bindings[0]
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')",[parentUnit])
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)",[parentUnit])
    await tx.query(`INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,identity_proof_ref,identity_verified_at,access_state)
      VALUES($1,'initial-fixture',$2,$3,'synthetic-parent',clock_timestamp(),'VERIFIED')`,[parentBinding,leaf.pvUid,`/${dataset}`])
    const member=randomUUID(), agent=randomUUID(), workspace=randomUUID()
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'codex')",[agent])
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'synthetic parent writer','READY')",[workspace,`parent:${workspace}`])
    await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')",[member,agent,workspace])
    await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)',[parentUnit,member,parentBinding])
    await tx.query("INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,resource_profile_revision,effective_resources,status) VALUES($1,$2,0,'COLD',0,'{}','RESERVED')",[parentAttempt,parentUnit])
    await tx.query("INSERT INTO durable_runtime.storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch,state) VALUES($1,$2,$3,0,'RESERVED')",[randomUUID(),parentBinding,parentAttempt])
  })
  await reject(reserve(child),'INITIAL_AGENT_WRITER_HELD')
  assert.deepEqual(await counts(child),{ attempts:'0',execution:'0',storage:'0',mounts:'0',audit:'0',outbox:'0' })
  // Original exact reservation cannot be turned back into create permission after Pod assignment.
  await withDurableTransaction(pool, async tx => {
    await tx.query("UPDATE durable_runtime.attempts SET pod_uid='synthetic-assigned-pod',incarnation='synthetic-1' WHERE id=$1",[result.attemptId])
  })
  await reject(reserve(a),'INITIAL_AGENT_REPLAY_CONFLICT')
  const after = await rows()
  for (const table of tables) {
    const available=new Map<string,number>()
    for (const digest of after[table]) { available.set(digest,(available.get(digest)??0)+1) }
    for (const digest of original[table]) { assert.ok((available.get(digest)??0)>0,`original ${table} row missing`); available.set(digest,available.get(digest)!-1) }
  }
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows,ledger)
  t.diagnostic(JSON.stringify({ databaseOid:actual.oid,system:actual.system,seedBackendPid:actual.backend_pid,
    providerCalls:0,podCalls:0,physicalIssuer:false,ddl:0 }))
})
