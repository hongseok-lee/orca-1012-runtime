import type { PayloadHash } from '../runtime/runtime-evidence.ts'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { TerminalRuntimeLookup } from './runtime-input-types.ts'
import { withDurableTransaction, runDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { InputStoreError } from './types.ts'
import { LockedGatewayAuthority, currentAuthoritySql } from '../runtime/gateway/authority.ts'
import { submitCommand, originalIdentity } from '../runtime/gateway/store.ts'
import { claimCommand, markCommandUnknown, settleOwnedExecution } from '../runtime/gateway/claim.ts'
import { inputDigest } from '../runtime/gateway/input.ts'
import { assertProviderCancelTarget } from '../runtime/provider-cancel-target.ts'
import type { GatewayContext } from '../runtime/gateway/types.ts'

type Intent = { operation_id: string; target_message_id: string; target_attempt_id: string;
  target_execution_epoch: string; target_provider_turn_ref: string; delivery_id: string }

/** Consumes committed fixed targets with the actual ready owner's authority.
 * An already claimed command is never resubmitted after response loss/restart. */
export function createProviderCancelRuntime(pool: Pool, lookup: TerminalRuntimeLookup,
  report: (code: string) => void = () => {}) {
  let closed = false, tail = Promise.resolve()
  const queued = new Set<string>()
  async function run(sessionId: string): Promise<void> {
    const port = lookup(sessionId)
    if (closed || !port?.cancel || !port.cancelTarget) { return }
    const b = port.binding
    const current = () => {
      const next = lookup(sessionId)
      if (closed || !next || next.binding !== b || next.context.controller !== port.context.controller) {
        throw new InputStoreError('CANCEL_RUNTIME_OWNER_CHANGED')
      }
    }
    const intents = await pool.query<Intent>(`SELECT c.*,r.body_ref->'fixedDelivery'->>'deliveryAttemptId' AS delivery_id
      FROM durable_runtime.cancel_intents c JOIN durable_runtime.session_context_records r
        ON r.session_id=c.session_id AND r.kind='CANCEL_INTENT' AND r.body_ref->>'operationId'=c.operation_id::text
      WHERE c.session_id=$1 AND c.interrupt_status='REQUESTED'
        AND c.target_attempt_id=$2 AND c.target_execution_epoch=$3
        AND NOT EXISTS(SELECT 1 FROM durable_runtime.operations o WHERE o.cancel_intent_id=c.operation_id)
      ORDER BY c.requested_at,c.operation_id`, [sessionId,b.attemptId,b.executionEpoch])
    for (const intent of intents.rows) {
      current()
      const target = port.cancelTarget(intent.delivery_id,intent.target_provider_turn_ref)
      if (!target || target.identity.messageId !== intent.target_message_id || target.identity.binding !== b &&
          JSON.stringify(target.identity.binding) !== JSON.stringify(b)) { continue }
      const context: GatewayContext = Object.freeze({ ...port.context, operationId: logicalId('operation',randomUUID()) })
      const commandInput = { cancelIntentId:intent.operation_id, attemptId:b.attemptId,
        deliveryAttemptId:target.identity.deliveryAttemptId,
        target:{ targetMessageId:target.identity.messageId, targetTurnId:intent.target_provider_turn_ref } }
      const claim = await withDurableTransaction(pool, async tx => {
        await lockAggregates(tx,{sessionIds:[b.sessionId],runtimeUnitIds:[b.runtimeUnitId]})
        current()
        const c=context.controller
        const inserted=await tx.query<{intent_revision:string}>(`INSERT INTO durable_runtime.operations
          (id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,expected_pod_uid,execution_epoch,cancel_intent_id)
          SELECT $4,u.id,'INPUT_CANCEL',u.intent_revision,$1,$3,'CANCEL',$5,$6,$7
          FROM durable_runtime.runtime_units u WHERE u.id=$8 AND u.phase='READY'
            AND u.active_attempt_id=$9 AND u.execution_epoch=$6 AND ${currentAuthoritySql}
          ON CONFLICT(cancel_intent_id) DO NOTHING RETURNING intent_revision::text`,
        [c.scope,c.owner,c.term,context.operationId,b.podUid,b.executionEpoch,intent.operation_id,b.runtimeUnitId,b.attemptId])
        if (!inserted.rowCount) { return null }
        const gateway=await LockedGatewayAuthority.acquire(tx,context)
        const submitted=await submitCommand(gateway,{command:'cancel',input:commandInput,inputHash:inputDigest(commandInput) as PayloadHash,
          envelope:{operationId:context.operationId,controllerTerm:c.term,intentRevision:counter('intent-revision',inserted.rows[0].intent_revision),
            executionEpoch:b.executionEpoch,stepRevision:counter('step-revision','0'),podTarget:'EXISTING_POD',expectedPodUid:b.podUid},
          predecessor:{kind:'NONE'}})
        if (submitted.disposition !== 'ACCEPTED') { return null }
        const result=await claimCommand(gateway,originalIdentity(submitted.command),port.executorId)
        if(result.disposition!=='CLAIMED') { return null }
        await assertProviderCancelTarget(tx,{kind:'CANCEL',binding:b,commandClaim:result.claim,
          messageId:target.identity.messageId,deliveryAttemptId:target.identity.deliveryAttemptId,
          nativeTurnId:intent.target_provider_turn_ref},commandInput)
        return result.claim
      })
      if (!claim) { continue }
      current()
      let result
      try { result=await port.cancel(context,target,claim,async () => { current() }) }
      catch (error) {
        // Preserve a bounded internal refusal code; never expose provider text or credentials.
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null
        report(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : 'CANCEL_PROVIDER_UNCONFIRMED')
        result=undefined
      }
      const settled=await runDurableTransaction(pool,async tx=>{
        await lockAggregates(tx,{sessionIds:[b.sessionId],runtimeUnitIds:[b.runtimeUnitId]})
        const gateway=await LockedGatewayAuthority.acquire(tx,context)
        if (!result || result.state==='UNCONFIRMED') {
          await markCommandUnknown(gateway,claim)
          // Provider ACK/requested is not stop proof. Original observations may
          // later confirm this intent; this executor never promotes it itself.
          await tx.query("UPDATE durable_runtime.cancel_intents SET interrupt_status='UNKNOWN',updated_at=clock_timestamp() WHERE operation_id=$1 AND interrupt_status='REQUESTED'",[intent.operation_id])
        } else {
          await settleOwnedExecution(gateway,claim,{state:'RESOLVED',result:{requested:result.requested,stopped:'OBSERVED'},
            evidenceRefs:[result.stopped.evidenceRef]})
        }
      })
      if (!settled.ok) { throw settled.error }
    }
  }
  const enqueue=(key: string, work:()=>Promise<void>)=>{
    if (closed || queued.has(key)) { return tail }
    queued.add(key)
    tail=tail.then(work).catch(error=>{ report(error && typeof error.code==='string' ? error.code : 'CANCEL_RUNTIME_UNCONFIRMED') })
      .finally(()=>{ queued.delete(key) })
    return tail
  }
  return Object.freeze({
    notify:(sessionId:string)=>{ if(!closed) { void enqueue(`session:${sessionId}`,()=>run(sessionId)) } },
    sweep:()=>enqueue('sweep',async()=>{
      if(closed) { return }
      const sessions=await pool.query<{session_id:string}>("SELECT DISTINCT session_id FROM durable_runtime.cancel_intents WHERE interrupt_status='REQUESTED'")
      for(const row of sessions.rows) { await run(row.session_id) }
    }),
    drain:()=>tail,
    close:()=>{closed=true}
  })
}
