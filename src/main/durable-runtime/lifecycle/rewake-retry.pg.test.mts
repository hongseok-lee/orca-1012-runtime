import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomUUID} from 'node:crypto'
import {createDurablePool} from '../db/connection.ts'
import {applyMigrations,readMigrations} from '../db/migrate.ts'
import {seedWriterLifecycle} from '../runtime/writer-lifecycle-fixtures.mts'
import {claimRewakeOperation,settleRewakeOperation} from './rewake-retry.ts'
import {requestUnitIntent,LIFECYCLE_CONTROLLER_SCOPE} from './intent.ts'
import type {VerifiedControllerIdentity} from '../runtime/gateway/types.ts'
import type {UnitIntentAuthority} from './types.ts'
import {counter,logicalId} from '../../../shared/durable-runtime/identity.ts'
import {OPS_OPERATION_SELECT,projectOpsOperation} from '../ops/operation.ts'
import type {OpsOperationRow} from '../ops/operation.ts'

if(!/^orca_rewake_retry_[a-z0-9_]+$/.test(process.env.PGDATABASE??''))throw Error('Owned retry fixture DB required')
const pool=createDurablePool({max:5})
await applyMigrations(pool,await readMigrations(process.env.ORCA_RETRY_TEST_SOURCE+'/src/main/durable-runtime/db/migrations'))
const policy={operationDeadlineMs:600000,idleDurationMs:null}
let controller={scope:LIFECYCLE_CONTROLLER_SCOPE,owner:'retry-fixture-owner',term:counter('controller-term','1')} as VerifiedControllerIdentity
await pool.query(`INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')
 ON CONFLICT(scope) DO UPDATE SET owner=excluded.owner,term=excluded.term,expires_at=excluded.expires_at`,[controller.scope,controller.owner,controller.term])
async function seed(ready=true){
 const f=await seedWriterLifecycle(pool)
 await pool.query("UPDATE durable_runtime.execution_grants SET state='REVOKED',revoked_at=clock_timestamp(),stopped_proof_ref='synthetic-fixture-stop' WHERE attempt_id=$1",[f.candidate.attemptId])
 await pool.query("UPDATE durable_runtime.storage_write_grants SET state='REVOKED',revoked_at=clock_timestamp(),revocation_proof_ref='synthetic-fixture-stop' WHERE attempt_id=$1",[f.candidate.attemptId])
 await pool.query("UPDATE durable_runtime.attempts SET stopped_at=clock_timestamp(),status='STOPPED',ready_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END WHERE id=$1",[f.candidate.attemptId,ready])
 await pool.query("UPDATE durable_runtime.runtime_units SET active_attempt_id=NULL,phase='ABSENT',desired_mode='SUSPENDED' WHERE id=$1",[f.candidate.runtimeUnitId])
 await pool.query("UPDATE durable_runtime.operations SET result='{\"state\":\"APPLIED\"}',step='READY' WHERE id=$1",[f.operation])
 await pool.query("UPDATE durable_runtime.storage_bindings SET writer_attempt_id=NULL,access_state='VERIFIED' WHERE id=$1",[f.binding])
 return f
}
const root=async(id:string)=>(await pool.query(`SELECT id,step,step_revision::text,retry_count::text,retry_limit::text,retry_at::text,deadline_at::text,
 retry_exhausted_reason,recovery_anchor_attempt_id,retry_owner,retry_owner_term::text FROM durable_runtime.operations WHERE id=$1`,[id])).rows[0]
