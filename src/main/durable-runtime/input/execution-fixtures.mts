// Isolated test fixtures only: synthetic authority/proof, not authentication or fencing.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { withDurableTransaction, type DurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { acceptInput } from './intake.ts'
import { composeMessagePayload } from './composition.ts'
import { inputPayloadHash } from './canonical.ts'
import { requestInputCancel } from './cancel.ts'
import { stageInputInTransaction } from './stage.ts'
import { claimInputEffectInTransaction } from './effect-claim.ts'
import { fixture, response, field } from './verification-fixtures.mts'
import { LockedGatewayAuthority } from '../runtime/gateway/authority.ts'
import { submitCommand } from '../runtime/gateway/store.ts'
import { inputDigest } from '../runtime/gateway/input.ts'
import type { GatewayContext, SubmitCommand, ExecutorId, VerifiedControllerIdentity } from '../runtime/gateway/types.ts'
import type { ExternalCommandIdentity, CommandEnvelope } from '../runtime/command-types.ts'
import type { PayloadHash, PodUid } from '../runtime/runtime-evidence.ts'
import type { JsonValue } from '../db/atomic.ts'

export async function executionFixture(pool: Pool) {
  const f = await fixture(pool, 'RUNNING')
  const authority = f.request.authority
  const unitId = logicalId('runtime-unit', f.unitId)
  const operationId = logicalId('operation', randomUUID())
  const attemptId = logicalId('attempt', randomUUID())
  const podUid = `synthetic-pod-${attemptId}` as PodUid
  const controller = {scope:`synthetic-controller-${unitId}`, owner:'synthetic-owner', term:counter('controller-term','1')} as VerifiedControllerIdentity
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)",[unitId])
    await tx.query("UPDATE durable_runtime.runtime_units SET execution_epoch=1,phase='READY',intent_revision=1 WHERE id=$1",[unitId])
    await tx.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status)
      VALUES($1,$2,1,'COLD',$3,'synthetic-runtime',0,'{}','READY')`,[attemptId,unitId,podUid])
    await tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1',[unitId,attemptId])
    await tx.query("INSERT INTO durable_runtime.execution_grants(id,runtime_unit_id,attempt_id,execution_epoch,state) VALUES($1,$2,$3,1,'ACTIVE')",[randomUUID(),unitId,attemptId])
    await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '30 minutes')",[controller.scope,controller.owner])
    await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,step_revision,expected_pod_uid,execution_epoch)
      VALUES($1,$2,'verification',1,$3,1,'INPUT',0,$4,1)`,[operationId,unitId,controller.scope,podUid])
  })
  const accepted = response(await acceptInput(pool, f.request))
  const messageId = logicalId('message', field(accepted,'messageId'))
  const messageRevision = counter('message-revision', field(accepted,'messageRevision'))
  const context: GatewayContext = {runtimeUnitId:unitId,operationId,controller}
  const envelope: CommandEnvelope = {operationId,controllerTerm:controller.term,stepRevision:counter('step-revision','0'),
    executionEpoch:counter('execution-epoch','1'),intentRevision:counter('intent-revision','1'),podTarget:'EXISTING_POD',expectedPodUid:podUid}
  const executor = 'synthetic-executor' as ExecutorId
  return {...f,authority,context,envelope,attemptId,podUid,executor,messageId,messageRevision}
}
export type ExecutionFixture = Awaited<ReturnType<typeof executionFixture>>
export function inExecution<T>(pool:Pool,f:ExecutionFixture,body:(tx:DurableTransaction)=>Promise<T>) {
  return withDurableTransaction(pool,async tx=>{
    await lockAggregates(tx,{sessionIds:[f.authority.sessionId],runtimeUnitIds:[f.context.runtimeUnitId],operationIds:[f.context.operationId]})
    return body(tx)
  })
}
export function original(request:SubmitCommand):ExternalCommandIdentity {
  return {command:request.command, originalEnvelope:request.envelope, inputHash:request.inputHash}
}
export function command(f:ExecutionFixture,name:'stageInput'|'dispatchInput',input:JsonValue):SubmitCommand {
  return {command:name,envelope:{...f.envelope},inputHash:inputDigest(input) as PayloadHash,input,predecessor:{kind:'NONE'}}
}
export async function stageRequest(pool:Pool,f:ExecutionFixture,contextRevision='0') {
  const payload=await inExecution(pool,f,tx=>composeMessagePayload(tx,f.authority.sessionId,f.messageId,'GENERAL'))
  const sealed={messageId:f.messageId,sealedRevision:f.messageRevision,payloadHash:inputPayloadHash(payload),payload}
  const deliveryId=logicalId('delivery-attempt',randomUUID())
  const request=command(f,'stageInput',{messageId:f.messageId,sealedRevision:sealed.sealedRevision,payloadHash:sealed.payloadHash,
    deliveryAttemptId:deliveryId,contextRevision,bodyRef:`synthetic-sealed-message:${f.messageId}`})
  return {request,deliveryId,sealed}
}
export async function stage(pool:Pool,f:ExecutionFixture,contextRevision='0') {
  const s=await stageRequest(pool,f,contextRevision)
  const result=await inExecution(pool,f,tx=>stageInputInTransaction(tx,f.authority,f.context,s.request,f.executor))
  assert.equal(result.disposition,'STAGED')
  return {...s,result}
}
export function dispatch(f:ExecutionFixture,deliveryId:string) {
  return command(f,'dispatchInput',{messageId:f.messageId,deliveryAttemptId:deliveryId})
}
export async function submitDispatch(pool:Pool,f:ExecutionFixture,request:SubmitCommand) {
  return inExecution(pool,f,async tx=>submitCommand(await LockedGatewayAuthority.acquire(tx,f.context),request))
}
export async function claim(pool:Pool,f:ExecutionFixture,request:SubmitCommand,submit=false) {
  return inExecution(pool,f,async tx=>{
    if(submit) await submitCommand(await LockedGatewayAuthority.acquire(tx,f.context),request)
    return claimInputEffectInTransaction(tx,f.authority,f.context,original(request),f.executor)
  })
}
export function cancelRequest(f:ExecutionFixture) {
  return {authority:f.authority,method:'verification.cancel',operationKey:randomUUID(),targetMessageId:f.messageId,originalPayload:{}}
}
export function cancel(pool:Pool,f:ExecutionFixture) { return requestInputCancel(pool,cancelRequest(f)) }
export function fixed(f:ExecutionFixture,deliveryId:string) {
  return {messageId:f.messageId,deliveryAttemptId:logicalId('delivery-attempt',deliveryId),runtimeUnitId:f.context.runtimeUnitId,
    attemptId:f.attemptId,podUid:f.podUid,executionEpoch:f.envelope.executionEpoch}
}
export async function nextStep(pool:Pool,f:ExecutionFixture) {
  const r=await pool.query('UPDATE durable_runtime.operations SET step_revision=step_revision+1 WHERE id=$1 RETURNING step_revision',[f.context.operationId])
  f.envelope={...f.envelope,stepRevision:counter('step-revision',r.rows[0].step_revision)}
}
export function gate() {
  let release!:()=>void
  const promise=new Promise<void>(resolve=>{release=resolve})
  return {promise,release}
}
/** Only test-owned checkout clients; hold real Session row after SQL lock acquisition. */
export function holdSessionPool(pool:Pool,held:ReturnType<typeof gate>,release:ReturnType<typeof gate>) {
  return new Proxy(pool,{get(target,key){
    if(key==='connect')return async()=>{
      const client=await target.connect()
      return new Proxy(client,{get(c,k){
        if(k==='query')return async(sql:unknown,...args:unknown[])=>{
          const result=await Reflect.apply(c.query,c,[sql,...args])
          if(String(sql)==='SELECT id FROM durable_runtime.sessions WHERE id=$1 FOR UPDATE') {held.release();await release.promise}
          return result
        }
        const value=Reflect.get(c,k);return typeof value==='function'?value.bind(c):value
      }})
    }
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
}
export async function waitForOwnedSessionWaiter(pool:Pool) {
  const deadline=Date.now()+3000
  while(Date.now()<deadline){
    const r=await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT id FROM durable_runtime.sessions WHERE id=$1 FOR UPDATE'`)
    if(r.rows[0].n>0)return
    await new Promise(resolve=>setTimeout(resolve,20))
  }
  throw new Error('NO_ACTUAL_SESSION_LOCK_OVERLAP')
}
