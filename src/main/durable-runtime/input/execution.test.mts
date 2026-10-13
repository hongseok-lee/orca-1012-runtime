import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, after, test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool } from '../db/connection.ts'
import { acceptInput } from './intake.ts'
import { requestInputCancel } from './cancel.ts'
import { stageInputInTransaction } from './stage.ts'
import { observeInputDeliveryInTransaction } from './observe.ts'
import type { InputDeliveryObservation, ProviderCompletedProof } from './observation-types.ts'
import type { ProviderAdmissionProof, ProviderStoppedProof, EvidenceRef } from '../runtime/runtime-evidence.ts'
import { getRecoveryContextFrame } from '../context/frame.ts'
import { recordContextDeliveryInTransaction, isCurrentContextDeliveredInTransaction } from '../context/delivery.ts'
import type { VerifiedContextDeliveryProof } from '../context/types.ts'
import { response, field } from './verification-fixtures.mts'
import { executionFixture, inExecution, stage, stageRequest, dispatch, submitDispatch, claim,
  cancelRequest, original, fixed, nextStep, gate, holdSessionPool, waitForOwnedSessionWaiter, command } from './execution-fixtures.mts'

let pool:Pool
const results:{name:string;passed:boolean;errorCode?:string}[]=[]
before(async()=>{
  assert.equal(process.cwd(),process.env.ORCA_CONTEXT_EXECUTION_ROOT)
  assert.match(process.env.PGDATABASE??'',/^orca_p107_[a-z0-9_]+$/)
  pool=createDurablePool({database:process.env.PGDATABASE,max:10})
  const r=await pool.query("SELECT count(*)::text AS n FROM durable_runtime.schema_migrations WHERE version='013-context-deliveries.sql'")
  assert.equal(r.rows[0].n,'1')
})
after(async()=>{
  await pool?.end()
  if(process.env.ORCA_CONTEXT_RESULT)await writeFile(process.env.ORCA_CONTEXT_RESULT,JSON.stringify({
    sourceRevision:process.env.ORCA_CONTEXT_REVISION,schemaRevision:process.env.ORCA_CONTEXT_SCHEMA,
    gatewayRevision:process.env.ORCA_CONTEXT_GATEWAY,scope:'isolated SQL/module boundaries; synthetic authority/proof/callback; no actual provider/public RPC/auth/fencing/native',cases:results},null,2)+'\n',{mode:0o600})
})
function caseTest(name:string,body:()=>Promise<void>){
  if(process.env.ORCA_CONTEXT_CASE&&process.env.ORCA_CONTEXT_CASE!==name)return
  test(name,async()=>{try{await body();results.push({name,passed:true})}catch(e){results.push({name,passed:false,errorCode:typeof e==='object'&&e!==null&&'code'in e?String(e.code):(e instanceof Error?e.name:'UNEXPECTED')});throw e}})
}
function admission(f:Awaited<ReturnType<typeof executionFixture>>,deliveryId:string):ProviderAdmissionProof {
  // Synthetic verifier fixture only. No product factory supplies the opaque brand.
  return {...fixed(f,deliveryId),kind:'PROVIDER_ADMISSION',source:'PROVIDER_PROTOCOL',
    evidenceRef:`synthetic-admission-${randomUUID()}`,observedAt:new Date().toISOString(),
    providerRef:{provider:'codex',nativeSessionRef:'synthetic-native-session',nativeTurnId:'synthetic-native-turn'}} as unknown as ProviderAdmissionProof
}
function stop(f:Awaited<ReturnType<typeof executionFixture>>,deliveryId:string):ProviderStoppedProof {
  const p=admission(f,deliveryId)
  return {...p,kind:'PROVIDER_TARGET_STOPPED',targetMessageId:f.messageId,
    evidenceRef:`synthetic-stop-${randomUUID()}`} as unknown as ProviderStoppedProof
}

