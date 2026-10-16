import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { readMigrations } from '../db/migrate.ts'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import type { GatewayContext, VerifiedControllerIdentity, CommandClaim } from '../runtime/gateway/types.ts'
import { fixture, intent, executor } from '../lifecycle/verification-fixtures.mts'
import { requestUnitIntent } from '../lifecycle/intent.ts'
import { CONTROLLER_SCOPE, CONTROLLER_DATASET, ControllerInstance, type LeaseRecord } from './instance.ts'
import { releaseControllerLease } from './lease.ts'
import { ControllerLeaseSession } from './session.ts'
import { runControllerPass, type ControllerPassRequest } from './pass.ts'
import type { TakeoverCommand } from './takeover.ts'

// Root assigns an existing isolated, schema-ready DB after source review.
// No migration/reset, provider/Pod execution, deployed HA or identity issuer.
const database=process.env.ORCA_CONTROLLER_COMMAND_CONTEXT_DATABASE
const oid=process.env.ORCA_CONTROLLER_COMMAND_CONTEXT_DATABASE_OID
const system=process.env.ORCA_CONTROLLER_COMMAND_CONTEXT_SYSTEM_IDENTIFIER
const migrationsPath=process.env.ORCA_CONTROLLER_COMMAND_CONTEXT_MIGRATIONS
const leaseEvidencePath=process.env.ORCA_CONTROLLER_COMMAND_CONTEXT_LEASE_EVIDENCE
if (process.env.ORCA_CONTROLLER_COMMAND_CONTEXT_APPROVED!=='root-first-verification' ||
    !database || database==='orca_dev' || !/^orca_[a-z0-9_]+$/u.test(database) || database!==process.env.PGDATABASE ||
    !oid || !/^[1-9][0-9]*$/u.test(oid) || !system || !/^[0-9]+$/u.test(system) || !migrationsPath || !leaseEvidencePath) {
  throw new Error('Root-approved existing isolated DB/OID/system/migration inputs required')
}
const pool=createDurablePool({ database,max:3,connectionTimeoutMillis:5000,statement_timeout:5000,
  application_name:'controller-command-context-first' })
const tables=['runtime_units','operations','runtime_commands','runtime_command_history','runtime_audit_events',
  'outbox_events','rpc_receipts','agents','workspaces','sessions','runtime_members','runtime_member_storage_bindings',
  'storage_domains','storage_bindings'] as const
const digest=(value: string)=>createHash('sha256').update(value).digest('hex')
async function originalRows() {
  const rows: Record<string,string[]>={}
  for (const table of tables) {
    rows[table]=(await pool.query<{ body:string }>(`SELECT to_jsonb(t)::text AS body FROM durable_runtime.${table} t`))
      .rows.map(row=>digest(row.body)).sort()
  }
  return rows
}

