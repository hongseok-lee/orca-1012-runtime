import { randomUUID } from 'node:crypto'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { lockAggregates } from '../db/locks.ts'
import type { DurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import { InputStoreError } from './types.ts'
import { sealInputMessageInTransaction } from './seal.ts'
import { stageInputInTransaction } from './stage.ts'
import { claimInputEffectInTransaction } from './effect-claim.ts'
import { commandObject, readInputExecutionTarget } from './stage-binding.ts'
import { LockedGatewayAuthority, currentAuthoritySql } from '../runtime/gateway/authority.ts'
import { submitCommand, originalIdentity } from '../runtime/gateway/store.ts'
import { inputDigest } from '../runtime/gateway/input.ts'
import type { SubmitCommand, GatewayContext } from '../runtime/gateway/types.ts'
import type { CommandEnvelope } from '../runtime/command-types.ts'
import type { PayloadHash } from '../runtime/runtime-evidence.ts'
import type { CommittedTerminalInput, ReadyTerminalInputPort } from './runtime-input-types.ts'

function required(row: Record<string, JsonValue>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || !value) { throw new InputStoreError('TERMINAL_RUNTIME_RECEIPT') }
  return value
}

export function committedInputTarget(input: CommittedTerminalInput) {
  const response = commandObject(input.receipt.response)
  if (response.version !== 1 || response.kind !== 'SUBMITTED' || response.terminalHandle !== input.binding.logicalHandle) {
    throw new InputStoreError('TERMINAL_RUNTIME_RECEIPT')
  }
  const accepted = commandObject(response.input)
  return Object.freeze({inputId: logicalId('input', required(accepted, 'inputId')),
    messageId: logicalId('message', required(accepted, 'messageId')),
    messageRevision: counter('message-revision', required(accepted, 'messageRevision')),
    runtimeUnitId: logicalId('runtime-unit', required(accepted, 'runtimeUnitId')),
    intentRevision: counter('intent-revision', required(accepted, 'intentRevision'))})
}

/** SQL-only fence, also supplied to the real protected permit transaction. */
export async function assertTerminalExecutionOrigin(tx: DurableTransaction, input: CommittedTerminalInput) {
  const key = input.receipt.key, target = committedInputTarget(input)
  const found = await tx.query(`SELECT i.id FROM durable_runtime.rpc_receipts r
    JOIN durable_runtime.input_components i ON i.id=$8 AND i.message_id=$9 AND i.session_id=$10
    JOIN durable_runtime.sessions s ON s.id=i.session_id
    JOIN durable_runtime.tabs t ON t.id=$11 AND t.session_id=s.id AND t.terminal_handle=$12
    JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id
    WHERE r.principal_id=$1 AND r.session_scope=$2 AND r.method=$3 AND r.operation_key=$4
      AND r.payload_hash=$5 AND r.response=$6::jsonb
      AND i.authenticated_sender=$7 AND i.client_operation_id=$4
      AND s.lifecycle='OPEN' AND s.session_fence=$13 AND t.lifecycle='OPEN' AND m.binding_revision=$14
    FOR SHARE OF t,m`,
  [key.principalId, key.sessionScope, key.method, key.operationKey, input.receipt.payloadHash,
    input.receipt.response, input.authority.principal, target.inputId, target.messageId, input.authority.sessionId,
    input.targetPin.tabId, input.binding.logicalHandle, input.sessionFence, input.targetPin.bindingRevision])
  if (found.rowCount !== 1) { throw new InputStoreError('TERMINAL_RUNTIME_RECEIPT') }
}

function command(envelope: CommandEnvelope, name: 'stageInput' | 'dispatchInput', input: JsonValue): SubmitCommand {
  return {command: name, envelope, input, inputHash: inputDigest(input) as PayloadHash, predecessor: {kind: 'NONE'}}
}

/** New operation and original stage share one COMMIT. Existing stage is lookup only;
 * no restart/receipt replay grants a second native effect. */