caseTest('stage seals and resolves atomically; immutable delivery binding and replay grant no execution',async()=>{
  const f=await executionFixture(pool)
  const s=await stage(pool,f)
  assert.equal(s.result.visibility,'TRANSACTION_LOCAL')
  const rows=await pool.query(`SELECT c.state,c.result,d.state AS delivery_state,m.intake_status,m.sealed_payload_hash
    FROM durable_runtime.runtime_commands c JOIN durable_runtime.delivery_attempts d ON d.id=(c.input->>'deliveryAttemptId')::uuid
    JOIN durable_runtime.messages m ON m.id=d.message_id WHERE c.runtime_unit_id=$1`,[f.context.runtimeUnitId])
  assert.equal(rows.rows[0].state,'RESOLVED');assert.deepEqual(rows.rows[0].result,{receipt:'STAGED'})
  assert.equal(rows.rows[0].delivery_state,'STAGED');assert.equal(rows.rows[0].intake_status,'STAGED')
  const replay=await inExecution(pool,f,tx=>stageInputInTransaction(tx,f.authority,f.context,s.request,f.executor))
  assert.equal(replay.disposition,'REPLAYED');assert.ok(!('commandClaim'in replay))
  await assert.rejects(inExecution(pool,f,tx=>stageInputInTransaction(tx,f.authority,f.context,
    command(f,'stageInput',{...(s.request.input as object),bodyRef:'synthetic-other-body'}),f.executor)),{code:'COMMAND_IDENTITY_CONFLICT'})
  await nextStep(pool,f)
  await assert.rejects(inExecution(pool,f,tx=>stageInputInTransaction(tx,f.authority,f.context,
    {...s.request,envelope:f.envelope},f.executor)),{code:'COMMAND_IDENTITY_CONFLICT'})
  const n=await pool.query('SELECT count(*)::text AS n FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1',[f.context.runtimeUnitId]);assert.equal(n.rows[0].n,'1')
})

caseTest('cancel wins overlapping Session locks; combined command and Message claim rejected with callback zero',async()=>{
  const f=await executionFixture(pool),s=await stage(pool,f),r=dispatch(f,s.deliveryId)
  await submitDispatch(pool,f,r)
  const held=gate(),release=gate();const owner=holdSessionPool(pool,held,release)
  const request=cancelRequest(f);const cancelled=requestInputCancel(owner,request)
  await held.promise
  let callbackCount=0
  const attempt=claim(pool,f,r).then(v=>{if(v.disposition==='CLAIMED')callbackCount++;return {value:v,error:null}},e=>({value:null,error:e}))
  try{await waitForOwnedSessionWaiter(pool)}finally{release.release()}
  const accepted=await cancelled;assert.equal(field(response(accepted),'interruptStatus'),'NOT_REQUIRED')
  const attempted=await attempt;assert.equal(attempted.error?.code,'INPUT_EFFECT_TARGET_STALE');assert.equal(callbackCount,0)
  const rows=await pool.query(`SELECT m.intake_status,d.state,c.state AS command_state,c.execution_token
    FROM durable_runtime.messages m JOIN durable_runtime.delivery_attempts d ON d.message_id=m.id
    JOIN durable_runtime.runtime_commands c ON c.command_name='dispatchInput' AND c.input->>'deliveryAttemptId'=d.id::text WHERE m.id=$1`,[f.messageId])
  assert.equal(rows.rows[0].intake_status,'CANCELLED');assert.equal(rows.rows[0].state,'CANCELLED');assert.equal(rows.rows[0].command_state,'ACCEPTED');assert.equal(rows.rows[0].execution_token,null)
  await pool.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSED',session_fence=session_fence+1 WHERE id=$1",[f.authority.sessionId])
  assert.equal((await requestInputCancel(pool,request)).status,'REPLAYED')
})