await test('committed execute and original lookup receive the frozen original controller/Unit/operation context', async t=>{
  const session=new ControllerLeaseSession(pool,new ControllerInstance(CONTROLLER_SCOPE),
    { revision:'command-context-fixture',durationMs:60000 })
  let confirmed: LeaseRecord | null=null
  t.after(async()=>{
    try {
      if (session.lease) { await session.release() }
      else if (confirmed) { await releaseControllerLease(pool,session.instance,confirmed) }
    } finally { await pool.end() }
  })
  const actual=await withDurableTransaction(pool,async tx=>{
    const row=(await tx.query<{ database:string;oid:string;system:string;pid:number }>(`SELECT current_database() AS database,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS pid`)).rows[0]
    assert.equal(row.database,database); assert.equal(row.oid,oid); assert.equal(row.system,system)
    assert.deepEqual((await tx.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows,[{ dataset_name:CONTROLLER_DATASET }])
    return row
  })
  const migrations=await readMigrations(migrationsPath)
  const ledger=(await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.deepEqual(ledger.map(row=>[row.version,row.checksum]),migrations.map(row=>[row.version,row.checksum]))
  // Root permits this isolated control row's normal acquire/release only.
  // Record the actual PG clock/expiry privately; never expire/delete it here.
  const control=(await pool.query(`SELECT c.scope,c.owner,c.term,c.revision,c.expires_at,
    clock_timestamp() AS pg_clock,coalesce(c.expires_at>clock_timestamp(),false) AS unexpired
    FROM (SELECT 1) guard LEFT JOIN durable_runtime.controller_leases c ON c.scope=$1`,[CONTROLLER_SCOPE])).rows[0]
  await writeFile(leaseEvidencePath,`${JSON.stringify({ scope:CONTROLLER_SCOPE,control })}\n`,{ flag:'wx',mode:0o600 })
  assert.equal(control.unexpired,false,'existing isolated control lease must be expired/absent before acquire')
  const before=await originalRows()
  assert.equal((await session.acquire()).status,'ACTIVE')
  const lease=session.lease; assert.ok(lease)
  confirmed=lease
  const marker=Symbol('synthetic fixture provenance, not a production identity brand')
  // SAFETY: isolated fixture nominal identity from its real confirmed session;
  // this is not the private worker authentication issuer or provider proof.
  const controller={ scope:lease.scope,owner:lease.owner,term:lease.term,[marker]:true } as VerifiedControllerIdentity
  const expected=Object.freeze({ scope:controller.scope,owner:controller.owner,term:controller.term })
  const a=await fixture(pool,1), b=await fixture(pool,1)
  await requestUnitIntent(pool,await intent(pool,a)); await requestUnitIntent(pool,await intent(pool,b))
  const operations=(await pool.query<{ id:string;runtime_unit_id:string }>(
    'SELECT id,runtime_unit_id FROM durable_runtime.operations WHERE runtime_unit_id=ANY($1::uuid[]) AND result IS NULL',[[a.unit,b.unit]])).rows
  assert.equal(operations.length,2)
  const operationFor=(unit:string)=>{ const op=operations.find(row=>row.runtime_unit_id===unit); assert.ok(op); return op.id }
  const mutationKeys=new Map<string,string>([[a.unit,randomUUID()],[b.unit,randomUUID()]])
  const plan: NonNullable<ControllerPassRequest['planStep']>=(operation,unit)=>mutationKeys.has(unit.id)
    ? { mutationKey:mutationKeys.get(unit.id)!,step:'ENSURE_ATTEMPT',executorId:executor,input:{ fixtureOnly:'command-context' } } : null
  let executeCalls=0, lookupCalls=0, legacyExecutes=0, legacyLookups=0
  let originalClaim: CommandClaim | null=null
  async function checkContext(context: Readonly<GatewayContext>, unit:string, operation:string, commandId:string) {
    assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.controller))
    assert.equal(context.runtimeUnitId,unit); assert.equal(context.operationId,operation)
    assert.deepEqual({ scope:context.controller.scope,owner:context.controller.owner,term:context.controller.term },expected)
    assert.equal(Object.getOwnPropertyDescriptor(context.controller,marker)?.value,true)
    assert.equal(Reflect.set(context,'runtimeUnitId',randomUUID()),false)
    assert.equal(Reflect.set(context.controller,'owner','changed'),false)
    const stored=(await pool.query('SELECT id,runtime_unit_id,operation_id,state,owner_controller_term FROM durable_runtime.runtime_commands WHERE id=$1',[commandId])).rows[0]
    assert.deepEqual(stored,{ id:commandId,runtime_unit_id:unit,operation_id:operation,state:'EXECUTING',owner_controller_term:expected.term })
    assert.equal((await pool.query(`SELECT 1 FROM durable_runtime.rpc_receipts WHERE principal_id=$1
      AND session_scope=$2 AND method='lifecycle.prepare-reconcile-step' AND operation_key=$3`,
    [expected.owner,`runtime-unit:${unit}`,mutationKeys.get(unit)])).rowCount,1,
    'callback observes the real committed prepare receipt through a separate checkout')
  }
  const execute: NonNullable<ControllerPassRequest['executeCommitted']>=async(claim,signal,context)=>{
    assert.equal(signal.aborted,false); assert.equal(claim.controllerTerm,expected.term)
    assert.equal(claim.identity.originalEnvelope.operationId,operationFor(a.unit))
    await checkContext(context,a.unit,operationFor(a.unit),claim.commandId)
    originalClaim=claim; executeCalls++
  }
  const mutable: ControllerPassRequest={ controller,maximumWork:100,externalBudgetMs:10000,
    planStep:(operation,unit)=>unit.id===a.unit?plan(operation,unit):null,executeCommitted:execute }
  const firstPending=runControllerPass(pool,session,mutable)
  // Capture occurs before assertCurrent's first await, including the identity
  // and callback references later used to build the newly forwarded context.
  Object.assign(controller,{ scope:'changed',owner:'changed',term:counter('controller-term','0') })
  Object.assign(mutable,{ executeCommitted:async()=>{ assert.fail('late callback replacement') } })
  const first=await firstPending
  assert.equal(first.status,'FINISHED'); assert.equal(executeCalls,1); assert.ok(originalClaim)
  assert.equal(first.items.filter(item=>item.disposition==='COMMITTED_EXECUTE').length,1)

  // Existing callbacks with only the first two parameters remain assignable
  // and are invoked through the actual pass, not a direct fixture call.
  const legacyExecute: NonNullable<ControllerPassRequest['executeCommitted']>=async(claim,signal)=>{
    assert.equal(signal.aborted,false); assert.equal(claim.identity.originalEnvelope.operationId,operationFor(b.unit)); legacyExecutes++
  }
  const lookup: NonNullable<ControllerPassRequest['lookupOriginal']>=async(command,signal,context)=>{
    assert.equal(signal.aborted,false); assert.ok(originalClaim)
    assert.equal(command.id,originalClaim.commandId)
    assert.equal(command.execution_token,originalClaim.executionToken)
    await checkContext(context,a.unit,operationFor(a.unit),command.id); lookupCalls++
  }
  // Preserve the fixture's same nominal object shape without using the mutated caller DTO.
  const capturedController={ ...controller,...expected }
  // Each pass prepares a new request; the original command remains the lookup target.
  mutationKeys.set(a.unit,randomUUID()); mutationKeys.set(b.unit,randomUUID())
  const second=await runControllerPass(pool,session,{ controller:capturedController,maximumWork:100,externalBudgetMs:10000,
    planStep:plan,executeCommitted:legacyExecute,lookupOriginal:lookup })
  assert.equal(second.status,'FINISHED'); assert.equal(legacyExecutes,1); assert.equal(lookupCalls,1); assert.equal(executeCalls,1)
  const originalIds=(await pool.query<{ id:string }>(
    'SELECT id FROM durable_runtime.runtime_commands WHERE runtime_unit_id=ANY($1::uuid[]) ORDER BY id',[[a.unit,b.unit]])).rows.map(row=>row.id)
  assert.equal(originalIds.length,2)
  const legacyLookup: NonNullable<ControllerPassRequest['lookupOriginal']>=async(command: TakeoverCommand,signal: AbortSignal)=>{
    assert.equal(signal.aborted,false); assert.ok(originalIds.includes(command.id)); legacyLookups++
  }
  mutationKeys.set(a.unit,randomUUID()); mutationKeys.set(b.unit,randomUUID())
  const third=await runControllerPass(pool,session,{ controller:capturedController,maximumWork:100,externalBudgetMs:10000,
    planStep:plan,executeCommitted:async()=>{ assert.fail('pending originals must only be looked up') },lookupOriginal:legacyLookup })
  assert.equal(third.status,'FINISHED'); assert.equal(legacyLookups,2)
  assert.equal((await pool.query('SELECT count(*)::text AS n FROM durable_runtime.runtime_commands WHERE runtime_unit_id=ANY($1::uuid[])',[[a.unit,b.unit]])).rows[0].n,'2')
  const after=await originalRows()
  for (const table of tables) {
    const remaining=new Map<string,number>()
    for (const hash of after[table]) { remaining.set(hash,(remaining.get(hash)??0)+1) }
    for (const hash of before[table]) { assert.ok((remaining.get(hash)??0)>0,`original ${table} row missing`); remaining.set(hash,remaining.get(hash)!-1) }
  }
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows,ledger)
  t.diagnostic(JSON.stringify({ databaseOid:actual.oid,system:actual.system,seedBackendPid:actual.pid,
    executeCalls,lookupCalls,legacyExecutes,legacyLookups,providerCalls:0,podCalls:0,authenticationVerified:false,ddl:0 }))
})
