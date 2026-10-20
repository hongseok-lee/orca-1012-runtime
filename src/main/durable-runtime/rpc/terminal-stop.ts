import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import type { resolveCatalogTerminalTarget } from './terminal-target.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { runDurableMutation, resolveReceipt } from '../db/atomic.ts'
import { inputPayloadHash } from '../input/canonical.ts'
import { discoverInputUnit, assertNewInputState } from '../input/authority.ts'
import { recordInputCancel, recordObservedTurnCancel } from '../input/cancel.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { TerminalDraftStoreError } from '../terminal/durable-contracts.ts'
import { assertManagedCatalogTarget } from '../terminal/catalog-target.ts'
import type { InputAuthority } from '../input/types.ts'

/** Legacy ESC has no gesture/turn ID. The first unambiguous target is sticky
 * for this authenticated connection+handle. Repeated/late ESC only observes
 * that receipt; callers need structured cancel for a different explicit turn. */
export async function stopCatalogTerminal(config: CapturedCatalogReadConfig, context: RpcContext, terminal: string,
  target: NonNullable<Awaited<ReturnType<typeof resolveCatalogTerminalTarget>>>, assertCurrent: () => void,
  notify?: (sessionId: string) => void, resolveOnly = false) {
  const connection=context.terminalInputConnection
  assertCurrent()
  if(!connection || !context.authenticatedCallerFingerprint || !context.pairedDeviceId) {
    throw new TerminalDraftStoreError('TERMINAL_AUTHENTICATED_CONNECTION_REQUIRED')
  }
  const principal=fingerprintAttachmentPrincipal(context.authenticatedCallerFingerprint)
  const authority:InputAuthority={principal,sessionId:target.sessionId,scope:{kind:'TERMINAL',terminalHandle:terminal}}
  const unit=await discoverInputUnit(config.pool,authority)
  const operationKey=JSON.stringify(['LEGACY_STOP',connection.connectionIncarnation,terminal])
  const identity={
    key:{principalId:principal,sessionScope:JSON.stringify(['terminal-stop',target.sessionId,terminal]),method:'terminal.stop',operationKey},
    payloadHash:inputPayloadHash({version:1,connection:connection.connectionIncarnation,terminal}),
  }
  if(resolveOnly && (await resolveReceipt(config.pool,identity)).status!=='FOUND') {
    throw new TerminalDraftStoreError('TERMINAL_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY')
  }
  const outcome=await runDurableMutation(config.pool,{...identity,
    locks:{sessionIds:[target.sessionId],runtimeUnitIds:unit?[unit]:[]}
  },async tx=>{
    assertCurrent(); connection.assertCurrent()
    const currentUnit=await assertNewInputState(tx,authority,target.sessionFence,unit)
    await assertManagedCatalogTarget(tx,target.targetPin,{logicalHandle:terminal,sessionId:target.sessionId,
      pairedDeviceId:context.pairedDeviceId!,principalId:principal,connectionId:connection.connectionIncarnation,
      floorGeneration:'0',mode:'AGENT_CHAT_COMPAT'})
    const candidates=await tx.query<{id:string;intake_status:string}>(`SELECT id,intake_status FROM durable_runtime.messages
      WHERE session_id=$1 AND intake_status IN ('DURABLE','DISPATCH_INTENT','STAGED','EFFECT_POSSIBLE','ADMITTED','UNKNOWN')
      AND cancel_revision=0 ORDER BY accepted_at,id FOR UPDATE`,[target.sessionId])
    const running=candidates.rows.filter(row=>['EFFECT_POSSIBLE','ADMITTED','UNKNOWN'].includes(row.intake_status))
    const selected=running.length ? running : candidates.rows
    if(selected.length!==1) { throw new TerminalDraftStoreError('TERMINAL_STOP_TARGET_AMBIGUOUS') }
    const messageId=logicalId('message',selected[0].id)
    const originalPayload={terminal,targetMessageId:messageId,connection:connection.connectionIncarnation}
    if(!running.length) {
      return recordInputCancel(tx,{authority,method:'terminal.stop',operationKey,targetMessageId:messageId,originalPayload},currentUnit)
    }
    // Native turn identity must come from the original immutable admission;
    // display text and current provider status are not cancellation authority.
    const turns=await tx.query<{turn_id:string}>(`SELECT DISTINCT body_ref->'observation'->>'nativeTurnId' AS turn_id
      FROM durable_runtime.session_context_records WHERE session_id=$1 AND target_message_id=$2 AND kind='INPUT_ADMITTED'
        AND body_ref->>'classification'='ORIGINAL_EXECUTION'`,[target.sessionId,messageId])
    if(turns.rows.length!==1 || !turns.rows[0].turn_id || !['codex','claude'].includes(target.targetPin.provider??'')) {
      throw new TerminalDraftStoreError('TERMINAL_STOP_OBSERVED_TARGET_REQUIRED')
    }
    const result=await recordObservedTurnCancel(tx,{authority,provider:target.targetPin.provider as 'codex'|'claude',
      nativeTurnId:turns.rows[0].turn_id,method:'terminal.stop',operationKey,originalPayload},currentUnit)
    return {operationId:result.operationId,targetMessageId:result.target.messageId,interruptStatus:result.interruptStatus}
  })
  if(outcome.status==='UNCERTAIN') { throw new TerminalDraftStoreError('TERMINAL_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY') }
  assertCurrent()
  try { notify?.(target.sessionId) } catch { /* committed cancel intent remains recoverable */ }
  return {send:{handle:terminal,accepted:true,bytesWritten:0}}
}
