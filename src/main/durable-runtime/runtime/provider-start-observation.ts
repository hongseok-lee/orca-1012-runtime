import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { runDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { appendAudit } from '../journal/store.ts'
import { publishCatalogTerminalNativeSessionReady } from '../catalog/terminal-native-session.ts'
import { LockedGatewayAuthority } from './gateway/authority.ts'
import type { GatewayContext } from './gateway/types.ts'
import type { ReadyProviderBinding } from '../providers/shared/contracts.ts'

/** Actual original driver's native response, separate from READY settlement.
 * A caller-selected logical/native launch ID is never recorded through this seam. */
export async function recordInitialNativeObservation(pool:Pool,context:GatewayContext,binding:ReadyProviderBinding,
  owns:(binding:ReadyProviderBinding)=>boolean):Promise<boolean> {
  if(!owns(binding)) {return false}
  const result=await runDurableTransaction(pool,async tx=>{
    await lockAggregates(tx,{sessionIds:[binding.sessionId],runtimeUnitIds:[binding.runtimeUnitId]})
    const authority=await LockedGatewayAuthority.acquire(tx,context)
    if(!owns(binding)) {return false}
    const current=await tx.query(`SELECT 1 FROM durable_runtime.runtime_units u JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id
      WHERE u.id=$1 AND a.id=$2 AND a.pod_uid=$3 AND a.execution_epoch=$4 AND a.stopped_at IS NULL`,
    [binding.runtimeUnitId,binding.attemptId,binding.podUid,binding.executionEpoch])
    if(!current.rowCount) {return false}
    const prior = await tx.query(`SELECT 1 FROM durable_runtime.runtime_audit_events WHERE attempt_id=$1
      AND kind='INITIAL_PROVIDER_NATIVE_OBSERVED' AND next_state->'providerRef'=$2::jsonb`, [binding.attemptId, JSON.stringify(binding.providerRef)])
    if (prior.rowCount) { return true }
    await appendAudit(tx,{actorId:context.controller.owner,sessionId:binding.sessionId,runtimeUnitId:binding.runtimeUnitId,
      operationId:context.operationId,attemptId:binding.attemptId,podUid:binding.podUid,kind:'INITIAL_PROVIDER_NATIVE_OBSERVED',
      nextState:{providerRef:{...binding.providerRef},source:'ORIGINAL_NATIVE_RESPONSE'},occurredAt:new Date(),receivedAt:new Date(),
      producerId:logicalId('producer',randomUUID()),producerSeq:counter('sequence:producer','1'),evidenceRefs:[]})
    const ready = await tx.query<{id:string}>(`SELECT id FROM durable_runtime.runtime_audit_events
      WHERE session_id=$1 AND kind='INITIAL_PROVIDER_READY' AND next_state->>'attemptId'=$2`, [binding.sessionId,binding.attemptId])
    if (ready.rowCount === 1) { await publishCatalogTerminalNativeSessionReady(tx,ready.rows[0].id,binding) }
    await authority.assertCurrent();return true
  })
  return result.ok&&result.commitOutcome==='ACKNOWLEDGED'&&!result.cleanupFailed&&result.value
}

/** Called only after exact Pod-token authentication and same-control host frame
 * verification. This is a provider ROOT exit observation, not a sandbox stop. */
export async function recordProviderChildExit(pool:Pool,target:Readonly<{runtimeUnitId:string;operationId:string;podUid:string;
  executionEpoch:string}>,exit:Readonly<{controlId:string;hostSeq:number}>):Promise<void> {
  await pool.query(`INSERT INTO durable_runtime.runtime_audit_events(id,actor_id,runtime_unit_id,operation_id,attempt_id,pod_uid,
    kind,next_state,occurred_at,received_at,producer_id,producer_seq,evidence_refs,payload)
    SELECT gen_random_uuid(),'authenticated-agent-control',u.id,$2,a.id,a.pod_uid,'PROVIDER_CHILD_EXIT_OBSERVED',
      jsonb_build_object('kind','PROVIDER_CHILD_EXIT','controlId',$5::text,'hostSeq',$6::bigint,'sandboxStopped',false),
      clock_timestamp(),clock_timestamp(),$5::uuid,$6::bigint,'[]','{}'
    FROM durable_runtime.runtime_units u JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id
    WHERE u.id=$1 AND a.pod_uid=$3 AND a.execution_epoch=$4 AND a.stopped_at IS NULL
    ON CONFLICT(producer_id,producer_seq) DO NOTHING`,
  [target.runtimeUnitId,target.operationId,target.podUid,target.executionEpoch,exit.controlId,exit.hostSeq])
}

/** Original authenticated control read, committed before any native COLD.
 * V1 hosts durably mark entry before effects, so NONE survives interrupted
 * starts. An old uninstrumented releaseGate has no such record: ambiguous. */
export async function recordNativeCheckpointGuard(pool:Pool,context:GatewayContext,attemptId:string,podUid:string,state:string):Promise<boolean> {
  const result=await runDurableTransaction(pool,async tx=>{
    await lockAggregates(tx,{runtimeUnitIds:[context.runtimeUnitId]})
    const authority=await LockedGatewayAuthority.acquire(tx,context)
    await appendAudit(tx,{actorId:context.controller.owner,runtimeUnitId:context.runtimeUnitId,operationId:context.operationId,
      attemptId,podUid,kind:'INITIAL_NATIVE_CHECKPOINT_GUARDED',nextState:{source:'AUTHENTICATED_AGENT_HOME',protocolVersion:1,state},
      occurredAt:new Date(),receivedAt:new Date(),producerId:randomUUID(),producerSeq:counter('sequence:producer','1'),evidenceRefs:[]})
    await authority.assertCurrent();return true
  })
  return result.ok&&result.commitOutcome==='ACKNOWLEDGED'&&!result.cleanupFailed&&result.value
}
