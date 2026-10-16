import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { QueryResultRow } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from '../db/connection.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { readMigrations } from '../db/migrate.ts'
import type { AdmissionShape } from '../resources/policy/admission.ts'
import { compareAdmission } from '../resources/policy/admission.ts'
import { createAgentPodPlanner } from './agent-pod-plan.ts'
import { recordAgentPodPlan } from './agent-pod-plan-records.ts'
import type { GatewayContext, VerifiedControllerIdentity } from './gateway/types.ts'
import { recordInitialAgentResourceProfile } from './initial-agent-resource-profile.ts'

// Root must allocate the existing isolated SQL23 DB and current controller.
// No schema/reset, supplied lease mutation, Pod/provider/admission or retry.
const database = process.env.ORCA_INITIAL_PROFILE_DATABASE, oid = process.env.ORCA_INITIAL_PROFILE_DATABASE_OID
const migrationsPath = process.env.ORCA_INITIAL_PROFILE_MIGRATIONS
const scope = process.env.ORCA_INITIAL_PROFILE_CONTROLLER_SCOPE, owner = process.env.ORCA_INITIAL_PROFILE_CONTROLLER_OWNER
const term = process.env.ORCA_INITIAL_PROFILE_CONTROLLER_TERM
if (process.env.ORCA_INITIAL_PROFILE_APPROVED !== 'root-first-verification' ||
    !database || database === 'orca_dev' || !/^orca_[a-z0-9_]+$/u.test(database) || database !== process.env.PGDATABASE ||
    !oid || !/^[1-9][0-9]*$/u.test(oid) || !migrationsPath || !scope || !owner || !term) {
  throw new Error('Root-approved existing isolated SQL23 database/OID/current controller inputs required')
}
const pool = createDurablePool({ database, max: 3, application_name: 'initial-agent-profile-first' })
const dataset = 'orca-1012-dev-v1', kind = 'INITIAL_AGENT_RESOURCE_PROFILE_RECORDED'
// SAFETY: fixture-only nominal identity. Root supplies a bounded current lease;
// this cast is not a production controller issuer or external authentication.
const controller = Object.freeze({ scope, owner, term: counter('controller-term', term) }) as unknown as VerifiedControllerIdentity
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const reject = (promise: Promise<unknown>, code: string) => assert.rejects(promise,
  error => error instanceof DurableDatabaseError && error.code === code)
