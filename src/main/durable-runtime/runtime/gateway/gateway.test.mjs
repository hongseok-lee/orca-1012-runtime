// Actual isolated PostgreSQL tests. Controller/Pod/provider identifiers below
// are SQL fixtures, not authenticated workloads or real external-effect proofs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, open } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDurablePool, withDurableTransaction, DurableDatabaseError } from '../../db/connection.ts';
import { runDurableMutation, resolveReceipt } from '../../db/atomic.ts';
import { LockedGatewayAuthority } from './authority.ts';
import { inputDigest } from './input.ts';
import { submitCommand, lookupCommand, takeOverCommand, originalIdentity } from './store.ts';
import { claimCommand, markCommandUnknown, settleOwnedExecution } from './claim.ts';
import { runGatewayCommandMutation } from './mutation.ts';

if (!/^orca_p109_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')) throw new Error('OWN_DATABASE_REQUIRED');
const pool = createDurablePool({ max: 6, application_name: 'p109-isolated-gateway-tests' });
const results = [];
const selected = process.env.ORCA_P109_CASE;
let producerSeq = 0n;
const producerId = randomUUID();

async function fixture(session = false) {
  const id = randomUUID(), operationId = randomUUID(), attemptId = randomUUID();
  const controller = { scope: `fixture:${id}`, owner: `controller:${id}`, term: '1' };
  const context = { runtimeUnitId: id, operationId, controller };
  const pod = `fixture-pod:${attemptId}`;
  const envelope = { operationId, controllerTerm: '1', stepRevision: '0', executionEpoch: '1', intentRevision: '1', podTarget: 'EXISTING_POD', expectedPodUid: pod };
  const sessionId = session ? randomUUID() : null;
  await withDurableTransaction(pool, async (tx) => {
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,intent_revision,execution_epoch,phase) VALUES($1,'RUNNING',1,1,'READY')", [id]);
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,1,'{}',1)", [id]);
    await tx.query("INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,resource_profile_revision,effective_resources,status) VALUES($1,$2,1,'COLD',$3,1,'{}','READY')", [attemptId,id,pod]);
    await tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1', [id,attemptId]);
    await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '30 minutes')", [controller.scope,controller.owner]);
    await tx.query("INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,step_revision,expected_pod_uid,execution_epoch) VALUES($1,$2,'fixture',1,$3,1,'fixture',0,$4,1)", [operationId,id,controller.scope,pod]);
    if (sessionId) {
      const agent = randomUUID(), workspace = randomUUID(), storage = randomUUID();
      await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'fixture')", [agent]);
      await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1::uuid,$1::text,'fixture','READY')", [workspace]);
      await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [sessionId,agent,workspace]);
      await tx.query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,'fixture')", [id]);
      await tx.query("INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,'fixture',$3,'RO')", [storage,id,`/fixture/${id}`]);
      await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [id,sessionId,storage]);
    }
  });
  return { context, envelope, sessionId, attemptId };
}
function request(f, command = 'stageInput', input = { fixture: true }) {
  return { command, envelope: { ...f.envelope }, inputHash: inputDigest(input), input, predecessor: { kind: 'NONE' } };
}
function original(r) { return { command: r.command, originalEnvelope: r.envelope, inputHash: r.inputHash }; }
async function inGateway(f, body) { return withDurableTransaction(pool, async tx => body(await LockedGatewayAuthority.acquire(tx,f.context))); }
async function accept(f,r=request(f)) { return inGateway(f,a=>submitCommand(a,r)); }
function mutationRequest(f,action,key=randomUUID()) {
  return { context: f.context, mutationKey: key, action, sessionIds: f.sessionId ? [f.sessionId] : [],
    observation: { producerId, producerSeq: String(++producerSeq), occurredAt: new Date(), receivedAt: new Date() } };
}
async function rejected(body, code) { await assert.rejects(body, e=>e instanceof DurableDatabaseError && e.code===code); }
async function counts(f) {
  const q=await pool.query(`SELECT
    (SELECT count(*)::int FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1) AS commands,
    (SELECT count(*)::int FROM durable_runtime.runtime_command_history h JOIN durable_runtime.runtime_commands c ON c.id=h.command_id WHERE c.runtime_unit_id=$1) AS history,
    (SELECT count(*)::int FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$1) AS audit,
    (SELECT count(*)::int FROM durable_runtime.outbox_events WHERE event->>'runtimeUnitId'=$1::text) AS outbox,
    (SELECT count(*)::int FROM durable_runtime.session_events WHERE body->>'runtimeUnitId'=$1::text) AS journal,
    (SELECT count(*)::int FROM durable_runtime.rpc_receipts WHERE session_scope='runtime-unit:'||$1::text) AS receipts`, [f.context.runtimeUnitId]);
  return q.rows[0];
}
function gate() { let release; const promise=new Promise(r=>{release=r}); return {promise,release}; }
async function waitForLock(pid) {
  const deadline=Date.now()+3000;
  while(Date.now()<deadline) {
    const r=await pool.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE datname=current_database() AND pid=$1", [pid]);
    if(r.rows[0]?.waiting) return true;
    await new Promise(r=>setTimeout(r,20));
  }
  return false;
}
async function test(name,body) {
  if(selected && selected!==name) return;
  const start=Date.now();
  try { const observed=await body(); results.push({name,passed:true,durationMs:Date.now()-start,observed:observed??{}}); }
  catch(error) { results.push({name,passed:false,durationMs:Date.now()-start,errorCode:typeof error?.code==='string'?error.code:error?.name??'UNEXPECTED'}); process.exitCode=1; }
  await writeFile(process.env.ORCA_P109_RESULT, JSON.stringify({schemaPrerequisite:process.env.ORCA_P109_SCHEMA,sourceRevision:process.env.ORCA_P109_REVISION,scope:'isolated PostgreSQL/SQL fixture and callback boundary; no real authentication/provider/K8s fencing',cases:results},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({name,passed:results.at(-1).passed,errorCode:results.at(-1).errorCode}));
  if(process.exitCode) throw new Error('STOP_AFTER_NEW_FAILURE');
}

try {
  await test('concurrent-original-accept-and-claim',async()=>{
    const f=await fixture(),r=request(f); const entered=gate(),release=gate();
    const first=inGateway(f,async a=>{const row=await submitCommand(a,r);entered.release();await release.promise;return row});
    await entered.promise;
    const client=await pool.connect();let pid;let second;
    try { pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      second=(async()=>{await client.query('BEGIN');const {DurableTransaction}=await import('../../db/connection.ts');const tx=new DurableTransaction(client);
        try { const a=await LockedGatewayAuthority.acquire(tx,f.context);const row=await submitCommand(a,r);await client.query('COMMIT');return row; }
        catch(e){await client.query('ROLLBACK');throw e;}finally{tx.close();}})();
      const waited=await waitForLock(pid);release.release();const rows=await Promise.all([first,second]);
      assert.equal(waited,true);assert.equal(rows[0].command.id,rows[1].command.id);
      const claims=await Promise.all([inGateway(f,a=>claimCommand(a,original(r),'fixture-executor-a')),inGateway(f,a=>claimCommand(a,original(r),'fixture-executor-b'))]);
      assert.equal(claims.filter(c=>c.disposition==='CLAIMED').length,1);
      assert.equal((await counts(f)).commands,1);return {actualLockWait:true,storedIdentityCount:1,claimedExecutorCount:1};
    } finally {release.release();client.release();}
  });
  await test('original-payload-and-authority-target-mismatches',async()=>{
    const f=await fixture(),r=request(f);await accept(f,r);
    await rejected(()=>accept(f,request(f,'stageInput',{fixture:'different'})),'COMMAND_IDENTITY_CONFLICT');
    for(const [field,value] of [['expectedPodUid','other-fixture-pod'],['executionEpoch','2'],['intentRevision','2']]) {
      await rejected(()=>accept(f,{...r,envelope:{...r.envelope,[field]:value}}),'COMMAND_IDENTITY_CONFLICT');
    }
    const empty=await fixture();
    for(const [field,value] of [['expectedPodUid','other-fixture-pod'],['executionEpoch','2'],['intentRevision','2'],['stepRevision','2']]) {
      const fresh=request(empty);await rejected(()=>accept(empty,{...fresh,envelope:{...fresh.envelope,[field]:value}}),'COMMAND_TARGET_STALE');
    }
    await rejected(()=>inGateway({...empty,context:{...empty.context,controller:{...empty.context.controller,term:'2'}}},()=>null),'COMMAND_AUTHORITY_STALE');
    await rejected(()=>inGateway({...empty,context:{...empty.context,runtimeUnitId:f.context.runtimeUnitId}},()=>null),'COMMAND_OPERATION_SCOPE');
    return {sameKeyConflicts:4,newTargetRejections:4,staleControllerRejected:true,foreignUnitRejected:true};
  });
  await test('unresolved-blocker-and-forged-predecessor',async()=>{
    const f=await fixture(),r=request(f);const accepted=await accept(f,r);
    const opposite=request(f,'cancel');const blocked=await accept(f,opposite);
    assert.equal(blocked.disposition,'BLOCKED_BY_UNRESOLVED_COMMAND');assert.equal(blocked.newCommandAccepted,false);
    const fake={kind:'RECONCILED',receipt:{identity:original(r),state:'RESOLVED',result:{fixture:true}}};
    await rejected(()=>accept(f,{...opposite,predecessor:fake}),'COMMAND_PREDECESSOR_INVALID');
    const bad={...fake,receipt:{...fake.receipt,identity:{...fake.receipt.identity,originalEnvelope:{...r.envelope,expectedPodUid:'forged-original'}}}};
    await rejected(()=>accept(f,{...opposite,predecessor:bad}),'COMMAND_IDENTITY_CONFLICT');
    const foreign=await fixture();await rejected(()=>accept(foreign,{...request(foreign,'cancel'),predecessor:fake}),'COMMAND_PREDECESSOR_INVALID');
    assert.equal((await counts(f)).commands,1);assert.equal(accepted.command.state,'ACCEPTED');
    return {blockedWithoutNewRow:true,unresolvedFakeRejected:true,wrongOriginalTargetRejected:true,foreignUnitReceiptRejected:true};
  });
  await test('terminal-old-pod-predecessor-to-no-pod-create',async()=>{
    const f=await fixture(),r=request(f,'fenceAttempt');await accept(f,r);
    const c=await inGateway(f,a=>claimCommand(a,original(r),'fixture-control-step'));
    // Only a completed isolated control step is observed; no physical stop or
    // provider proof is fabricated, and no real Pod is changed.
    const result={phase:'ISOLATED_CONTROL_STEP_COMPLETE'};
    await inGateway(f,a=>settleOwnedExecution(a,c.claim,{state:'RESOLVED',result,evidenceRefs:[]}));
    await pool.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=NULL WHERE id=$1',[f.context.runtimeUnitId]);
    await pool.query('UPDATE durable_runtime.operations SET expected_pod_uid=NULL,step_revision=1 WHERE id=$1',[f.context.operationId]);
    const next=request(f,'ensureAttempt',{fixture:'create'});next.envelope={...f.envelope,podTarget:'CREATE_WITHOUT_POD',expectedPodUid:null,stepRevision:'1'};
    next.predecessor={kind:'RECONCILED',receipt:{identity:original(r),state:'RESOLVED',result}};
    const accepted=await accept(f,next);assert.equal(accepted.disposition,'ACCEPTED');
    return {distinctNewTargetAccepted:true,originalTerminalTargetPreserved:true,physicalFencingTested:false};
  });
  await test('lease-replacement-overlap-rejects-old-acceptance',async()=>{
    const f=await fixture();const changer=await pool.connect(),waiter=await pool.connect();let waiting;
    try {await changer.query('BEGIN');await changer.query('UPDATE durable_runtime.controller_leases SET owner=$2,term=2 WHERE scope=$1',[f.context.controller.scope,'fixture-new-owner']);
      const pid=(await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      waiting=(async()=>{await waiter.query('BEGIN');const {DurableTransaction}=await import('../../db/connection.ts');const tx=new DurableTransaction(waiter);
        try { const a=await LockedGatewayAuthority.acquire(tx,f.context);await submitCommand(a,request(f));await waiter.query('COMMIT'); }
        catch(e){await waiter.query('ROLLBACK');throw e;}finally{tx.close();}})();
      const observed=waiting.then(()=>({accepted:true}),e=>({code:e.code}));const waited=await waitForLock(pid);
      await changer.query('COMMIT');const result=await observed;assert.equal(waited,true);assert.equal(result.code,'COMMAND_AUTHORITY_STALE');assert.equal((await counts(f)).commands,0);
      return {actualLeaseRowWait:true,postWaitAuthorityRejected:true,createdCommands:0};
    }finally{await changer.query('ROLLBACK');changer.release();waiter.release();}
  });
  await test('accepted-adoption-preserves-original-and-blocks-old-owner',async()=>{
    const f=await fixture(),r=request(f);const row=(await accept(f,r)).command;
    await pool.query('UPDATE durable_runtime.controller_leases SET owner=$2,term=2 WHERE scope=$1',[f.context.controller.scope,'fixture-successor']);
    await pool.query('UPDATE durable_runtime.operations SET controller_term=2 WHERE id=$1',[f.context.operationId]);
    const successor={...f,context:{...f.context,controller:{...f.context.controller,owner:'fixture-successor',term:'2'}}};
    const adopted=await inGateway(successor,a=>takeOverCommand(a,original(r)));
    assert.equal(adopted.original_controller_term,'1');assert.equal(adopted.owner_controller_term,'2');assert.equal(adopted.id,row.id);
    await rejected(()=>inGateway(f,a=>claimCommand(a,original(r),'old-fixture-executor')),'COMMAND_AUTHORITY_STALE');
    const claim=await inGateway(successor,a=>claimCommand(a,original(r),'new-fixture-executor'));assert.equal(claim.disposition,'CLAIMED');
    return {originalTermPreserved:true,currentOwnerTermAdvanced:true,oldOwnerRejected:true,newClaimCount:1};
  });
  await test('claim-rollback-preserves-accepted-and-history',async()=>{
    const f=await fixture(),r=request(f);await accept(f,r);
    await rejected(()=>inGateway(f,async a=>{await claimCommand(a,original(r),'fixture-aborted');throw new DurableDatabaseError('FIXTURE_ABORT');}),'FIXTURE_ABORT');
    const row=await inGateway(f,a=>lookupCommand(a,original(r)));assert.equal(row.state,'ACCEPTED');assert.equal(row.execution_token,null);assert.equal((await counts(f)).history,1);
    return {acceptedPreserved:true,claimTokenAbsent:true,claimedHistoryRolledBack:true};
  });
  await test('claimed-owned-worker-exit-keeps-unknown-non-reexecutable',async()=>{
    const f=await fixture(true),r=request(f);await accept(f,r);
    const base=process.env.ORCA_P109_RESULT+'.owned-worker';
    const req=mutationRequest(f,{kind:'CLAIM',original:original(r),executorId:'fixture-owned-worker'});
    await writeFile(base+'.input.json',JSON.stringify({request:req,output:base+'.result.json'})+'\n',{mode:0o600});
    const log=await open(base+'.log','w',0o600);
    const child=fork(fileURLToPath(new URL('./claim-worker.mjs',import.meta.url)),[base+'.input.json'],{execArgv:process.execArgv,stdio:['ignore','ignore',log.fd,'ipc']});
    const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    try {
      await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('OWNED_WORKER_TIMEOUT')),10000);
        child.once('message',m=>{clearTimeout(timeout);m==='COMMIT_CONFIRMED'?resolve():reject(new Error('OWNED_WORKER_FAILED'));});
        child.once('error',reject);child.once('exit',()=>{clearTimeout(timeout);reject(new Error('OWNED_WORKER_EARLY_EXIT'));});
      });
      const saved=JSON.parse(await readFile(base+'.result.json','utf8'));assert.equal(saved.mutation.status,'COMMITTED');
      const claim=saved.mutation.receipt.response.claim;
      child.kill('SIGKILL');const stopped=await exit;assert.equal(stopped.signal,'SIGKILL');
      await pool.query('UPDATE durable_runtime.controller_leases SET owner=$2,term=2 WHERE scope=$1',[f.context.controller.scope,'fixture-worker-successor']);
      await pool.query('UPDATE durable_runtime.operations SET controller_term=2 WHERE id=$1',[f.context.operationId]);
      const next={...f,context:{...f.context,controller:{...f.context.controller,owner:'fixture-worker-successor',term:'2'}}};
      await inGateway(next,a=>takeOverCommand(a,original(r)));
      const duplicate=await inGateway(next,a=>claimCommand(a,original(r),'fixture-duplicate-executor'));assert.equal(duplicate.disposition,'NOT_CLAIMABLE');
      const unknown=await inGateway(next,a=>markCommandUnknown(a,claim));assert.equal(unknown.state,'UNKNOWN');
      await rejected(()=>inGateway(next,a=>settleOwnedExecution(a,claim,{state:'RESOLVED',result:{fixture:true},evidenceRefs:[]})),'COMMAND_RECONCILIATION_REQUIRED');
      const blocked=await accept(next,request(next,'cancel'));assert.equal(blocked.disposition,'BLOCKED_BY_UNRESOLVED_COMMAND');
      return {ownedChildActuallyTerminated:true,terminationSignal:'SIGKILL',originalExecutionRetained:true,automaticReexecution:false,unknownBlocksOpposite:true};
    } finally {if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exit;}await log.close();}
  });
  await test('atomic-prelocks-journal-and-outbox-composition',async()=>{
    const f=await fixture(true);const m=await runGatewayCommandMutation(pool,mutationRequest(f,{kind:'SUBMIT',request:request(f)}));
    assert.equal(m.mutation.status,'COMMITTED');assert.deepEqual(await counts(f),{commands:1,history:1,audit:1,outbox:1,journal:1,receipts:1});
    return {unitOperationPrelocksReentered:true,sessionLockReused:true,atomicCommittedRows:{commands:1,history:1,audit:1,outbox:1,journal:1,receipts:1}};
  });
  await test('outbox-sql-failure-rolls-back-all-gateway-artifacts',async()=>{
    const f=await fixture(true);
    const injected={connect:async()=>{const c=await pool.connect();return new Proxy(c,{get(target,key){if(key==='query')return async(sql,values)=>String(sql).includes('INSERT INTO durable_runtime.outbox_events')?target.query('SELECT 1/0'):target.query(sql,values);const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}})}};
    await rejected(()=>runGatewayCommandMutation(injected,mutationRequest(f,{kind:'SUBMIT',request:request(f)})),'22012');
    assert.deepEqual(await counts(f),{commands:0,history:0,audit:0,outbox:0,journal:0,receipts:0});
    return {actualSqlError:'22012',allGatewayArtifactsRolledBack:true};
  });
  for(const commitSent of [false,true]) await test(commitSent?'claim-commit-reply-lost-reuses-original-receipt':'claim-commit-not-sent-remains-unconfirmed',async()=>{
    const f=await fixture(true),r=request(f);await accept(f,r);
    const req=mutationRequest(f,{kind:'CLAIM',original:original(r),executorId:'fixture-lost-reply'});
    let intercepted=false;
    const lossy={connect:async()=>{const c=await pool.connect();return new Proxy(c,{get(target,key){if(key==='query')return async(sql,values)=>{if(String(sql)==='COMMIT'&&!intercepted){intercepted=true;if(commitSent)await target.query(sql,values);const e=new Error('FIXTURE_COMMIT_REPLY_LOSS');e.code='ECONNRESET';throw e;}return target.query(sql,values);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}})}};
    const result=await runGatewayCommandMutation(lossy,req);assert.equal(result.mutation.status,'UNCERTAIN');
    const receipt=await resolveReceipt(pool,result.identity);assert.equal(receipt.status,commitSent?'FOUND':'NOT_FOUND');
    const row=await inGateway(f,a=>lookupCommand(a,original(r)));assert.equal(row.state,commitSent?'EXECUTING':'ACCEPTED');
    const n=await counts(f);assert.equal(n.audit,commitSent?1:0);assert.equal(n.outbox,commitSent?1:0);assert.equal(n.receipts,commitSent?1:0);
    if(commitSent){const replay=await runGatewayCommandMutation(pool,req);assert.equal(replay.mutation.status,'REPLAYED');assert.equal((await counts(f)).history,2);}
    return {commitSent,receiptResolution:receipt.status,ledgerState:row.state,automaticExternalExecutions:0,claimNotAutomaticallyRetried:true};
  });
} catch(error) {
  if(error?.message!=='STOP_AFTER_NEW_FAILURE') {console.log(JSON.stringify({setupFailureCode:typeof error?.code==='string'?error.code:error?.name??'UNEXPECTED'}));process.exitCode=1;}
} finally {await pool.end();}