caseTest('claim wins overlapping locks; Stop remains REQUESTED until original stop proof and receipt stays original',async()=>{
  const f=await executionFixture(pool),s=await stage(pool,f),r=dispatch(f,s.deliveryId);await submitDispatch(pool,f,r)
  const held=gate(),release=gate(),owner=holdSessionPool(pool,held,release)
  const execution=claim(owner,f,r);await held.promise
  const request=cancelRequest(f);const pending=requestInputCancel(pool,request)
  try{await waitForOwnedSessionWaiter(pool)}finally{release.release()}
  const effect=await execution;assert.equal(effect.disposition,'CLAIMED');assert.equal(effect.visibility,'TRANSACTION_LOCAL')
  const receipt=await pending;assert.equal(field(response(receipt),'interruptStatus'),'REQUESTED')
  await assert.rejects(inExecution(pool,f,tx=>observeInputDeliveryInTransaction(tx,f.authority,fixed(f,s.deliveryId),
    {kind:'INTERRUPTED',proof:false as unknown as ProviderStoppedProof})),{code:'INPUT_OBSERVATION_PROOF'})
  const proof=stop(f,s.deliveryId)
  await inExecution(pool,f,tx=>observeInputDeliveryInTransaction(tx,f.authority,fixed(f,s.deliveryId),{kind:'INTERRUPTED',proof}))
  const state=await pool.query(`SELECT m.intake_status,ci.interrupt_status,ci.target_attempt_id,ci.target_execution_epoch
    FROM durable_runtime.messages m JOIN durable_runtime.cancel_intents ci ON ci.target_message_id=m.id WHERE m.id=$1`,[f.messageId])
  assert.equal(state.rows[0].intake_status,'INTERRUPTED');assert.equal(state.rows[0].interrupt_status,'CONFIRMED')
  assert.equal(state.rows[0].target_attempt_id,f.attemptId);assert.equal(state.rows[0].target_execution_epoch,'1')
  const replay=await requestInputCancel(pool,request);assert.equal(replay.status,'REPLAYED');assert.equal(field(response(replay),'interruptStatus'),'REQUESTED')
})

caseTest('pre-effect duplicate Stop preserves bundle; late ACK conflicts and another attempt cannot affect new input',async()=>{
  const f=await executionFixture(pool)
  const extra=response(await acceptInput(pool,{...f.request,operationKey:randomUUID()}));assert.equal(field(extra,'messageId'),f.messageId)
  f.messageRevision=counter('message-revision',field(extra,'messageRevision'))
  const s=await stage(pool,f)
  const first=await requestInputCancel(pool,cancelRequest(f)),second=await requestInputCancel(pool,cancelRequest(f))
  assert.equal(field(response(first),'interruptStatus'),'NOT_REQUIRED');assert.equal(field(response(second),'cancelRevision'),'2')
  const newest=response(await acceptInput(pool,{...f.request,operationKey:randomUUID()}));assert.notEqual(field(newest,'messageId'),f.messageId)
  const proof=admission(f,s.deliveryId)
  const observed=await inExecution(pool,f,tx=>observeInputDeliveryInTransaction(tx,f.authority,fixed(f,s.deliveryId),{kind:'ADMITTED',proof}))
  assert.equal('conflict'in observed&&observed.conflict,true)
  await assert.rejects(inExecution(pool,f,tx=>observeInputDeliveryInTransaction(tx,f.authority,fixed(f,s.deliveryId),
    {kind:'ADMITTED',proof:{...proof,attemptId:logicalId('attempt',randomUUID())}})),{code:'INPUT_OBSERVATION_PROOF'})
  const old=await pool.query('SELECT intake_status FROM durable_runtime.messages WHERE id=$1',[f.messageId]);assert.equal(old.rows[0].intake_status,'CANCELLED')
  const fresh=await pool.query('SELECT intake_status,cancel_revision FROM durable_runtime.messages WHERE id=$1',[field(newest,'messageId')]);assert.equal(fresh.rows[0].intake_status,'DURABLE');assert.equal(fresh.rows[0].cancel_revision,'0')
})

