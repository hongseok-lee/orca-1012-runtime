import { RECOVERY_CHAIN_HEAD_SQL } from './recovery-chain.ts'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { runDurableTransaction, type DurableTransaction } from '../db/connection.ts'
import type { RuntimeUnitRow } from '../db/rows.ts'
import { lockAggregates } from '../db/locks.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { artifacts } from '../notifications/artifacts.ts'
import type { NotificationRow } from '../notifications/types.ts'
import { LockedGatewayAuthority, currentAuthoritySql } from '../runtime/gateway/authority.ts'
import type { VerifiedControllerIdentity } from '../runtime/gateway/types.ts'
import { adoptOperation } from './controller.ts'
import { insertIntentOperation } from './intent.ts'
import type { LifecycleOperation, LifecyclePolicy } from './types.ts'

// Existing rewake policy, now captured on the original operation rather than a Map.
const LIMIT = 3, DELAY_MS = 60_000
type RecoveryOperation = LifecycleOperation
export type RewakeOperationClaim = Readonly<{ operationId:string; rootOperationId:string;
  resourceName:string; executionEpoch:string; intentRevision:string; deadlineAt:string }>

async function unitLock(tx:DurableTransaction,unitId:string) {
  const members=(await tx.query<{session_id:string}>('SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1 ORDER BY session_id',[unitId])).rows
  await lockAggregates(tx,{sessionIds:members.map(r=>logicalId('session',r.session_id)),runtimeUnitIds:[logicalId('runtime-unit',unitId)]})
  return (await tx.query<RuntimeUnitRow>('SELECT * FROM durable_runtime.runtime_units WHERE id=$1',[unitId])).rows[0]
}
async function authorize(tx:DurableTransaction,controller:VerifiedControllerIdentity,unit:RuntimeUnitRow,ids:string[],clock:Date) {
  await lockAggregates(tx,{operationIds:[...new Set(ids)].map(id=>logicalId('operation',id))})
  const authority=await LockedGatewayAuthority.acquire(tx,{controller,runtimeUnitId:unit.id,operationId:logicalId('operation',ids[0])})
  for(const id of new Set(ids)) {
    const operation=(await tx.query<RecoveryOperation>('SELECT * FROM durable_runtime.operations WHERE id=$1',[id])).rows[0]
    await adoptOperation(tx,{context:{controller,runtimeUnitId:unit.id,operationId:logicalId('operation',id)},mutationKey:`rewake:${id}`,
      expectedUnitRevision:unit.revision,expectedIntentRevision:unit.intent_revision,expectedStepRevision:operation.step_revision},operation,clock)
  }
  return authority
}
async function event(tx:DurableTransaction,controller:VerifiedControllerIdentity,unitId:string,rootId:string,kind:string,reason:string|null) {
  const root=(await tx.query<RecoveryOperation>('SELECT * FROM durable_runtime.operations WHERE id=$1',[rootId])).rows[0]
  const nextState={kind,rootOperationId:rootId,reason,retryCount:root.retry_count,retryLimit:root.retry_limit,
    deadlineAt:root.deadline_at?.toISOString()??null,retryAt:root.retry_at?.toISOString()??null}
  const audit=await appendAudit(tx,{actorId:controller.owner,runtimeUnitId:unitId,operationId:rootId,kind,nextState,
    occurredAt:new Date(),receivedAt:new Date(),producerId:randomUUID(),producerSeq:counter('sequence:producer','1'),evidenceRefs:[]})
  await enqueueOutbox(tx,{eventId:logicalId('event',audit),aggregateId:rootId,aggregateKind:'operation',revision:root.revision,event:nextState})
  if(kind==='REWAKE_RETRY_EXHAUSTED') {
    const rows=await tx.query<NotificationRow>(`INSERT INTO durable_runtime.notifications
      (id,incident_key,target_ref,reason,state,first_seen_at,last_seen_at,retry_count)
      VALUES($1,$2,$3,$4,'OPEN',clock_timestamp(),clock_timestamp(),$5) ON CONFLICT(incident_key) DO NOTHING RETURNING *`,
    [randomUUID(),`rewake-retry:${rootId}`,JSON.stringify({runtimeUnitId:unitId,operationId:rootId}),reason,root.retry_count])
    for(const row of rows.rows) {await artifacts(tx,row,{kind:'NOTIFICATION_OPENED',eventId:randomUUID(),actorId:controller.owner,
      evidenceRef:`rewake-budget:${rootId}`,occurredAt:new Date()})}
  }
}
async function exhaust(tx:DurableTransaction,controller:VerifiedControllerIdentity,unitId:string,root:RecoveryOperation,reason:string) {
  const changed=await tx.query(`UPDATE durable_runtime.operations r SET retry_exhausted_reason=$2,retry_at=NULL,revision=revision+1
    WHERE id=$1 AND ${RECOVERY_CHAIN_HEAD_SQL} AND retry_exhausted_reason IS NULL RETURNING id`,[root.id,reason])
  if(changed.rowCount) {
    await tx.query("UPDATE durable_runtime.runtime_units SET phase='BLOCKED',reconcile_due_at=NULL,revision=revision+1 WHERE id=$1 AND active_attempt_id IS NULL AND phase<>'BLOCKED'",[unitId])
    await event(tx,controller,unitId,root.id,'REWAKE_RETRY_EXHAUSTED',reason)
  }
}

