import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { test } from 'node:test'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
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
import type { PayloadHash } from './runtime-evidence.ts'
import type { GatewayContext, VerifiedControllerIdentity, ExecutorId } from './gateway/types.ts'
import type { InitialAgentAttemptInput } from './initial-agent-attempt.ts'
import { reserveInitialAgentAttemptWithPreparedPins } from './initial-agent-attempt-transaction.ts'
import type { PreparedInitialAgentPinsLease, PreparedInitialAgentPinsOwner, InitialAgentAttemptTransactionResult } from './initial-agent-attempt-transaction.ts'

// Root supplies an existing isolated SQL23 DB after source review. No DDL/reset,
// real issuer, Pod/provider call, live configuration or automatic retry exists.
const database = process.env.ORCA_INITIAL_ATTEMPT_TRANSACTION_DATABASE, oid = process.env.ORCA_INITIAL_ATTEMPT_TRANSACTION_DATABASE_OID
const migrationPath = process.env.ORCA_INITIAL_ATTEMPT_TRANSACTION_MIGRATIONS
if (process.env.ORCA_INITIAL_ATTEMPT_TRANSACTION_APPROVED !== 'root-first-verification' ||
    !database || database === 'orca_dev' || !/^orca_[a-z0-9_]+$/u.test(database) || database !== process.env.PGDATABASE ||
    !oid || !/^[1-9][0-9]*$/u.test(oid) || !migrationPath) {
  throw new Error('Root-approved existing isolated SQL23 database/OID/migration inputs required')
}
const pool = createDurablePool({ database, max: 4, application_name: 'initial-attempt-transaction-first' })
const dataset = 'orca-1012-dev-v1', scope = `synthetic-initial-transaction:${randomUUID()}`, owner = `synthetic-owner:${randomUUID()}`
// SAFETY: fixture-only nominal identity, not an authenticated controller issuer.
const controller = Object.freeze({ scope, owner, term: counter('controller-term', '1') }) as VerifiedControllerIdentity
const directories = new Map<string, VerifiedDirectoryEvidence>()
const bindingDomains = new Map<string,{ exportId: string; backingPvUid: string }>()
const authority: StorageEvidenceAuthority = Object.freeze({
  directory(reference: string) { return directories.get(reference) ?? null },
  directoryPinValid(evidence: VerifiedDirectoryEvidence) { return directories.get(evidence.evidenceRef) === evidence },
  mount() { return null }, mountPinValid() { return false }, executionTarget() { return null }, executionTargetPinValid() { return false },
  permanentComputeStop() { return null }, computeStopPinValid() { return false }
})
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
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
async function seed(bindings = [binding('home','RW'),binding('project','RW'),binding('reference','RO')], commandPlanDigest?: string) {
  const storageDomain = bindingDomains.get(bindings[0].bindingId) ?? {
    exportId: `synthetic-export:${randomUUID()}`, backingPvUid: `synthetic-server-ssd-pv:${randomUUID()}` }
  const unit = logicalId('runtime-unit', randomUUID()), operation = logicalId('operation', randomUUID())
  const attempt = randomUUID(), session = randomUUID(), agent = randomUUID(), workspace = randomUUID()
  const context: GatewayContext = Object.freeze({ runtimeUnitId: unit, operationId: operation, controller })
  const policy = { namespace: 'initial-attempt-transaction-fixture', dataset, image: `example.invalid/agent@sha256:${'1'.repeat(64)}`,
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
      bindingDomains.set(b.bindingId,storageDomain)
      const reference = `synthetic-initial-transaction-directory:${b.bindingId}`
      // SAFETY: synthetic prepared proof only; no authenticated physical pin issuer is qualified.
      const evidence = Object.freeze({ evidenceRef: reference, topologyPinId: `synthetic-pin:${b.bindingId}`,
        candidate: Object.freeze({ domain: Object.freeze({ backendId: 'initial-fixture', exportId: storageDomain.exportId, pvUid: storageDomain.backingPvUid }),
          canonicalDirectory: `/${dataset}/${b.leafId}`, podUid: 'synthetic-nfs', generation: 'synthetic-1', device: '123', inode: '456' }) }) as VerifiedDirectoryEvidence
      directories.set(reference, evidence)
      assert.notEqual(evidence.candidate.domain.pvUid,b.pvUid) // Server SSD backing PV differs from each consumer leaf PV.
      await tx.query('INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2) ON CONFLICT DO NOTHING', ['initial-fixture',storageDomain.exportId])
      await tx.query(`INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,identity_proof_ref,identity_verified_at,access_state)
        VALUES($1,$2,$3,$4,$5,clock_timestamp(),'VERIFIED') ON CONFLICT(id) DO NOTHING`,
      [b.bindingId,'initial-fixture',storageDomain.exportId,`/${dataset}/${b.leafId}`,reference])
    }
    await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [unit,session,bindings[0].bindingId])
    for (const b of bindings.slice(1)) {
      await tx.query('INSERT INTO durable_runtime.runtime_member_storage_bindings(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [unit,session,b.bindingId])
    }
    const stored = await recordAgentPodPlan(tx, context, plan)
    const envelope = { operationId: operation, controllerTerm: controller.term, stepRevision: counter('step-revision', '0'),
      executionEpoch: plan.identity.executionEpoch, intentRevision: plan.identity.intentRevision,
      podTarget: 'CREATE_WITHOUT_POD' as const, expectedPodUid: null }
    const input = { resourceName: plan.identity.resourceName, body: { mode:'COLD',
      planDigest: commandPlanDigest ?? stored.record.planDigest, attemptId: plan.identity.attemptId,
      resourceProfileRevision: plan.pod.metadata.annotations['orca.dev/resource-profile-revision'] } }
    const locked = await LockedGatewayAuthority.acquire(tx, context)
    // SAFETY: fixture SHA-256 digest only; this brand supplies no external authority.
    const submitted = await submitCommand(locked, { command: 'ensureAttempt', envelope, input, inputHash: inputDigest(input) as PayloadHash, predecessor: { kind:'NONE' } })
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
async function counts(f: Awaited<ReturnType<typeof seed>>) {
  return (await pool.query(`SELECT (SELECT count(*)::text FROM durable_runtime.attempts WHERE runtime_unit_id=$1) AS attempts,
    (SELECT count(*)::text FROM durable_runtime.execution_grants WHERE runtime_unit_id=$1) AS execution,
    (SELECT count(*)::text FROM durable_runtime.storage_write_grants WHERE attempt_id=$2) AS storage,
    (SELECT count(*)::text FROM durable_runtime.storage_mounts WHERE attempt_id=$2) AS mounts,
    (SELECT count(*)::text FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$1 AND kind='INITIAL_AGENT_ATTEMPT_RESERVED') AS audit,
    (SELECT count(*)::text FROM durable_runtime.outbox_events WHERE event->>'kind'='INITIAL_AGENT_ATTEMPT_RESERVED' AND aggregate_id=$1) AS outbox`,
  [f.context.runtimeUnitId,f.plan.identity.attemptId])).rows[0]
}

// These groups are synthetic prepared owners, never physical pin issuers. Each
// handoff transfers every member at once, including the protected RO reference.
function group(references: readonly string[], options: { takeFails?: boolean; partial?: boolean; releaseFails?: boolean } = {}) {
  const evidence = references.map(ref => { const e=directories.get(ref); assert.ok(e); return e })
  const state = { held: new Set(evidence), takes: 0, releases: 0, transferred: false }
  const lease: PreparedInitialAgentPinsLease = Object.freeze({
    evidence: Object.freeze(options.partial ? evidence.slice(0,-1) : [...evidence]),
    release() {
      assert.equal(this,lease); assert.equal(state.held.size,evidence.length); state.releases++
      if (options.releaseFails) { throw new Error('synthetic private group release failure') }
      state.held.clear()
    },
  })
  const owner: PreparedInitialAgentPinsOwner = Object.freeze({
    takePreparedPins(all: readonly VerifiedDirectoryEvidence[]) {
      assert.equal(this,owner); assert.ok(Object.isFrozen(all)); assert.deepEqual(new Set(all),new Set(evidence))
      assert.equal(state.transferred,false)
      if (options.takeFails) { throw new Error('synthetic atomic take rejection') }
      state.takes++; state.transferred=true; return lease
    },
  })
  return { state,owner,lease,evidence }
}
type Group = ReturnType<typeof group>
type Boundary = { entered: () => void; wait: Promise<void> }
function transport(pins: Group, options: {
  checkout?: Boundary; commit?: Boundary; rollback?: Boundary; unknown?: boolean; checkoutError?: Error; cleanupFails?: boolean
} = {}) {
  const connect = pool.connect.bind(pool), state = { connects: 0, destroyed: false, commits: 0, rollbacks: 0, cleanup: 0 }
  const observedPool: Pool = Object.create(pool, { connect: { writable:true, value: async function() {
    assert.equal(this,observedPool); assert.equal(pins.state.transferred,true)
    assert.equal(pins.state.held.size,pins.evidence.length); state.connects++
    options.checkout?.entered(); await options.checkout?.wait
    if (options.checkoutError) { throw options.checkoutError }
    const client = await connect(), query = client.query.bind(client), release = client.release.bind(client)
    // Real PG statements/core/engine; only controlled transport delays/failures.
    const borrowed: PoolClient = Object.create(client, {
      query: { value: async function<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []) {
        assert.equal(pins.state.held.size,pins.evidence.length,'all group pins held for every SQL/settlement')
        if (sql==='COMMIT') { state.commits++; options.commit?.entered(); await options.commit?.wait }
        if (sql==='ROLLBACK') {
          state.rollbacks++; options.rollback?.entered(); await options.rollback?.wait
          if (options.unknown) { throw new DurableDatabaseError('08006') }
        }
        const result=await query<Row>(sql,[...values])
        if (sql==='COMMIT' && options.unknown) { throw new DurableDatabaseError('08006') }
        return result
      } },
      release: { value: (destroy: boolean) => {
        assert.equal(pins.state.held.size,pins.evidence.length); state.cleanup++; state.destroyed=destroy; release(destroy)
        if (options.cleanupFails) { throw new Error('synthetic client cleanup failure') }
      } },
    })
    return borrowed
  } } })
  return { pool:observedPool,state }
}
function boundary() {
  const entered=Promise.withResolvers<void>(), gate=Promise.withResolvers<void>()
  return { entered:entered.promise, open:gate.resolve, control:{ entered:entered.resolve,wait:gate.promise } }
}
function retained(result: InitialAgentAttemptTransactionResult, pins: Group, reason: string) {
  assert.equal(result.pins.disposition,'RETAINED'); assert.equal(pins.state.held.size,pins.evidence.length)
  if (result.pins.disposition!=='RETAINED') { assert.fail('whole group must remain held') }
  assert.equal(result.pins.reason,reason); assert.equal(result.pins.retainedOwner,pins.owner)
  assert.equal(result.pins.retainedLease,reason==='TAKE_FAILED' ? null : pins.lease)
  assert.equal(result.kubernetesExecutionAuthorized,false); assert.equal(result.physicalPinIssuerImplemented,false)
}

