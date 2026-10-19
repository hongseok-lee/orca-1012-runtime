import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createDurablePool } from '../db/connection.ts'
import { applyMigrations,readMigrations } from '../db/migrate.ts'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import { seedWriterLifecycle } from './writer-lifecycle-fixtures.mts'
import { reconcileOrphanedAttempt } from './orphan-reconcile.ts'
import { observeAgentPod } from './agent-pod-stop-evidence.ts'
import { claimOwnerlessWakeRetirement } from './ownerless-wake-retirement.ts'
import { api,terminalPod } from './agent-pod-stop-fixtures.mts'
import { harness } from './kubernetes-pod-auth-fixtures.mts'

if(!/^orca_writer_lifecycle_[a-z0-9_]+$/.test(process.env.PGDATABASE??''))throw new Error('Owned writer test DB required')
const pool=createDurablePool({max:3})
await applyMigrations(pool,await readMigrations(process.env.ORCA_WRITER_TEST_SOURCE+'/src/main/durable-runtime/db/migrations'))
try {
await test('writer lifecycle PG: missing Pod retains writer, terminal sandbox releases it and takeover continues',async()=>{
 const f=await seedWriterLifecycle(pool),c=f.candidate
 await pool.query("UPDATE durable_runtime.runtime_units SET phase='BLOCKED' WHERE id=$1",[c.runtimeUnitId])
 const gone={state:'GONE' as const,podName:c.podName,podUid:c.podUid,observedUid:null,observedAt:new Date().toISOString(),stopping:false,stopEvidence:null}
 for(let i=0;i<2;i++) {const r=await reconcileOrphanedAttempt(pool,f.controller,c,gone,'fixture');assert.ok(r.ok);assert.equal(r.value.status,'BLOCKED')}
 const before=(await pool.query('SELECT epoch::text,writer_attempt_id,access_state FROM durable_runtime.storage_bindings WHERE id=$1',[f.binding])).rows[0]
 assert.deepEqual(before,{epoch:'0',writer_attempt_id:c.attemptId,access_state:'REVOKING'})
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM durable_runtime.runtime_audit_events WHERE attempt_id=$1 AND kind='AGENT_WRITER_STOP_BLOCKED'",[c.attemptId])).rows[0].n,1)
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM durable_runtime.notifications WHERE incident_key=$1",['writer-stop:'+c.attemptId])).rows[0].n,1)
 const terminal=terminalPod();terminal.metadata.uid=c.podUid;terminal.metadata.name=c.podName
 terminal.metadata.annotations['orca.dev/attempt-id']=c.attemptId;terminal.metadata.labels['orca.dev/runtime-unit']=c.runtimeUnitId
 const observed=await observeAgentPod(api,c,new AbortController().signal,harness([{body:terminal}]).transport)
 const stale=await reconcileOrphanedAttempt(pool,{...f.controller,term:'1'},c,observed,'fixture');assert.equal(stale.ok,false)
 const adopted=await claimOwnerlessWakeRetirement(pool,f.controller,f.operation);assert.equal(adopted?.podUid,c.podUid)
 assert.equal((await pool.query('SELECT controller_term::text FROM durable_runtime.operations WHERE id=$1',[f.operation])).rows[0].controller_term,'2')
 const result=await reconcileOrphanedAttempt(pool,f.controller,c,observed,'fixture');assert.ok(result.ok);assert.equal(result.value.status,'RECONCILED')
 assert.deepEqual((await pool.query('SELECT epoch::text,writer_attempt_id,access_state FROM durable_runtime.storage_bindings WHERE id=$1',[f.binding])).rows[0],{epoch:'1',writer_attempt_id:null,access_state:'VERIFIED'})
 assert.equal((await pool.query('SELECT state FROM durable_runtime.notifications WHERE incident_key=$1',['writer-stop:'+c.attemptId])).rows[0].state,'RESOLVED')
 assert.deepEqual((await pool.query('SELECT intake_status FROM durable_runtime.messages WHERE session_id=$1 ORDER BY seq',[f.session])).rows.map(r=>r.intake_status),['DURABLE','UNKNOWN'])
 const next=randomUUID()
 await pool.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status)
   VALUES($1,$2,2,'COLD','fixture-new-pod','fixture-new-incarnation',0,'{}','RESERVED')`,[next,c.runtimeUnitId])
 await pool.query("UPDATE durable_runtime.runtime_units SET active_attempt_id=$2,phase='PROVISIONING' WHERE id=$1",[c.runtimeUnitId,next])
 await pool.query("UPDATE durable_runtime.storage_bindings SET writer_attempt_id=$2,access_state='RESERVED' WHERE id=$1",[f.binding,next])
 await pool.query("INSERT INTO durable_runtime.storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch,state) VALUES($1,$2,$3,1,'RESERVED')",[randomUUID(),f.binding,next])
 const old=await reconcileOrphanedAttempt(pool,f.controller,c,observed,'fixture');assert.equal(old.ok,false)
 assert.equal((await pool.query('SELECT writer_attempt_id FROM durable_runtime.storage_bindings WHERE id=$1',[f.binding])).rows[0].writer_attempt_id,next)
 assert.equal(counter('execution-epoch','2'),'2')
})
await test('ownerless WAKE takeover preserves executing command identity without replay',async()=>{
 const f=await seedWriterLifecycle(pool),command=randomUUID(),token=randomUUID()
 await pool.query(`INSERT INTO durable_runtime.runtime_commands(id,operation_id,runtime_unit_id,command_name,original_controller_term,
   step_revision,pod_target,execution_epoch,intent_revision,input_hash,input,state,owner_controller_term,executor_id,execution_token,claimed_at)
   VALUES($1,$2,$3,'ensureAttempt',1,0,'CREATE_WITHOUT_POD',1,0,$4,'{}','EXECUTING',1,'fixture-executor',$5,clock_timestamp())`,
 [command,f.operation,f.candidate.runtimeUnitId,'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',token])
 assert.equal(await claimOwnerlessWakeRetirement(pool,{...f.controller,owner:'stale-controller'},f.operation),null)
 const result=await claimOwnerlessWakeRetirement(pool,f.controller,f.operation)
 assert.equal(result?.podUid,f.candidate.podUid)
 assert.deepEqual((await pool.query('SELECT state,original_controller_term::text,owner_controller_term::text,execution_token FROM durable_runtime.runtime_commands WHERE id=$1',[command])).rows[0],
  {state:'EXECUTING',original_controller_term:'1',owner_controller_term:'2',execution_token:token})
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM durable_runtime.runtime_command_history WHERE command_id=$1 AND stage='TAKEN_OVER'",[command])).rows[0].n,1)
})
} finally {await pool.end()}
