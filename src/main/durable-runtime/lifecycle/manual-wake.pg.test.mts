import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join as pathJoin} from 'node:path'
import {DeviceRegistry} from '../../runtime/device-registry.ts'
import {createOpsHttpHandler} from '../ops/handler.ts'
import {createPgOpsServices} from '../ops/pg-services.ts'
import {createDeviceRegistryOpsVerifier} from '../ops/auth.ts'
import {captureOrcadWakePolicy} from '../../orcad/orcad-wake-policy.ts'
import {runControllerPass} from '../ha/pass.ts'
import {ControllerLeaseSession} from '../ha/session.ts'
import {ControllerInstance,CONTROLLER_SCOPE} from '../ha/instance.ts'
import {readControllerTakeoverSnapshot} from '../ha/takeover.ts'
import {readRewakeCandidates} from '../../orcad/orcad-rewake-candidates.ts'
import {createDurablePool,withDurableTransaction} from '../db/connection.ts'
import {applyMigrations,readMigrations} from '../db/migrate.ts'
import {lockAggregates} from '../db/locks.ts'
import {seedWriterLifecycle} from '../runtime/writer-lifecycle-fixtures.mts'
import {assertInitialWakeDeadline} from '../runtime/initial-wake-deadline.ts'
import {requestUnitIntent,requestManualUnitWake,LIFECYCLE_CONTROLLER_SCOPE} from './intent.ts'
import {claimRewakeOperation,settleRewakeOperation} from './rewake-retry.ts'
import type {VerifiedControllerIdentity} from '../runtime/gateway/types.ts'
import {counter,logicalId} from '../../../shared/durable-runtime/identity.ts'

const database='orca_manual_wake_20261019'
const env=JSON.parse(readFileSync('/home/orca-dev/.local/state/orca-dev/claude-e2e-watch-env.json','utf8'))
const config=JSON.parse(readFileSync(env.ORCA_DURABLE_CATALOG_CONFIG,'utf8'))
if(config.pg.database!=='orca_dev') {throw new Error('OWNED_FIXTURE_SOURCE_REQUIRED')}
const pass='/tmp/managed-codex-policy-task04c/manual-wake-fixture.pgpass'
writeFileSync(pass,readFileSync(env.PGPASSFILE,'utf8').replaceAll(':orca_dev:',`:${database}:`),{mode:0o600})
process.env.PGPASSFILE=pass
const pool=createDurablePool({...config.pg,database,max:4})
const policy=captureOrcadWakePolicy({operationDeadlineMs:600000,idleDurationMs:null})
const controller={scope:LIFECYCLE_CONTROLLER_SCOPE,owner:`${LIFECYCLE_CONTROLLER_SCOPE}:manual-wake-fixture`,term:counter('controller-term','7')} as VerifiedControllerIdentity
const body=(x:unknown)=>x as {receipt:{response:Record<string,unknown>}}