caseTest('stale context rejects joint claim; fresh delivery keeps original stage and execution gates reject QUIESCING',async()=>{
  const f=await executionFixture(pool),s=await stage(pool,f),oldRequest=dispatch(f,s.deliveryId)
  await pool.query(`INSERT INTO durable_runtime.session_context_records(id,session_id,revision,kind,body_ref)
    VALUES($1,$2,1,'SYNTHETIC_RECOVERY_FACT','{}')`,[randomUUID(),f.authority.sessionId])
  await pool.query('UPDATE durable_runtime.sessions SET context_revision=1 WHERE id=$1',[f.authority.sessionId])
  await assert.rejects(claim(pool,f,oldRequest,true),{code:'INPUT_EFFECT_TARGET_STALE'})
  const old=await pool.query("SELECT state FROM durable_runtime.runtime_commands WHERE input->>'deliveryAttemptId'=$1",[s.deliveryId]);assert.equal(old.rowCount,1);assert.equal(old.rows[0].state,'RESOLVED')
  await nextStep(pool,f)
  const fresh=await stage(pool,f,'1'),r=dispatch(f,fresh.deliveryId)
  await pool.query("UPDATE durable_runtime.runtime_units SET phase='QUIESCING' WHERE id=$1",[f.context.runtimeUnitId])
  await assert.rejects(claim(pool,f,r,true),{code:'INPUT_EFFECT_TARGET_STALE'})
  await pool.query("UPDATE durable_runtime.runtime_units SET phase='READY' WHERE id=$1",[f.context.runtimeUnitId])
  const won=await claim(pool,f,r,true);assert.equal(won.disposition,'CLAIMED')
  const ds=await pool.query('SELECT id,state FROM durable_runtime.delivery_attempts WHERE message_id=$1 ORDER BY id',[f.messageId]);assert.equal(ds.rowCount,2)
  assert.equal(ds.rows.find(d=>d.id===s.deliveryId)?.state,'STAGED');assert.equal(ds.rows.find(d=>d.id===fresh.deliveryId)?.state,'EFFECT_POSSIBLE')
})

caseTest('new stage and joint claim roll back as whole transactions before observed COMMIT',async()=>{
  const f=await executionFixture(pool),s=await stageRequest(pool,f)
  await assert.rejects(inExecution(pool,f,async tx=>{await stageInputInTransaction(tx,f.authority,f.context,s.request,f.executor);throw new Error('SYNTHETIC_BEFORE_COMMIT')}),{code:'DB_FAILURE'})
  const missing=await pool.query('SELECT count(*)::text AS n FROM durable_runtime.delivery_attempts WHERE message_id=$1',[f.messageId]);assert.equal(missing.rows[0].n,'0')
  const commands=await pool.query('SELECT count(*)::text AS n FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1',[f.context.runtimeUnitId]);assert.equal(commands.rows[0].n,'0')
  const originalMessage=await pool.query('SELECT intake_status,sealed_revision,sealed_payload_hash FROM durable_runtime.messages WHERE id=$1',[f.messageId]);assert.equal(originalMessage.rows[0].intake_status,'DURABLE');assert.equal(originalMessage.rows[0].sealed_revision,null);assert.equal(originalMessage.rows[0].sealed_payload_hash,null)
  await inExecution(pool,f,tx=>stageInputInTransaction(tx,f.authority,f.context,s.request,f.executor))
  const r=dispatch(f,s.deliveryId);await submitDispatch(pool,f,r)
  await assert.rejects(inExecution(pool,f,async tx=>{await import('./effect-claim.ts').then(m=>m.claimInputEffectInTransaction(tx,f.authority,f.context,original(r),f.executor));throw new Error('SYNTHETIC_BEFORE_COMMIT')}),{code:'DB_FAILURE'})
  const unchanged=await pool.query(`SELECT m.intake_status,c.state,c.execution_token FROM durable_runtime.messages m
    JOIN durable_runtime.runtime_commands c ON c.input->>'messageId'=m.id::text AND c.command_name='dispatchInput' WHERE m.id=$1`,[f.messageId])
  assert.equal(unchanged.rows[0].intake_status,'STAGED');assert.equal(unchanged.rows[0].state,'ACCEPTED');assert.equal(unchanged.rows[0].execution_token,null)
})