/** One committed operation claim before preparation or external lookup. Children
 * have immutable plan identities but share the original deadline/spent budget. */
export async function claimRewakeOperation(pool:Pool,controller:VerifiedControllerIdentity,unitId:string,policy:LifecyclePolicy):Promise<RewakeOperationClaim|null> {
  const result=await runDurableTransaction(pool,async tx=>{
    let unit=await unitLock(tx,unitId)
    if(!unit || unit.desired_mode==='DELETED') {return null}
    if(!(await tx.query(`SELECT 1 FROM durable_runtime.messages x JOIN durable_runtime.runtime_members m ON m.session_id=x.session_id
      JOIN durable_runtime.sessions s ON s.id=x.session_id WHERE m.runtime_unit_id=$1 AND s.lifecycle='OPEN'
      AND x.intake_status='DURABLE' AND x.cancel_revision=0 LIMIT 1`,[unitId])).rowCount) {return null}
    const clock=(await tx.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now
    if(!(await tx.query(`SELECT 1 WHERE ${currentAuthoritySql}`,[controller.scope,controller.owner,controller.term])).rowCount) {return null}
    const anchor=(await tx.query<{id:string;execution_epoch:string}>(`SELECT id,execution_epoch::text FROM durable_runtime.attempts
      WHERE runtime_unit_id=$1 AND ready_at IS NOT NULL ORDER BY execution_epoch DESC,ready_at DESC,id LIMIT 1`,[unitId])).rows[0]
    let initialized=false
    let root=(await tx.query<RecoveryOperation>(`SELECT r.* FROM durable_runtime.operations r WHERE r.runtime_unit_id=$1 AND ${RECOVERY_CHAIN_HEAD_SQL} AND r.recovery_anchor_attempt_id IS NOT DISTINCT FROM $2::uuid`,[unitId,anchor?.id??null])).rows[0]
    if(!root) {
      initialized=true
      // Import distinguishable legacy operations after this READY generation.
      // Lost pre-operation Map failures/due times cannot be reconstructed.
      const legacy=(await tx.query<RecoveryOperation>(`SELECT * FROM durable_runtime.operations WHERE runtime_unit_id=$1 AND kind='WAKE'
        AND ($2::bigint IS NULL OR execution_epoch>$2) AND recovery_root_id IS NULL ORDER BY execution_epoch,deadline_at NULLS LAST,id`,[unitId,anchor?.execution_epoch??null])).rows
      if(!legacy.length) {
        if(unit.active_attempt_id) {return null}
        unit=(await tx.query<RuntimeUnitRow>(`UPDATE durable_runtime.runtime_units SET desired_mode='RUNNING',
          intent_revision=intent_revision+CASE WHEN desired_mode='RUNNING' THEN 0 ELSE 1 END,revision=revision+1 WHERE id=$1 RETURNING *`,[unitId])).rows[0]
        legacy.push(await insertIntentOperation(tx,unit,policy))
      }
      root=legacy[0]
      const failed=legacy.filter(o=>o.step==='FAILED'||(o.result && typeof o.result==='object'&&!Array.isArray(o.result)&&o.result.state==='FAILED')).length
      await tx.query(`UPDATE durable_runtime.operations SET recovery_root_id=id,recovery_anchor_attempt_id=$2,retry_limit=$3,retry_count=$4,
        retry_at=CASE WHEN $4::bigint>0 THEN coalesce(retry_at,clock_timestamp()+$5::bigint*interval '1 millisecond') ELSE retry_at END,
        retry_exhausted_reason=CASE WHEN deadline_at IS NULL THEN 'REWAKE_DEADLINE_UNAVAILABLE' ELSE NULL END,revision=revision+1 WHERE id=$1`,
      [root.id,anchor?.id??null,LIMIT,failed,DELAY_MS])
      for(const old of legacy) {
        await tx.query(`UPDATE durable_runtime.operations SET recovery_root_id=$2,recovery_anchor_attempt_id=$3,retry_limit=$4,
          deadline_at=(SELECT deadline_at FROM durable_runtime.operations WHERE id=$2),
          retry_exhausted_reason=CASE WHEN (SELECT deadline_at FROM durable_runtime.operations WHERE id=$2) IS NULL THEN 'REWAKE_DEADLINE_UNAVAILABLE' ELSE retry_exhausted_reason END,
          retry_accounted_at=CASE WHEN result IS NOT NULL THEN clock_timestamp() ELSE NULL END,
          retry_claimed_at=CASE WHEN step<>'INTENT_QUEUED' OR result IS NOT NULL OR EXISTS(SELECT 1 FROM durable_runtime.agent_pod_plans p WHERE p.operation_id=$1)
            OR EXISTS(SELECT 1 FROM durable_runtime.runtime_commands c WHERE c.operation_id=$1) THEN clock_timestamp() ELSE NULL END,
          revision=revision+1 WHERE id=$1`,[old.id,root.id,anchor?.id??null,LIMIT])
      }
      await tx.query("UPDATE durable_runtime.operations SET retry_owner='legacy-owner-unavailable',retry_owner_term=controller_term WHERE recovery_root_id=$1 AND retry_claimed_at IS NOT NULL AND retry_owner IS NULL",[root.id])
      root=(await tx.query<RecoveryOperation>('SELECT * FROM durable_runtime.operations WHERE id=$1',[root.id])).rows[0]
    }
    const rows=(await tx.query<RecoveryOperation>('SELECT * FROM durable_runtime.operations WHERE recovery_root_id=$1 ORDER BY id',[root.id])).rows
    let selected=rows.find(o=>o.retry_claimed_at===null && o.result===null && o.step==='INTENT_QUEUED')
    const owned=rows.some(o=>o.retry_claimed_at!==null && o.retry_accounted_at===null)
    // Writer/command uncertainty is never solved by spending another attempt.
    const live=await tx.query(`SELECT 1 FROM durable_runtime.attempts WHERE runtime_unit_id=$1 AND stopped_at IS NULL
      UNION ALL SELECT 1 FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1
      AND (state IN ('ACCEPTED','EXECUTING') OR (state='UNKNOWN' AND command_name<>'dispatchInput'))
      UNION ALL SELECT 1 FROM durable_runtime.storage_write_grants g WHERE g.state<>'REVOKED' AND EXISTS(
        SELECT 1 FROM durable_runtime.runtime_member_storage_bindings m WHERE m.runtime_unit_id=$1 AND m.storage_binding_id=g.storage_binding_id)
      UNION ALL SELECT 1 FROM durable_runtime.storage_bindings b WHERE b.writer_attempt_id IS NOT NULL AND EXISTS(
        SELECT 1 FROM durable_runtime.runtime_member_storage_bindings m WHERE m.runtime_unit_id=$1 AND m.storage_binding_id=b.id)`,[unitId])
    const exhausted=root.retry_exhausted_reason!==null || !root.deadline_at || root.deadline_at<=clock || BigInt(root.retry_count)>=BigInt(root.retry_limit!)
    if(!owned && !live.rowCount && !exhausted && (!root.retry_at || root.retry_at<=clock)) {
      unit=(await tx.query<RuntimeUnitRow>(`UPDATE durable_runtime.runtime_units SET desired_mode='RUNNING',
        intent_revision=intent_revision+CASE WHEN desired_mode='RUNNING' THEN 0 ELSE 1 END,
        execution_epoch=execution_epoch+CASE WHEN EXISTS(SELECT 1 FROM durable_runtime.attempts a
          WHERE a.runtime_unit_id=$1 AND a.execution_epoch=runtime_units.execution_epoch AND a.stopped_at IS NOT NULL) THEN 1 ELSE 0 END,
        reconcile_due_at=clock_timestamp(),revision=revision+1 WHERE id=$1 RETURNING *`,[unitId])).rows[0]
      if(!selected) {selected=await insertIntentOperation(tx,unit,policy)}
      await tx.query(`UPDATE durable_runtime.operations SET recovery_root_id=$2,recovery_anchor_attempt_id=$3,retry_limit=$4,
        deadline_at=(SELECT deadline_at FROM durable_runtime.operations WHERE id=$2),execution_epoch=$5,intent_revision=$6,expected_pod_uid=NULL,retry_claimed_at=clock_timestamp(),
        retry_owner=$7,retry_owner_term=$8,revision=revision+1 WHERE id=$1`,
      [selected.id,root.id,anchor?.id??null,root.retry_limit,unit.execution_epoch,unit.intent_revision,controller.owner,controller.term])
    }
    const authority=await authorize(tx,controller,unit,[root.id,...rows.map(o=>o.id),...(selected?[selected.id]:[])],clock)
    if(root.retry_exhausted_reason) {
      if(initialized) {await event(tx,controller,unitId,root.id,'REWAKE_RETRY_EXHAUSTED',root.retry_exhausted_reason)}
      return null
    }
    if(exhausted) {
      await exhaust(tx,controller,unitId,root,!root.deadline_at?'REWAKE_DEADLINE_UNAVAILABLE':root.deadline_at<=clock?'REWAKE_DEADLINE_EXHAUSTED':'REWAKE_RETRY_EXHAUSTED')
      return null
    }
    if(owned || live.rowCount || (root.retry_at && root.retry_at>clock) || !selected) {return null}
    await tx.query('UPDATE durable_runtime.operations SET retry_at=NULL,revision=revision+1 WHERE id=$1',[root.id])
    await event(tx,controller,unitId,root.id,'REWAKE_ATTEMPT_CLAIMED',null)
    await authority.assertCurrent()
    return Object.freeze({operationId:selected.id,rootOperationId:root.id,resourceName:selected.external_resource_name!,
      executionEpoch:unit.execution_epoch,intentRevision:unit.intent_revision,deadlineAt:root.deadline_at!.toISOString()})
  })
  if(!result.ok) {throw result.error}
  return result.commitOutcome==='ACKNOWLEDGED'&&!result.cleanupFailed?result.value:null
}

/** Original command/Pod retirement precedes failure settlement. Exactly one
 * accounting transition owns each failure; polling/takeover cannot spend twice. */
export async function settleRewakeOperation(pool:Pool,controller:VerifiedControllerIdentity,operationId:string,reason:string):Promise<boolean> {
  const result=await runDurableTransaction(pool,async tx=>{
    const original=(await tx.query<RecoveryOperation>('SELECT * FROM durable_runtime.operations WHERE id=$1',[operationId])).rows[0]
    if(!original?.recovery_root_id) {return false}
    const unit=await unitLock(tx,original.runtime_unit_id)
    const clock=(await tx.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now
    const root=(await tx.query<RecoveryOperation>(`SELECT r.* FROM durable_runtime.operations r WHERE r.id=$1 AND ${RECOVERY_CHAIN_HEAD_SQL}`,[original.recovery_root_id])).rows[0]
    if(!root) {return false}
    const authority=await authorize(tx,controller,unit,[original.recovery_root_id,operationId],clock)
    const op=(await tx.query<RecoveryOperation>('SELECT * FROM durable_runtime.operations WHERE id=$1',[operationId])).rows[0]
    if(op.retry_accounted_at) {return true}
    const ready=(await tx.query(`SELECT 1 FROM durable_runtime.attempts a JOIN durable_runtime.agent_pod_plans p ON p.attempt_id=a.id
      WHERE p.operation_id=$1 AND a.ready_at IS NOT NULL`,[op.id])).rowCount
    if(ready) {
      await tx.query('UPDATE durable_runtime.operations SET retry_accounted_at=clock_timestamp(),revision=revision+1 WHERE id=$1',[op.id])
      await tx.query('UPDATE durable_runtime.operations SET recovery_resolved_at=clock_timestamp(),retry_at=NULL,revision=revision+1 WHERE id=$1',[root.id])
      const notices=await tx.query<NotificationRow>(`UPDATE durable_runtime.notifications SET state='RESOLVED',resolved_at=clock_timestamp(),
        last_seen_at=clock_timestamp(),revision=revision+1 WHERE incident_key=$1 AND state='OPEN' RETURNING *`,[`rewake-retry:${root.id}`])
      for(const notice of notices.rows) {await artifacts(tx,notice,{kind:'NOTIFICATION_RESOLVED',eventId:randomUUID(),actorId:controller.owner,
        evidenceRef:`rewake-ready:${op.id}`,occurredAt:clock})}
      await event(tx,controller,unit.id,root.id,'REWAKE_RECOVERY_READY',null)
      await authority.assertCurrent();return true
    }
    if((await tx.query('SELECT 1 FROM durable_runtime.attempts WHERE runtime_unit_id=$1 AND stopped_at IS NULL',[unit.id])).rowCount) {
      if(root.deadline_at && root.deadline_at<=clock) {await exhaust(tx,controller,unit.id,root,'REWAKE_DEADLINE_EXHAUSTED')}
      return false
    }
    const failed={state:'FAILED',reason}
    await tx.query(`UPDATE durable_runtime.runtime_commands SET state='RESOLVED',settled_at=clock_timestamp(),result=$2::jsonb,revision=revision+1
      WHERE operation_id=$1 AND state IN ('ACCEPTED','EXECUTING')`,[op.id,JSON.stringify(failed)])
    await tx.query(`UPDATE durable_runtime.operations SET step=CASE WHEN result IS NULL THEN 'FAILED' ELSE step END,
      result=coalesce(result,$2::jsonb),step_revision=step_revision+CASE WHEN result IS NULL THEN 1 ELSE 0 END,
      retry_accounted_at=clock_timestamp(),revision=revision+1 WHERE id=$1`,[op.id,JSON.stringify(failed)])
    const after=(await tx.query<RecoveryOperation>(`UPDATE durable_runtime.operations SET retry_count=retry_count+1,
      retry_at=CASE WHEN retry_exhausted_reason IS NULL THEN clock_timestamp()+$2::bigint*interval '1 millisecond' ELSE NULL END,
      revision=revision+1 WHERE id=$1 RETURNING *`,[root.id,DELAY_MS])).rows[0]
    if(after.retry_exhausted_reason===null && (!after.deadline_at || after.deadline_at<=clock || BigInt(after.retry_count)>=BigInt(after.retry_limit!))) {
      await exhaust(tx,controller,unit.id,after,!after.deadline_at?'REWAKE_DEADLINE_UNAVAILABLE':after.deadline_at<=clock?'REWAKE_DEADLINE_EXHAUSTED':'REWAKE_RETRY_EXHAUSTED')
    } else if(after.retry_exhausted_reason===null) {
      await tx.query(`UPDATE durable_runtime.runtime_units SET phase='ABSENT',reconcile_due_at=LEAST($2::timestamptz,$3::timestamptz),
        revision=revision+1 WHERE id=$1 AND active_attempt_id IS NULL`,[unit.id,after.retry_at,after.deadline_at])
      await event(tx,controller,unit.id,root.id,'REWAKE_RETRY_SCHEDULED',reason)
    }
    await authority.assertCurrent();return true
  })
  return result.ok && result.commitOutcome==='ACKNOWLEDGED'&&!result.cleanupFailed && result.value
}