await test('initial reservation: complete prepared group survives until real transaction settlement', async t => {
  t.after(() => pool.end())
  const actual=await withDurableTransaction(pool,identity), migrations=await readMigrations(migrationPath)
  assert.equal(migrations.length,23)
  const ledger=(await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.deepEqual(ledger.map(r=>[r.version,r.checksum]),migrations.map(r=>[r.version,r.checksum]))
  const original=await rows()
  await withDurableTransaction(pool,async tx=>{
    await identity(tx)
    await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '10 minutes')",[scope,owner])
  })
  const f=await seed(), references=f.bindings.map(b=>`synthetic-initial-transaction-directory:${b.bindingId}`)
  assert.equal(references.length,3); assert.equal(f.bindings.filter(b=>b.mode==='RO').length,1)
  let getterReads=0
  const originalEvidence=directories.get(references[0])!
  const accessorEvidence=Object.freeze({ ...originalEvidence,get candidate() { getterReads++; return originalEvidence.candidate } })
  const accessorAuthority=Object.freeze({ ...authority,directory:()=>accessorEvidence })
  const beforeTake=group(references)
  await assert.rejects(reserveInitialAgentAttemptWithPreparedPins(pool,f.context,f.request,accessorAuthority,references,beforeTake.owner),
    error=>error instanceof DurableDatabaseError && error.code==='INITIAL_AGENT_DIRECTORY_UNVERIFIED')
  assert.equal(getterReads,0); assert.equal(beforeTake.state.takes,0); assert.equal(beforeTake.state.held.size,3)
  const run=(pins: Group, borrowed: Pool=pool, input=f.request, refs: readonly string[]=references) =>
    reserveInitialAgentAttemptWithPreparedPins(borrowed,f.context,input,authority,refs,pins.owner)
  const empty={ attempts:'0',execution:'0',storage:'0',mounts:'0',audit:'0',outbox:'0' }
  // Group-level new boundary: atomic throw retains ALL; a partial lease is
  // rejected before checkout and never released or interpreted as authority.
  for (const takeFails of [true,false]) {
    const pins=group(references,{ takeFails,partial:!takeFails }), borrowed=transport(pins)
    const result=await run(pins,borrowed.pool)
    retained(result,pins,takeFails?'TAKE_FAILED':'INVALID_HANDOFF')
    assert.equal(result.database?.settlement,'NOT_STARTED'); assert.equal(borrowed.state.connects,0)
    assert.equal(pins.state.releases,0); assert.equal(pins.state.transferred,!takeFails)
    assert.deepEqual(await counts(f),empty)
  }
  // Caller omission does not remove a protected RO binding from the real core.
  const incompleteRefs=references.slice(0,-1), incomplete=group(incompleteRefs)
  const missing=await run(incomplete,pool,f.request,incompleteRefs)
  assert.equal(missing.database?.settlement,'ROLLED_BACK'); assert.equal(missing.pins.disposition,'RELEASED')
  if (missing.database && !missing.database.ok) { assert.equal(missing.database.error.code,'INITIAL_AGENT_DIRECTORY') }
  assert.deepEqual(await counts(f),empty)

  const pins=group(references), checkout=boundary(), commit=boundary()
  const borrowed=transport(pins,{ checkout:checkout.control,commit:commit.control })
  const mutable=structuredClone(f.request), mutableContext={ ...f.context,controller:{ ...controller } }, mutableRefs=[...references]
  let delivered=false
  const pending=reserveInitialAgentAttemptWithPreparedPins(borrowed.pool,mutableContext,mutable,authority,mutableRefs,pins.owner)
    .then(result=>{ delivered=true; return result })
  assert.equal(pins.state.transferred,true); await checkout.entered
  // The wrapper must capture before the first checkout await, not merely rely
  // on the core's later capture when the engine invokes its callback.
  borrowed.pool.connect=async()=>{ throw new Error('late connect replacement') }
  Object.assign(mutable,{ planDigest:'0'.repeat(64),expectedUnitRevision:counter('row:runtime-unit','999'),bindings:[] })
  Object.assign(mutable.claim,{ executionToken:logicalId('runtime-command-execution',randomUUID()) })
  Object.assign(mutable.claim.identity.originalEnvelope,{ executionEpoch:counter('execution-epoch','999') })
  Object.assign(mutableContext.controller,{ owner:'changed-after-checkout' }); mutableRefs.length=0
  checkout.open(); await commit.entered
  assert.equal(delivered,false); assert.equal(pins.state.held.size,3); assert.equal(pins.state.releases,0)
  commit.open()
  const first=await pending
  assert.equal(first.engineError,null); assert.ok(first.database?.ok)
  if (!first.database?.ok) { assert.fail('first original reservation must commit') }
  assert.equal(first.database.value.disposition,'RESERVED'); assert.equal(first.database.value.planDigest,f.request.planDigest)
  assert.equal(first.database.value.attemptId,f.plan.identity.attemptId); assert.equal(first.database.value.storageGrants.length,2)
  assert.equal(first.pins.disposition,'RELEASED'); assert.equal(pins.state.releases,1); assert.equal(pins.state.held.size,0)
  assert.equal(first.kubernetesExecutionAuthorized,false); assert.equal(first.physicalPinIssuerImplemented,false)
  const reservedCounts={ attempts:'1',execution:'1',storage:'2',mounts:'0',audit:'1',outbox:'1' }
  assert.deepEqual(await counts(f),reservedCounts)
  const replayPins=group(references), replay=await run(replayPins)
  assert.ok(replay.database?.ok)
  if (!replay.database?.ok) { assert.fail('original exact reservation replay must commit') }
  assert.deepEqual(replay.database.value,{ ...first.database.value,disposition:'REPLAYED' })
  assert.equal(replay.pins.disposition,'RELEASED'); assert.equal(replayPins.state.releases,1)

  const noCheckoutPins=group(references), noCheckout=transport(noCheckoutPins,{ checkoutError:new DurableDatabaseError('08006') })
  const notStarted=await run(noCheckoutPins,noCheckout.pool)
  assert.equal(notStarted.database?.settlement,'NOT_STARTED'); assert.equal(notStarted.pins.disposition,'RELEASED')
  assert.equal(noCheckoutPins.state.releases,1); assert.equal(noCheckoutPins.state.held.size,0)

  const rollbackPins=group(references), rollback=boundary(), rollbackPool=transport(rollbackPins,{ rollback:rollback.control })
  const rejected=run(rollbackPins,rollbackPool.pool,{ ...f.request,planDigest:'0'.repeat(64) })
  await rollback.entered
  assert.equal(rollbackPins.state.held.size,3); assert.equal(rollbackPins.state.releases,0)
  rollback.open()
  const rolledBack=await rejected
  assert.equal(rolledBack.database?.settlement,'ROLLED_BACK'); assert.equal(rolledBack.pins.disposition,'RELEASED')
  assert.equal(rollbackPins.state.releases,1)
  // COMMIT actually reaches PG, but both its acknowledgement and ROLLBACK
  // observation are lost. Destroying the borrowed client is NOT pin settlement.
  const unknownPins=group(references), uncertainTransport=transport(unknownPins,{ unknown:true })
  const unknown=await run(unknownPins,uncertainTransport.pool)
  assert.equal(unknown.database?.settlement,'UNCONFIRMED'); assert.equal(unknown.engineError,null)
  assert.equal(unknown.database?.commitOutcome,'UNKNOWN'); assert.equal(uncertainTransport.state.destroyed,true)
  retained(unknown,unknownPins,'UNCONFIRMED'); assert.equal(unknownPins.state.releases,0)
  const hostile=Object.defineProperty(new Error('synthetic checkout details'),'code',{ get() { throw new Error('synthetic sanitizer rejection') } })
  const escapedPins=group(references), escapedTransport=transport(escapedPins,{ checkoutError:hostile })
  const escaped=await run(escapedPins,escapedTransport.pool)
  assert.equal(escaped.database,null); assert.equal(escaped.engineError?.code,'INITIAL_AGENT_TRANSACTION_ENGINE_REJECTED')
  retained(escaped,escapedPins,'ENGINE_REJECTED'); assert.equal(escapedPins.state.releases,0)
  const releasePins=group(references,{ releaseFails:true }), cleanupTransport=transport(releasePins,{ cleanupFails:true })
  const releaseFailed=await run(releasePins,cleanupTransport.pool)
  assert.equal(releaseFailed.database?.settlement,'COMMITTED'); assert.equal(releaseFailed.database?.cleanupFailed,true)
  assert.ok(releaseFailed.database?.ok)
  if (releaseFailed.database?.ok) { assert.equal(releaseFailed.database.value.disposition,'REPLAYED') }
  retained(releaseFailed,releasePins,'RELEASE_FAILED'); assert.equal(releasePins.state.releases,1)
  if (releaseFailed.pins.disposition==='RETAINED') {
    assert.equal(releaseFailed.pins.releaseError?.code,'INITIAL_AGENT_PINS_RELEASE_FAILED')
    assert.equal(releaseFailed.pins.releaseError?.message.includes('private'),false)
  }
  assert.deepEqual(await counts(f),reservedCounts)
  const after=await rows()
  for (const table of tables) {
    const available=new Map<string,number>()
    for (const digest of after[table]) { available.set(digest,(available.get(digest)??0)+1) }
    for (const digest of original[table]) { assert.ok((available.get(digest)??0)>0,`original ${table} row missing`); available.set(digest,available.get(digest)!-1) }
  }
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows,ledger)
  t.diagnostic(JSON.stringify({ databaseOid:actual.oid,system:actual.system,seedBackendPid:actual.backend_pid,
    providerCalls:0,podCalls:0,physicalIssuer:false,ddl:0,preparedOwner:'synthetic-only' }))
})