caseTest('UNKNOWN cancel and queue FAILED context are immutable quoted facts; query and history never wake',async()=>{
  const f=await executionFixture(pool),s=await stage(pool,f),r=dispatch(f,s.deliveryId);await claim(pool,f,r,true)
  const uncertainty={kind:'UNKNOWN',uncertainty:{kind:'INPUT_EFFECT_UNCERTAIN',reasonCode:'SYNTHETIC_LOST_PROVIDER_OBSERVATION',
    evidenceRef:`synthetic-unknown-${randomUUID()}`,observedAt:new Date().toISOString(),evidenceRefs:[]}} as unknown as InputDeliveryObservation
  await inExecution(pool,f,tx=>observeInputDeliveryInTransaction(tx,f.authority,fixed(f,s.deliveryId),uncertainty))
  const baseline=await pool.query('SELECT intent_revision,last_work_event_at,reconcile_due_at FROM durable_runtime.runtime_units WHERE id=$1',[f.context.runtimeUnitId])
  await requestInputCancel(pool,cancelRequest(f))
  const eventId=randomUUID(),agent=(await pool.query('SELECT agent_id FROM durable_runtime.sessions WHERE id=$1',[f.authority.sessionId])).rows[0].agent_id
  // P112 has already supplied immutable FAILED context: read, do not recreate/retry its event.
  await inExecution(pool,f,async tx=>{
    const producerId=randomUUID(),contextId=randomUUID()
    await tx.query(`INSERT INTO durable_runtime.runtime_event_producers
      (producer_id,incarnation,agent_id,runtime_unit_id,attempt_id,pod_uid,execution_epoch,committed_through)
      VALUES($1,'synthetic-failed-source',$2,$3,$4,$5,1,1)`,[producerId,agent,f.context.runtimeUnitId,f.attemptId,f.podUid])
    await tx.query(`INSERT INTO durable_runtime.runtime_event_queue(event_id,producer_id,incarnation,producer_seq,agent_id,payload,
      state,attempt_count,retry_count,last_error,terminal_at) VALUES($1,$2,'synthetic-failed-source',1,$3,
      '{"syntheticOriginal":"failed-event"}','FAILED',6,5,'SYNTHETIC_FAILURE',clock_timestamp())`,[eventId,producerId,agent])
    await tx.query('INSERT INTO durable_runtime.runtime_event_targets(event_id,session_id,agent_id) VALUES($1,$2,$3)',[eventId,f.authority.sessionId,agent])
    await tx.query(`INSERT INTO durable_runtime.session_context_records(id,session_id,revision,kind,target_event_id,body_ref)
      SELECT $1,id,context_revision+1,'RUNTIME_EVENT_FAILED',$2,
      '{"kind":"FAILED_RUNTIME_EVENT_HISTORY","errorCode":"SYNTHETIC_FAILURE","attempts":6,"executionDirective":"HISTORY_ONLY_DO_NOT_REEXECUTE"}'
      FROM durable_runtime.sessions WHERE id=$3`,[contextId,eventId,f.authority.sessionId])
    await tx.query('INSERT INTO durable_runtime.runtime_event_failure_contexts(event_id,session_id,context_record_id) VALUES($1,$2,$3)',[eventId,f.authority.sessionId,contextId])
    await tx.query('UPDATE durable_runtime.sessions SET context_revision=context_revision+1 WHERE id=$1',[f.authority.sessionId])
  })
  const frame=await getRecoveryContextFrame(pool,f.authority),again=await getRecoveryContextFrame(pool,f.authority)
  assert.equal(frame.hash,again.hash);assert.ok(Object.isFrozen(frame.payload))
  const p=frame.payload as {records:{kind:string;targetEventId:string|null}[];facts:{state:string;cancelRevision:string;originalComposition:object}[];originalEvents:{eventId:string;originalPayload:{syntheticOriginal:string}}[]}
  assert.ok(p.records.some(rec=>rec.kind==='RUNTIME_EVENT_FAILED'&&rec.targetEventId===eventId));assert.equal(p.facts[0].state,'UNKNOWN');assert.equal(p.facts[0].cancelRevision,'1');assert.equal(p.originalEvents[0].eventId,eventId);assert.equal(p.originalEvents[0].originalPayload.syntheticOriginal,'failed-event')
  const afterHistory=await pool.query('SELECT intent_revision,last_work_event_at,reconcile_due_at FROM durable_runtime.runtime_units WHERE id=$1',[f.context.runtimeUnitId]);assert.deepEqual(afterHistory.rows,baseline.rows)
  const next=response(await acceptInput(pool,{...f.request,operationKey:randomUUID()}));assert.notEqual(field(next,'messageId'),f.messageId)
  const afterInput=await getRecoveryContextFrame(pool,f.authority);assert.equal(afterInput.hash,frame.hash)
  const old=await pool.query('SELECT intake_status FROM durable_runtime.messages WHERE id=$1',[f.messageId]);assert.equal(old.rows[0].intake_status,'UNKNOWN')
})