const tables = ['controller_leases','runtime_units','operations','agent_pod_plans','resource_profiles',
  'resource_unit_state','resource_reservations','resource_budget_scopes','attempts','execution_grants',
  'agents','workspaces','sessions','runtime_members','storage_domains','storage_bindings',
  'storage_write_grants','runtime_audit_events','outbox_events'] as const
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
  assert.equal(actual.database,database); assert.equal(actual.oid,oid); assert.equal(actual.system,'7696101282789175327')
  assert.deepEqual((await tx.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows,[{ dataset_name:dataset }])
  assert.equal((await tx.query(`SELECT scope FROM durable_runtime.controller_leases
    WHERE scope=$1 AND owner=$2 AND term=$3 AND expires_at>clock_timestamp()`,[scope,owner,term])).rowCount,1)
  return actual
}
async function seed(syntheticController = controller) {
  const unit = logicalId('runtime-unit',randomUUID()), operation = logicalId('operation',randomUUID())
  const session = randomUUID(), agent = randomUUID(), workspace = randomUUID(), binding = randomUUID(), leaf = randomUUID()
  const context: GatewayContext = Object.freeze({ runtimeUnitId:unit, operationId:operation, controller:syntheticController })
  const policy = { namespace:'initial-profile-fixture',dataset,image:`example.invalid/agent@sha256:${'1'.repeat(64)}`,
    entrypoint:{ command:['/usr/local/bin/node'],args:['-e','setInterval(() => {}, 3600000)'] },
    paths:{ home:'/agent/home',claudeState:'/agent/home/.claude',codexState:'/agent/home/.codex',checkout:'/agent/project' },
    nfsServer:'nfs.fixture.svc.cluster.local',protectedExportRoot:`/exports/runtime-domains/${dataset}`,
    protectedMounts:[{ key:'home',clientPath:'/agent' }],
    shared:{ claimName:'shared-fixture',claimUid:'shared-claim',pvUid:'shared-pv',serverPath:`/exports/shared/${dataset}` } }
  const plan = createAgentPodPlanner(policy).plan({ identity:{ unitId:unit,operationId:operation,attemptId:randomUUID(),
    resourceName:`orca-unit-${operation}`,executionEpoch:'0',intentRevision:'0',specHash:'a'.repeat(64) },
    protectedBindings:[{ key:'home',bindingId:binding,leafId:leaf,claimName:`protected-${leaf}`,claimUid:`claim-${leaf}`,
      pvUid:`pv-${leaf}`,serverPath:`/exports/runtime-domains/${dataset}/${leaf}`,mode:'RW' }],
    profile:{ revision:'7',cpuMilli:777,memoryMi:1024,ephemeralMi:2048,temporaryMi:256 } })
  return withDurableTransaction(pool,async tx => {
    await identity(tx) // Same-Pool actual identity precedes each additive seed.
    if (syntheticController !== controller) {
      assert.notEqual(syntheticController.scope,scope)
      await tx.query(`INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at)
        VALUES($1,$2,$3,clock_timestamp()+interval '10 minutes')`,
      [syntheticController.scope,syntheticController.owner,syntheticController.term])
    }
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')",[unit])
    await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch,external_resource_name)
      VALUES($1,$2,'WAKE',0,$3,$4,'ENSURE_ATTEMPT',0,$5)`,[operation,unit,syntheticController.scope,syntheticController.term,plan.identity.resourceName])
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'codex')",[agent])
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'synthetic initial profile','READY')",[workspace,`initial-profile:${workspace}`])
    await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')",[session,agent,workspace])
    await tx.query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES('initial-profile-fixture',$1)",[leaf])
    await tx.query(`INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state)
      VALUES($1,'initial-profile-fixture',$2,$3,'UNVERIFIED')`,[binding,leaf,`/${dataset}/${leaf}`])
    await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)',[unit,session,binding])
    const stored = await recordAgentPodPlan(tx,context,plan)
    return { context,plan,session,input:{ planDigest:stored.record.planDigest,policyRevision:'4' } }
  })
}
type Fixture = Awaited<ReturnType<typeof seed>>
const record = (f: Fixture, input = f.input, context = f.context) =>
  withDurableTransaction(pool,tx => recordInitialAgentResourceProfile(tx,context,input))
async function counts(f: Fixture) {
  return (await pool.query(`SELECT
    (SELECT count(*)::text FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$1) AS profiles,
    (SELECT count(*)::text FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$1 AND kind=$2) AS audit,
    (SELECT count(*)::text FROM durable_runtime.outbox_events WHERE aggregate_id=$1 AND event->>'kind'=$2) AS outbox,
    (SELECT count(*)::text FROM durable_runtime.attempts WHERE runtime_unit_id=$1) AS attempts,
    (SELECT count(*)::text FROM durable_runtime.execution_grants WHERE runtime_unit_id=$1) AS grants,
    (SELECT count(*)::text FROM durable_runtime.resource_unit_state WHERE runtime_unit_id=$1) AS heads,
    (SELECT count(*)::text FROM durable_runtime.resource_reservations WHERE runtime_unit_id=$1) AS reservations`,[f.context.runtimeUnitId,kind])).rows[0]
}
const empty = { profiles:'0',audit:'0',outbox:'0',attempts:'0',grants:'0',heads:'0',reservations:'0' }
async function unchangedIdentity(f: Fixture) {
  return (await pool.query(`SELECT to_jsonb(u) AS unit,to_jsonb(o) AS operation FROM durable_runtime.runtime_units u
    JOIN durable_runtime.operations o ON o.runtime_unit_id=u.id WHERE u.id=$1 AND o.id=$2`,[f.context.runtimeUnitId,f.context.operationId])).rows[0]
}

await test('initial Agent declared resource profile: atomic data-only record and exact replay',async t => {
  t.after(() => pool.end())
  const actual = await withDurableTransaction(pool,identity)
  const migrations = await readMigrations(migrationsPath)
  assert.equal(migrations.length,23)
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.deepEqual(ledger.map(r => [r.version,r.checksum]),migrations.map(r => [r.version,r.checksum]))
  const original = await rows(), a = await seed(), before = await unchangedIdentity(a)
  const result = await record(a)
  assert.equal(result.disposition,'RECORDED'); assert.equal(result.visibility,'TRANSACTION_LOCAL')
  assert.equal(result.authority,'DATA_ONLY'); assert.equal(result.admissionObserved,false); assert.equal(result.executionAuthorized,false)
  assert.equal(result.profileRevision,'7'); assert.equal(result.policyRevision,'4')
  assert.equal(result.recordedUnitRevision,'0'); assert.equal(result.currentUnitRevision,'0')
  assert.deepEqual(await counts(a),{ ...empty,profiles:'1',audit:'1',outbox:'1' })
  assert.deepEqual(await unchangedIdentity(a),before)
  const p = (await pool.query<{ container_resources: AdmissionShape; previous_good_revision: string | null; learned_memory_floor: string | null }>(
    'SELECT * FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$1',[a.context.runtimeUnitId])).rows[0]
  assert.deepEqual(p.container_resources,{ sourceRef:`initial-agent-plan:v1:${a.input.planDigest}`,
    profileId:`initial-agent-profile:v1:${a.context.runtimeUnitId}:7`,runtimeUnitId:a.context.runtimeUnitId,containerIdentity:'agent',
    observed:false,complete:true,containers:[{ name:'agent',memoryBytes:'1073741824',cpuMillicores:'777',memoryLimitPresent:false,
      cpuLimitPresent:false,restartableInit:false }],initContainers:[],overheadMemoryBytes:'0',overheadCpuMillicores:'0',spot:true,oneUnitPerNode:true })
  assert.equal(p.previous_good_revision,null); assert.equal(p.learned_memory_floor,null)
  assert.equal(compareAdmission(p.container_resources,null,null).status,'NEEDS_ADMISSION_EVIDENCE')
  assert.equal(compareAdmission(p.container_resources,p.container_resources,null).status,'NEEDS_ADMISSION_EVIDENCE')
  const event = (await pool.query('SELECT next_state FROM durable_runtime.runtime_audit_events WHERE id=$1',[result.eventId])).rows[0].next_state
  assert.equal(event.planDigest,a.input.planDigest); assert.equal(event.podSpecSHA256,a.plan.podSpecSHA256)
  assert.equal(event.shapeDigest,result.shapeDigest); assert.equal(event.admissionObserved,false)
  assert.equal(event.ephemeralStorageRequest,'2048Mi'); assert.equal(event.ephemeralStorageLimit,'2048Mi'); assert.equal(event.temporarySizeLimit,'256Mi')
  assert.deepEqual((await pool.query('SELECT event FROM durable_runtime.outbox_events WHERE id=$1',[result.eventId])).rows[0].event,event)
  assert.deepEqual(await record(a),{ ...result,disposition:'REPLAYED' })
  assert.deepEqual(await counts(a),{ ...empty,profiles:'1',audit:'1',outbox:'1' })
  await reject(record(a,{ ...a.input,policyRevision:'5' }),'INITIAL_AGENT_PROFILE_CONFLICT')
  await reject(record(a,{ ...a.input,planDigest:'0'.repeat(64) }),'INITIAL_AGENT_PROFILE_PLAN')
  // Only a NEW synthetic lease is used for this SQL data boundary. This is not
  // a lease takeover API test. The Root-supplied control row is never changed.
  const oldCreator = Object.freeze({ scope:`synthetic-profile-replay:${randomUUID()}`,owner:`synthetic-old:${randomUUID()}`,
    term:counter('controller-term','1') }) as unknown as VerifiedControllerIdentity
  const taken = await seed(oldCreator), takenResult = await record(taken)
  const originalAudit = (await pool.query('SELECT * FROM durable_runtime.runtime_audit_events WHERE id=$1',[takenResult.eventId])).rows
  const originalOutbox = (await pool.query('SELECT * FROM durable_runtime.outbox_events WHERE id=$1',[takenResult.eventId])).rows
  await reject(withDurableTransaction(pool,async tx => {
    const next = Object.freeze({ ...oldCreator,owner:`synthetic-new:${randomUUID()}`,term:counter('controller-term','2') })
    await tx.query('UPDATE durable_runtime.controller_leases SET owner=$2,term=2 WHERE scope=$1',[oldCreator.scope,next.owner])
    await tx.query('UPDATE durable_runtime.operations SET controller_term=2 WHERE id=$1',[taken.context.operationId])
    await tx.query('UPDATE durable_runtime.runtime_units SET revision=revision+1 WHERE id=$1',[taken.context.runtimeUnitId])
    const replay = await recordInitialAgentResourceProfile(tx,{ ...taken.context,controller:next },taken.input)
    assert.equal(replay.disposition,'REPLAYED'); assert.equal(replay.recordedUnitRevision,'0'); assert.equal(replay.currentUnitRevision,'1')
    assert.equal(replay.eventId,takenResult.eventId)
    assert.deepEqual((await tx.query('SELECT * FROM durable_runtime.runtime_audit_events WHERE id=$1',[replay.eventId])).rows,originalAudit)
    assert.deepEqual((await tx.query('SELECT * FROM durable_runtime.outbox_events WHERE id=$1',[replay.eventId])).rows,originalOutbox)
    throw new DurableDatabaseError('PROFILE_FIXTURE_TAKEOVER_ROLLBACK')
  }),'PROFILE_FIXTURE_TAKEOVER_ROLLBACK')
  assert.deepEqual(await record(taken),{ ...takenResult,disposition:'REPLAYED' })
  const bad = await seed()
  await reject(record(bad,bad.input,{ ...bad.context,controller:{ ...controller,term:counter('controller-term',BigInt(term)+1n) } }),'COMMAND_AUTHORITY_STALE')
  await reject(record(bad,bad.input,{ ...bad.context,controller:{ ...controller,owner:`wrong:${owner}` } }),'COMMAND_AUTHORITY_STALE')
  await reject(withDurableTransaction(pool,async tx => {
    await tx.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSED' WHERE id=$1",[bad.session])
    return recordInitialAgentResourceProfile(tx,bad.context,bad.input)
  }),'INITIAL_AGENT_PROFILE_SESSION_CLOSED')
  await reject(withDurableTransaction(pool,async tx => {
    await tx.query('UPDATE durable_runtime.runtime_units SET intent_revision=intent_revision+1 WHERE id=$1',[bad.context.runtimeUnitId])
    return recordInitialAgentResourceProfile(tx,bad.context,bad.input)
  }),'INITIAL_AGENT_PROFILE_STALE')
  await reject(withDurableTransaction(pool,async tx => {
    await tx.query("UPDATE durable_runtime.operations SET external_resource_name='wrong-original-name' WHERE id=$1",[bad.context.operationId])
    return recordInitialAgentResourceProfile(tx,bad.context,bad.input)
  }),'INITIAL_AGENT_PROFILE_STALE')
  assert.deepEqual(await counts(bad),empty)
  await reject(withDurableTransaction(pool,async tx => {
    await recordInitialAgentResourceProfile(tx,bad.context,bad.input)
    throw new DurableDatabaseError('PROFILE_FIXTURE_ROLLBACK')
  }),'PROFILE_FIXTURE_ROLLBACK')
  assert.deepEqual(await counts(bad),empty)
  // Failure after the profile and audit writes must roll both back.
  await reject(withDurableTransaction(pool,async tx => {
    const query = tx.query.bind(tx)
    tx.query = async function<Row extends QueryResultRow = QueryResultRow>(sql: string,values: readonly unknown[] = []) {
      if (sql.includes('INSERT INTO durable_runtime.outbox_events')) { throw new DurableDatabaseError('PROFILE_FIXTURE_OUTBOX_FAILURE') }
      return query<Row>(sql,values)
    }
    try { return await recordInitialAgentResourceProfile(tx,bad.context,bad.input) }
    finally { tx.query=query }
  }),'PROFILE_FIXTURE_OUTBOX_FAILURE')
  assert.deepEqual(await counts(bad),empty)
  // A row without this exact audit/outbox is not a successful replay.
  const partial = await seed()
  await withDurableTransaction(pool,async tx => {
    await identity(tx)
    await tx.query(`INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision)
      SELECT $1::uuid,revision,container_resources || jsonb_build_object('sourceRef',$3::text,'profileId',$4::text,'runtimeUnitId',($1::uuid)::text),policy_revision
      FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$2`,
    [partial.context.runtimeUnitId,a.context.runtimeUnitId,`initial-agent-plan:v1:${partial.input.planDigest}`,
      `initial-agent-profile:v1:${partial.context.runtimeUnitId}:7`])
  })
  await reject(record(partial),'INITIAL_AGENT_PROFILE_CONFLICT')
  assert.deepEqual(await counts(partial),{ ...empty,profiles:'1' })
  const missingOutbox = await seed()
  await withDurableTransaction(pool,async tx => {
    const query = tx.query.bind(tx)
    // Construct an intentionally incomplete NEW fixture record without DELETE
    // or history rewrite. Product writes are real except this suppressed outbox.
    tx.query = async function<Row extends QueryResultRow = QueryResultRow>(sql: string,values: readonly unknown[] = []) {
      if (sql.includes('INSERT INTO durable_runtime.outbox_events')) { return query<Row>('SELECT $1::uuid AS id',[randomUUID()]) }
      return query<Row>(sql,values)
    }
    try { await recordInitialAgentResourceProfile(tx,missingOutbox.context,missingOutbox.input) }
    finally { tx.query=query }
  })
  await reject(record(missingOutbox),'INITIAL_AGENT_PROFILE_CONFLICT')
  assert.deepEqual(await counts(missingOutbox),{ ...empty,profiles:'1',audit:'1' })
  // Another revision cannot be bypassed by writing the plan's revision.
  const conflict = await seed()
  await withDurableTransaction(pool,async tx => {
    await identity(tx)
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,1,'{}',4)",[conflict.context.runtimeUnitId])
  })
  await reject(record(conflict),'INITIAL_AGENT_PROFILE_CONFLICT')
  assert.deepEqual(await counts(conflict),{ ...empty,profiles:'1' })
  // Existing execution history rejects even if no active attempt exists now.
  const history = await seed()
  await withDurableTransaction(pool,async tx => {
    await identity(tx)
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,1,'{}',4)",[history.context.runtimeUnitId])
    await tx.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,resource_profile_revision,effective_resources,status)
      VALUES($1,$2,0,'COLD',1,'{}','RESERVED')`,[randomUUID(),history.context.runtimeUnitId])
  })
  await reject(record(history),'INITIAL_AGENT_PROFILE_NOT_INITIAL')
  assert.deepEqual(await counts(history),{ ...empty,profiles:'1',attempts:'1' })
  // First-await capture covers original input/context AND nested helper queries.
  const captured = await seed(), mutableInput = { ...captured.input }
  const mutableContext = { ...captured.context,controller:{ ...controller } }
  const capturedResult = await withDurableTransaction(pool,async tx => {
    const query = tx.query.bind(tx)
    const pending = recordInitialAgentResourceProfile(tx,mutableContext,mutableInput)
    mutableInput.planDigest='0'.repeat(64); mutableInput.policyRevision='999'
    mutableContext.controller.owner='changed-after-first-await'
    tx.query = async () => { throw new Error('Mutable query must never be reread') }
    try { return await pending } finally { tx.query=query }
  })
  assert.equal(capturedResult.disposition,'RECORDED'); assert.equal(capturedResult.policyRevision,'4')
  assert.deepEqual(await counts(captured),{ ...empty,profiles:'1',audit:'1',outbox:'1' })
  const after = await rows()
  for (const table of ['resource_unit_state','resource_budget_scopes','resource_reservations','execution_grants'] as const) {
    assert.deepEqual(after[table],original[table])
  }
  for (const table of tables) {
    const remaining = new Map<string,number>()
    for (const item of after[table]) { remaining.set(item,(remaining.get(item) ?? 0)+1) }
    for (const item of original[table]) {
      assert.ok((remaining.get(item) ?? 0)>0,`Original ${table} row missing or changed`)
      remaining.set(item,(remaining.get(item) ?? 0)-1)
    }
  }
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows,ledger)
  assert.deepEqual((await pool.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows,[{ dataset_name:dataset }])
  // Sanitized identity and counts only; no controller inputs or raw payload.
  t.diagnostic(JSON.stringify({ ...actual,callback:'initial-profile-data-only',observed:false,existingRowsPreserved:true,
    ledgerRows:ledger.length,providerCalls:0,podCalls:0,schemaWrites:0 }))
})