try{
await test('one durable retry lineage survives reconnect/takeover, serializes claims/outcomes and cannot be renewed by input',async()=>{
 const f=await seed(),unit=f.candidate.runtimeUnitId
 const claims=await Promise.all([claimRewakeOperation(pool,controller,unit,policy),claimRewakeOperation(pool,controller,unit,policy)])
 const first=claims.find(Boolean)!;assert.ok(first);assert.equal(claims.filter(Boolean).length,1)
 await pool.query("UPDATE durable_runtime.operations SET step='ENSURE_ATTEMPT',step_revision=step_revision+1 WHERE id=$1",[first.operationId])
 const before=await root(first.rootOperationId)
 const stale=controller;controller={...controller,owner:'takeover-fixture-owner',term:counter('controller-term','2')}
 await pool.query('UPDATE durable_runtime.controller_leases SET owner=$2,term=$3 WHERE scope=$1',[controller.scope,controller.owner,controller.term])
 assert.equal(await claimRewakeOperation(pool,stale,unit,policy),null)
 assert.equal(await settleRewakeOperation(pool,stale,first.operationId,'OLD_OWNER'),false)
 assert.equal(await claimRewakeOperation(pool,controller,unit,policy),null)
 assert.deepEqual(await root(first.rootOperationId),before,'adoption changes controller term only, preserving stage/owner/deadline/budget')
 const settled=await Promise.all([settleRewakeOperation(pool,controller,first.operationId,'REWAKE_OWNER_LOST'),settleRewakeOperation(pool,controller,first.operationId,'REWAKE_OWNER_LOST')])
 assert.ok(settled.every(Boolean));const one=await root(first.rootOperationId);assert.equal(one.retry_count,'1');assert.ok(one.retry_at)
 const reconnect=createDurablePool({max:2});try{
  assert.deepEqual((await reconnect.query('SELECT retry_count::text,retry_at::text,deadline_at::text FROM durable_runtime.operations WHERE id=$1',[first.rootOperationId])).rows[0],
   {retry_count:'1',retry_at:one.retry_at,deadline_at:one.deadline_at})
  assert.equal(await claimRewakeOperation(reconnect,controller,unit,{...policy,operationDeadlineMs:9999999}),null)
 }finally{await reconnect.end()}
 for(let count=2;count<=3;count++){
  await pool.query("UPDATE durable_runtime.operations SET retry_at=clock_timestamp()-interval '1 second' WHERE id=$1",[first.rootOperationId])
  const next=await claimRewakeOperation(pool,controller,unit,{...policy,operationDeadlineMs:9999999});assert.ok(next)
  assert.notEqual(next.operationId,first.operationId);assert.equal(next.rootOperationId,first.rootOperationId);assert.equal(next.deadlineAt,first.deadlineAt)
  assert.equal(await settleRewakeOperation(pool,controller,next.operationId,'REWAKE_PREPARATION_FAILED'),true)
  assert.equal((await root(first.rootOperationId)).retry_count,String(count))
 }
 assert.equal((await root(first.rootOperationId)).retry_exhausted_reason,'REWAKE_RETRY_EXHAUSTED')
 assert.equal(await claimRewakeOperation(pool,controller,unit,policy),null)
 const u=(await pool.query('SELECT revision::text,intent_revision::text FROM durable_runtime.runtime_units WHERE id=$1',[unit])).rows[0]
 const countBefore=(await pool.query('SELECT count(*)::int AS n FROM durable_runtime.operations WHERE runtime_unit_id=$1',[unit])).rows[0].n
 const authority={principalId:'new-input-fixture',runtimeUnitId:logicalId('runtime-unit',unit),scope:'fixture:'+unit} as UnitIntentAuthority
 const input=await requestUnitIntent(pool,{authority,operationKey:randomUUID(),desired:'RUNNING',expectedRevision:u.revision,
  expectedIntentRevision:u.intent_revision,policy});assert.equal(input.status,'COMMITTED')
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM durable_runtime.operations WHERE runtime_unit_id=$1',[unit])).rows[0].n,countBefore)
 assert.deepEqual((await pool.query('SELECT intake_status FROM durable_runtime.messages WHERE session_id=$1 ORDER BY seq',[f.session])).rows.map(r=>r.intake_status),['DURABLE','UNKNOWN'])
 const op=projectOpsOperation((await pool.query<OpsOperationRow>(OPS_OPERATION_SELECT+' WHERE o.id=$1',[first.rootOperationId])).rows[0])
 assert.equal(op.reason,'REWAKE_RETRY_EXHAUSTED');assert.equal(op.recovery?.retryCount,'3');assert.equal(op.recovery?.retryLimit,'3')
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM durable_runtime.notifications WHERE incident_key=$1",['rewake-retry:'+first.rootOperationId])).rows[0].n,1)
 await assert.rejects(pool.query('UPDATE durable_runtime.operations SET deadline_at=deadline_at+interval \'1 hour\' WHERE id=$1',[first.rootOperationId]),{code:'23514'})
 await assert.rejects(pool.query('UPDATE durable_runtime.operations SET retry_count=0 WHERE id=$1',[first.rootOperationId]),{code:'23514'})
})
await test('deadline cannot renew and the operation schema/settlement supports a real initial lineage without fake READY',async()=>{
 const f=await seed(false),unit=f.candidate.runtimeUnitId
 assert.equal(await claimRewakeOperation(pool,controller,unit,policy),null,'unit03 does not dispatch initial recovery')
 await pool.query(`UPDATE durable_runtime.operations SET controller_scope=$2,controller_term=$3,result=NULL,step='INTENT_QUEUED',
  recovery_root_id=id,recovery_anchor_attempt_id=NULL,retry_limit=3,retry_claimed_at=clock_timestamp(),retry_owner=$4,retry_owner_term=$3,
  deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[f.operation,controller.scope,controller.term,controller.owner])
 assert.equal(await settleRewakeOperation(pool,controller,f.operation,'INITIAL_PREPARATION_FAILED'),true)
 const after=await root(f.operation);assert.equal(after.retry_count,'1');assert.equal(after.retry_exhausted_reason,'REWAKE_DEADLINE_EXHAUSTED')
 assert.equal(after.recovery_anchor_attempt_id,null)
 assert.equal((await pool.query('SELECT ready_at FROM durable_runtime.attempts WHERE id=$1',[f.candidate.attemptId])).rows[0].ready_at,null)
})
}finally{await pool.end()}