caseTest('context proof exact retry is one original row; old binding proof retained but never current satisfaction',async()=>{
  const f=await executionFixture(pool);const frame=await getRecoveryContextFrame(pool,f.authority)
  const proof={kind:'PROVIDER_CONTEXT_DELIVERY',source:'PROVIDER_PROTOCOL',sessionId:f.authority.sessionId,
    contextRevision:frame.revision,contextHash:frame.hash,providerBindingRevision:counter('row:provider-binding','0'),
    runtimeUnitId:f.context.runtimeUnitId,attemptId:f.attemptId,podUid:f.podUid,executionEpoch:f.envelope.executionEpoch,
    evidenceRef:`synthetic-context-${randomUUID()}` as EvidenceRef,observedAt:new Date().toISOString(),
    providerRef:{provider:'codex',nativeSessionRef:'synthetic-context-session'}} as unknown as VerifiedContextDeliveryProof
  const before=await pool.query('SELECT intent_revision,last_work_event_at FROM durable_runtime.runtime_units WHERE id=$1',[f.context.runtimeUnitId])
  const saved=await inExecution(pool,f,tx=>recordContextDeliveryInTransaction(tx,f.authority,frame,proof));assert.equal(saved.currentSatisfied,true)
  const repeated=await inExecution(pool,f,tx=>recordContextDeliveryInTransaction(tx,f.authority,frame,proof));assert.equal(repeated.deliveryProofId,saved.deliveryProofId)
  await assert.rejects(inExecution(pool,f,tx=>recordContextDeliveryInTransaction(tx,f.authority,frame,
    {...proof,source:'PROVIDER_NATIVE_RECORD'})),{code:'CONTEXT_PROOF_RETRY_CONFLICT'})
  await pool.query('UPDATE durable_runtime.sessions SET provider_binding_revision=provider_binding_revision+1 WHERE id=$1',[f.authority.sessionId])
  const late=await inExecution(pool,f,tx=>recordContextDeliveryInTransaction(tx,f.authority,frame,proof));assert.equal(late.currentSatisfied,false)
  assert.equal(await inExecution(pool,f,tx=>isCurrentContextDeliveredInTransaction(tx,f.authority,saved.deliveryProofId)),false)
  const count=await pool.query('SELECT count(*)::text AS n FROM durable_runtime.provider_context_deliveries WHERE session_id=$1',[f.authority.sessionId]);assert.equal(count.rows[0].n,'1')
  const afterProof=await pool.query('SELECT intent_revision,last_work_event_at FROM durable_runtime.runtime_units WHERE id=$1',[f.context.runtimeUnitId]);assert.deepEqual(afterProof.rows,before.rows)
})

caseTest('termination before Stop and late completion belong to original delivery with observed proof only',async()=>{
  const f=await executionFixture(pool),s=await stage(pool,f);await claim(pool,f,dispatch(f,s.deliveryId),true)
  const proof=stop(f,s.deliveryId)
  await inExecution(pool,f,tx=>observeInputDeliveryInTransaction(tx,f.authority,fixed(f,s.deliveryId),{kind:'INTERRUPTED',proof}))
  const replay=await inExecution(pool,f,tx=>observeInputDeliveryInTransaction(tx,f.authority,fixed(f,s.deliveryId),{kind:'INTERRUPTED',proof}));assert.equal(replay.disposition,'REPLAYED')
  const cancellation=await requestInputCancel(pool,cancelRequest(f));assert.equal(field(response(cancellation),'interruptStatus'),'ALREADY_SETTLED')
  const second=await executionFixture(pool),delivery=await stage(pool,second);await claim(pool,second,dispatch(second,delivery.deliveryId),true)
  const intent=await requestInputCancel(pool,cancelRequest(second));assert.equal(field(response(intent),'interruptStatus'),'REQUESTED')
  const complete={...admission(second,delivery.deliveryId),kind:'PROVIDER_TARGET_COMPLETED'} as ProviderCompletedProof
  await inExecution(pool,second,tx=>observeInputDeliveryInTransaction(tx,second.authority,fixed(second,delivery.deliveryId),{kind:'SETTLED',proof:complete}))
  const done=await pool.query(`SELECT m.intake_status,ci.interrupt_status FROM durable_runtime.messages m JOIN durable_runtime.cancel_intents ci ON ci.target_message_id=m.id WHERE m.id=$1`,[second.messageId])
  assert.equal(done.rows[0].intake_status,'SETTLED');assert.equal(done.rows[0].interrupt_status,'ALREADY_SETTLED')
})