test('only an explicit authenticated manual receipt opens one linked recovery budget; original input and exhaustion survive',async()=>{
try{
 await applyMigrations(pool,await readMigrations(`${process.env.ORCA_MANUAL_TEST_SOURCE}/src/main/durable-runtime/db/migrations`))
 await pool.query(`INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,7,clock_timestamp()+interval '1 hour')
   ON CONFLICT(scope) DO UPDATE SET owner=excluded.owner,term=excluded.term,expires_at=excluded.expires_at`,[LIFECYCLE_CONTROLLER_SCOPE,controller.owner])
 const f=await seedWriterLifecycle(pool),unit=f.candidate.runtimeUnitId
 await pool.query("UPDATE durable_runtime.agents SET provider='codex' WHERE id=(SELECT agent_id FROM durable_runtime.sessions WHERE id=$1)",[f.session])
 await pool.query("UPDATE durable_runtime.execution_grants SET state='REVOKED',revoked_at=clock_timestamp(),stopped_proof_ref='synthetic-stop' WHERE attempt_id=$1",[f.candidate.attemptId])
 await pool.query("UPDATE durable_runtime.storage_write_grants SET state='REVOKED',revoked_at=clock_timestamp(),revocation_proof_ref='synthetic-stop' WHERE attempt_id=$1",[f.candidate.attemptId])
 await pool.query("UPDATE durable_runtime.attempts SET status='STOPPED',stopped_at=clock_timestamp(),ready_at=clock_timestamp() WHERE id=$1",[f.candidate.attemptId])
 await pool.query("UPDATE durable_runtime.runtime_units SET active_attempt_id=NULL,phase='ABSENT',desired_mode='SUSPENDED' WHERE id=$1",[unit])
 await pool.query("UPDATE durable_runtime.storage_bindings SET writer_attempt_id=NULL,access_state='VERIFIED' WHERE id=$1",[f.binding])
 await pool.query("UPDATE durable_runtime.operations SET result='{}' WHERE id=$1",[f.operation])
 const workspace=(await pool.query('SELECT workspace_id FROM durable_runtime.sessions WHERE id=$1',[f.session])).rows[0].workspace_id
 const group=`manual-wake:${randomUUID()}`
 await pool.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)',[group,JSON.stringify({id:group})])
 await pool.query("INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,project_group_id,reserved_path,payload,create_request,runtime_unit_id) VALUES($1,'FOLDER_WORKSPACE',$2,$3,'{}','{}',$4)",[workspace,group,`/fixture/${workspace}`,unit])
 const old=await claimRewakeOperation(pool,controller,unit,policy);assert.ok(old)
 await pool.query("UPDATE durable_runtime.operations SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",[old.operationId])
 assert.equal(await settleRewakeOperation(pool,controller,old.operationId,'WAKE_DEADLINE_EXHAUSTED'),true)
 const oldRow=(await pool.query('SELECT to_jsonb(o) AS row FROM durable_runtime.operations o WHERE id=$1',[old.operationId])).rows[0].row
 assert.equal(oldRow.retry_exhausted_reason,'REWAKE_DEADLINE_EXHAUSTED')
 await pool.query("UPDATE durable_runtime.messages SET intake_status='UNKNOWN' WHERE session_id=$1 AND intake_status='DURABLE'",[f.session])
 assert.equal((await readRewakeCandidates(pool)).some(r=>r.unit_id===unit),false,'UNKNOWN alone cannot trigger automatic wake')
 const inputs=(await pool.query('SELECT to_jsonb(m) AS row FROM durable_runtime.messages m WHERE session_id=$1 ORDER BY seq',[f.session])).rows
 const request=async(key:string)=>{const u=(await pool.query('SELECT revision::text,intent_revision::text FROM durable_runtime.runtime_units WHERE id=$1',[unit])).rows[0];return {
   authority:{principalId:'fixture-authenticated-ops',runtimeUnitId:logicalId('runtime-unit',unit),scope:`ops:fixture:runtime-unit:${unit}`} as never,
   operationKey:key,desired:'RUNNING' as const,expectedRevision:counter('row:runtime-unit',u.revision),expectedIntentRevision:counter('intent-revision',u.intent_revision),policy}}
 const ordinary=await request(randomUUID()),automatic=await requestUnitIntent(pool,ordinary)
 assert.notEqual(automatic.status,'UNCERTAIN');assert.equal(body(automatic).receipt.response.executionDisposition,'BLOCKED_BY_UNRESOLVED_COMMAND')
 const oldReceiptReplay=await requestManualUnitWake(pool,ordinary)
 assert.equal(oldReceiptReplay.status,'REPLAYED');assert.equal(body(oldReceiptReplay).receipt.response.operationId,old.operationId)
 const manual=await request(randomUUID())
 const directory=mkdtempSync(pathJoin(tmpdir(),'manual-wake-http-')),registry=new DeviceRegistry(directory)
 const device=registry.addDevice('isolated manual wake fixture','mobile','this-computer')
 const scope={datasetName:'orca-1012-dev-v1',namespaceId:'fixture',workspaceIds:[workspace]}
 const services=createPgOpsServices({pool,scope,streamId:'ops-fixture',lifecyclePolicy:policy,controllerConnected:true})
 let handler:ReturnType<typeof createOpsHttpHandler>
 const server=createServer((req,res)=>{if(!handler(req,res)){res.statusCode=404;res.end()}})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object')
 const origin=`http://127.0.0.1:${address.port}`
 handler=createOpsHttpHandler({origin,streamId:'ops-fixture',pollIntervalMs:100,services,authenticateBearer:createDeviceRegistryOpsVerifier(registry,scope)})
 const requestBody={operationId:manual.operationKey,expectedRevision:manual.expectedRevision,action:'wake',params:{expectedIntentRevision:manual.expectedIntentRevision}}
 const post=async()=>{const r=await fetch(`${origin}/ops/v1/runtime-units/${unit}/commands`,{method:'POST',headers:{Authorization:`Bearer ${device.token}`,'Content-Type':'application/json'},body:JSON.stringify(requestBody)});assert.equal(r.status,202);return await r.json() as {receipt:string;operationId:string}}
 let replies:Awaited<ReturnType<typeof post>>[]
 try {replies=await Promise.all([post(),post()]);assert.equal((await post()).receipt,'REPLAYED')}
 finally {await handler.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true})}
 assert.deepEqual(replies.map(r=>r.receipt).sort(),['COMMITTED','REPLAYED'])
 const nextId=replies[0].operationId;assert.notEqual(nextId,old.operationId)
 assert.ok((await readRewakeCandidates(pool)).some(r=>r.unit_id===unit),'actual watcher candidate must select the authenticated Ops successor')
 const next=(await pool.query('SELECT * FROM durable_runtime.operations WHERE id=$1',[nextId])).rows[0]
 assert.equal(next.recovery_root_id,next.id);assert.equal(next.recovery_predecessor_id,old.operationId)
 assert.equal(next.retry_count,'0');assert.equal(next.retry_limit,String(oldRow.retry_limit));assert.ok(next.deadline_at>new Date())
 const join=await requestUnitIntent(pool,await request(randomUUID()))
 assert.equal(body(join).receipt.response.operationId,nextId)
 await assert.rejects(requestManualUnitWake(pool,{...manual,operationKey:randomUUID()}),{code:'LIFECYCLE_STALE_REVISION'})
 assert.throws(()=>requestManualUnitWake(pool,{...manual,authority:{...manual.authority,scope:'untrusted'} as never}),{code:'LIFECYCLE_MANUAL_WAKE_AUTHORITY'})
 assert.deepEqual((await pool.query('SELECT to_jsonb(o) AS row FROM durable_runtime.operations o WHERE id=$1',[old.operationId])).rows[0].row,oldRow)
 assert.deepEqual((await pool.query('SELECT to_jsonb(m) AS row FROM durable_runtime.messages m WHERE session_id=$1 ORDER BY seq',[f.session])).rows,inputs)
 await assert.rejects(pool.query("UPDATE durable_runtime.operations SET recovery_manual_receipt='{}' WHERE id=$1",[nextId]),{code:'23514'})
 assert.equal(await settleRewakeOperation(pool,controller,old.operationId,'late-predecessor-observation'),false)
 assert.deepEqual((await pool.query('SELECT to_jsonb(o) AS row FROM durable_runtime.operations o WHERE id=$1',[old.operationId])).rows[0].row,oldRow)
 const claimed=await claimRewakeOperation(pool,controller,unit,policy)
 assert.equal(claimed?.rootOperationId,nextId);assert.equal(claimed?.operationId,nextId)
 const lease=(await pool.query('SELECT scope,owner,term::text,revision::text,expires_at FROM durable_runtime.controller_leases WHERE scope=$1',[LIFECYCLE_CONTROLLER_SCOPE])).rows[0]
 const snapshot=await readControllerTakeoverSnapshot(pool,{...lease,expiresAt:lease.expires_at.toISOString()} as never)
 assert.equal(snapshot.operations.find(o=>o.runtime_unit_id===unit&&!o.terminal&&o.retry_due)?.id,nextId,'actual HA pass must select the current receipt instead of the exhausted predecessor')
 // Real production pass consumes the actual snapshot and committed planner result.
 await pool.query("UPDATE durable_runtime.controller_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE scope=$1",[LIFECYCLE_CONTROLLER_SCOPE])
 const session=new ControllerLeaseSession(pool,new ControllerInstance(CONTROLLER_SCOPE),{revision:'manual-wake-pass',durationMs:60000})
 const acquired=await session.acquire();assert.equal(acquired.status,'ACTIVE');assert.ok(session.lease)
 let actuatorCalls=0
 const pass=await runControllerPass(pool,session,{controller:{scope:session.lease.scope,owner:session.lease.owner,term:session.lease.term} as VerifiedControllerIdentity,
   maximumWork:32,externalBudgetMs:5000,
   planStep(operation,selectedUnit){if(operation.id!==nextId||selectedUnit.id!==unit){return null};return {mutationKey:`manual-pass-${randomUUID()}`,step:'ENSURE_ATTEMPT',executorId:'fixture-actuator' as never,input:{}}},
   async executeCommitted(claim,signal,context){assert.equal(context.operationId,nextId);assert.equal(signal.aborted,false);assert.equal(claim.identity.command,'ensureAttempt');actuatorCalls++}})
 session.stop();assert.equal(pass.status,'FINISHED');assert.equal(actuatorCalls,1)
 assert.deepEqual((await pool.query('SELECT to_jsonb(o) AS row FROM durable_runtime.operations o WHERE id=$1',[old.operationId])).rows[0].row,oldRow)
 // Slow native completion: an original permit cannot certify late READY.
 await pool.query("UPDATE durable_runtime.operations SET deadline_at=clock_timestamp()+interval '1 second' WHERE id=$1",[nextId])
 await withDurableTransaction(pool,async tx=>{await lockAggregates(tx,{runtimeUnitIds:[logicalId('runtime-unit',unit)],operationIds:[logicalId('operation',nextId)]});await assertInitialWakeDeadline(tx,nextId)})
 await pool.query('SELECT pg_sleep(1.05)')
 await assert.rejects(withDurableTransaction(pool,async tx=>{await lockAggregates(tx,{runtimeUnitIds:[logicalId('runtime-unit',unit)],operationIds:[logicalId('operation',nextId)]});await assertInitialWakeDeadline(tx,nextId)}),{code:'INITIAL_WAKE_DEADLINE_EXPIRED'})
 console.log(JSON.stringify({actualAuthenticatedOpsToCandidateToClaimToHaPlanToActuator:true,manualReceiptIdempotent:true,oldExhaustionImmutable:true,automaticAndNewInputCannotRenew:true,originalPendingAndUnknownUnchanged:true,sharedRetryEngineClaimed:true,lateColdReadyGate:'PG_CLOCK_EXPIRED'}))
}finally{await pool.end()}
})