export async function stageTerminalRuntimeInput(tx: DurableTransaction, input: CommittedTerminalInput, ready: ReadyTerminalInputPort) {
  const target = committedInputTarget(input), binding = ready.binding
  await lockAggregates(tx, {sessionIds: [input.authority.sessionId], runtimeUnitIds: [target.runtimeUnitId]})
  await assertTerminalExecutionOrigin(tx, input)
  if (binding.sessionId !== input.authority.sessionId || binding.terminalHandle !== input.binding.logicalHandle ||
      binding.tabId !== input.targetPin.tabId ||
      binding.runtimeUnitId !== target.runtimeUnitId || ready.context.runtimeUnitId !== target.runtimeUnitId ||
      (binding.providerRef.provider !== 'codex' && binding.providerRef.provider !== 'claude')) { throw new InputStoreError('TERMINAL_RUNTIME_READY_TARGET') }
  const prior = await tx.query(`SELECT c.id FROM durable_runtime.runtime_commands c
    JOIN durable_runtime.delivery_attempts d ON d.id::text=c.input->>'deliveryAttemptId'
    WHERE c.command_name='stageInput' AND c.input->>'messageId'=$1 AND d.session_id=$2`,
  [target.messageId, input.authority.sessionId])
  if (prior.rows.length > 1) { throw new InputStoreError('TERMINAL_RUNTIME_STAGE_AMBIGUOUS') }
  if (prior.rows.length === 1) { return {disposition: 'LOOKUP_ONLY' as const} }
  const runtime = await readInputExecutionTarget(tx, input.authority, target.runtimeUnitId)
  if (runtime.lifecycle !== 'OPEN' || runtime.phase !== 'READY' || runtime.desired_mode !== 'RUNNING' ||
      runtime.active_attempt_id !== binding.attemptId || runtime.pod_uid !== binding.podUid ||
      runtime.execution_epoch !== binding.executionEpoch || runtime.provider_binding_revision !== binding.providerBindingRevision) {
    throw new InputStoreError('TERMINAL_RUNTIME_READY_TARGET')
  }
  // First live integration is text-only. Preserve unresolved inputs instead of
  // silently dropping an attachment whose materializer is not connected here.
  const attachment = await tx.query(`SELECT a.input_id FROM durable_runtime.input_attachments a
    JOIN durable_runtime.input_components i ON i.id=a.input_id WHERE i.message_id=$1 LIMIT 1`, [target.messageId])
  if (attachment.rowCount) { throw new InputStoreError('TERMINAL_RUNTIME_ATTACHMENTS_NOT_CONNECTED') }
  const pending = (await tx.query<{revision: string; intake_status: string; cancel_revision: string}>(
    'SELECT revision,intake_status,cancel_revision FROM durable_runtime.messages WHERE id=$1 AND session_id=$2 FOR UPDATE',
    [target.messageId, input.authority.sessionId])).rows[0]
  if (!pending || pending.intake_status !== 'DURABLE' || pending.cancel_revision !== '0') {
    throw new InputStoreError('TERMINAL_RUNTIME_MESSAGE_NOT_PENDING')
  }
  // The receipt identifies its original Component/Message, not a forever-current
  // seal revision. Include every accepted Component of this locked Message.
  const pendingRevision = counter('message-revision', pending.revision)
  const operationId = logicalId('operation', randomUUID()), deliveryAttemptId = logicalId('delivery-attempt', randomUUID())
  const controller = ready.context.controller
  // The unit may have been fenced and woken again since this input was accepted
  // (its intent advanced); the input still goes to the current READY attempt
  // as long as the unit runs. A reset Session is refused by its session fence.
  const inserted = await tx.query<{ intent_revision: string }>(`INSERT INTO durable_runtime.operations
    (id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,step_revision,expected_pod_uid,execution_epoch)
    SELECT $4,$5,'INPUT_DELIVERY',u.intent_revision,$1,$3,'INPUT',0,$6,$7 FROM durable_runtime.runtime_units u
    JOIN durable_runtime.operations original ON original.id=$8 AND original.runtime_unit_id=u.id
    WHERE u.id=$5 AND u.intent_revision>=$9 AND u.desired_mode='RUNNING' AND u.execution_epoch=$7 AND u.active_attempt_id=$10
      AND original.controller_scope=$1 AND original.controller_term=$3 AND ${currentAuthoritySql} RETURNING intent_revision::text`,
  [controller.scope, controller.owner, controller.term, operationId, target.runtimeUnitId, binding.podUid,
    binding.executionEpoch, ready.context.operationId, target.intentRevision, binding.attemptId])
  if (inserted.rowCount !== 1) { throw new InputStoreError('TERMINAL_RUNTIME_OWNER_STALE') }
  const context: GatewayContext = Object.freeze({runtimeUnitId: target.runtimeUnitId, operationId, controller})
  const envelope: CommandEnvelope = Object.freeze({operationId, controllerTerm: controller.term,
    stepRevision: counter('step-revision', '0'), executionEpoch: binding.executionEpoch,
    intentRevision: counter('intent-revision', inserted.rows[0].intent_revision), podTarget: 'EXISTING_POD', expectedPodUid: binding.podUid})
  const sealed = await sealInputMessageInTransaction(tx, {authority: input.authority,
    messageId: target.messageId, expectedRevision: pendingRevision})
  const stage = command(envelope, 'stageInput', {messageId: target.messageId, sealedRevision: sealed.sealedRevision,
    payloadHash: sealed.payloadHash, deliveryAttemptId, contextRevision: runtime.context_revision,
    bodyRef: `input-component:${target.inputId}`})
  await stageInputInTransaction(tx, input.authority, context, stage, ready.executorId)
  return {disposition: 'STAGED' as const, context, envelope, sealed, deliveryAttemptId}
}

export async function claimTerminalRuntimeInput(tx: DurableTransaction, input: CommittedTerminalInput,
  ready: ReadyTerminalInputPort, staged: Extract<Awaited<ReturnType<typeof stageTerminalRuntimeInput>>, {disposition: 'STAGED'}>) {
  await lockAggregates(tx, {sessionIds: [input.authority.sessionId], runtimeUnitIds: [staged.context.runtimeUnitId]})
  await assertTerminalExecutionOrigin(tx, input)
  const authority = await LockedGatewayAuthority.acquire(tx, staged.context)
  const submitted = await submitCommand(authority, command(staged.envelope, 'dispatchInput', {
    messageId: staged.sealed.messageId, deliveryAttemptId: staged.deliveryAttemptId}))
  if (submitted.disposition !== 'ACCEPTED') { return null }
  const claim = await claimInputEffectInTransaction(tx, input.authority, staged.context, originalIdentity(submitted.command), ready.executorId)
  if (claim.disposition !== 'CLAIMED') { return null }
  return Object.freeze({sealed: staged.sealed, deliveryAttemptId: staged.deliveryAttemptId,
    context: claim.contextFrame, attachments: Object.freeze([]), commandClaim: claim.commandClaim})
}
