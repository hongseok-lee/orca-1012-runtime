import type { DurableTransaction } from '../db/connection.ts'
import type { ExternalCommandIdentity } from '../runtime/command-types.ts'
import type { GatewayContext, ExecutorId } from '../runtime/gateway/types.ts'
import { LockedGatewayAuthority, currentAuthoritySql } from '../runtime/gateway/authority.ts'
import { claimCommand } from '../runtime/gateway/claim.ts'
import { lookupCommand } from '../runtime/gateway/store.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { assertInputScope } from './authority.ts'
import { requireInputSessionLock } from './composition.ts'
import {
  commandObject,
  originalStageForDelivery,
  stageBinding,
  readInputExecutionTarget
} from './stage-binding.ts'
import { readRecoveryContextFrame } from '../context/frame.ts'
import { InputStoreError, type InputAuthority } from './types.ts'

/** No caller may catch a partial-write error and commit this transaction. No I/O here. */
export async function claimInputEffectInTransaction(
  tx: DurableTransaction,
  scope: InputAuthority,
  context: GatewayContext,
  original: ExternalCommandIdentity,
  executorId: ExecutorId
) {
  requireInputSessionLock(tx, scope.sessionId)
  await assertInputScope(tx, scope)
  original = { ...original, originalEnvelope: { ...original.originalEnvelope } }
  if (
    original.command !== 'dispatchInput' ||
    original.originalEnvelope.podTarget !== 'EXISTING_POD'
  ) {
    throw new InputStoreError('INPUT_DISPATCH_COMMAND')
  }
  const authority = await LockedGatewayAuthority.acquire(tx, context)
  const command = await lookupCommand(authority, original)
  if (!command) {
    throw new InputStoreError('INPUT_DISPATCH_NOT_FOUND')
  }
  if (command.state !== 'ACCEPTED') {
    return { visibility: 'TRANSACTION_LOCAL' as const, disposition: 'NOT_CLAIMABLE' as const }
  }
  const input = commandObject(command.input)
  if (
    Object.keys(input).sort().join(',') !== 'deliveryAttemptId,messageId' ||
    typeof input.messageId !== 'string' ||
    typeof input.deliveryAttemptId !== 'string'
  ) {
    throw new InputStoreError('INPUT_COMMAND_PAYLOAD')
  }
  const messageId = logicalId('message', input.messageId)
  const deliveryId = logicalId('delivery-attempt', input.deliveryAttemptId)
  const stage = await originalStageForDelivery(tx, deliveryId)
  if (!stage || stage.state !== 'RESOLVED' || commandObject(stage.result).receipt !== 'STAGED') {
    throw new InputStoreError('INPUT_STAGE_UNRESOLVED')
  }
  const binding = stageBinding(stage.input)
  if (
    binding.messageId !== messageId ||
    stage.runtime_unit_id !== context.runtimeUnitId ||
    stage.execution_epoch !== original.originalEnvelope.executionEpoch ||
    stage.expected_pod_uid !== original.originalEnvelope.expectedPodUid
  ) {
    throw new InputStoreError('INPUT_STAGE_BINDING_CONFLICT')
  }
  const target = await readInputExecutionTarget(tx, scope, context.runtimeUnitId)
  if (
    target.lifecycle !== 'OPEN' ||
    target.desired_mode !== 'RUNNING' ||
    target.phase !== 'READY' ||
    target.context_revision !== binding.contextRevision ||
    target.execution_epoch !== stage.execution_epoch ||
    target.pod_uid !== stage.expected_pod_uid ||
    !target.active_attempt_id
  ) {
    throw new InputStoreError('INPUT_EFFECT_TARGET_STALE')
  }
  const delivery = await tx.query<{ attempt_id: string; execution_epoch: string; state: string }>(
    'SELECT attempt_id,execution_epoch,state FROM durable_runtime.delivery_attempts WHERE id=$1 AND session_id=$2 AND message_id=$3 AND runtime_unit_id=$4 FOR UPDATE',
    [deliveryId, scope.sessionId, messageId, context.runtimeUnitId]
  )
  const fixed = delivery.rows[0]
  if (
    !fixed ||
    fixed.state !== 'STAGED' ||
    fixed.attempt_id !== target.active_attempt_id ||
    fixed.execution_epoch !== target.execution_epoch
  ) {
    throw new InputStoreError('INPUT_DELIVERY_NOT_CLAIMABLE')
  }
  const active = await tx.query(
    "SELECT id FROM durable_runtime.execution_grants WHERE runtime_unit_id=$1 AND attempt_id=$2 AND execution_epoch=$3 AND state='ACTIVE'",
    [context.runtimeUnitId, fixed.attempt_id, fixed.execution_epoch]
  )
  if (active.rowCount !== 1) {
    throw new InputStoreError('INPUT_EXECUTION_GRANT_REQUIRED')
  }
  const pending = await tx.query(
    `SELECT id FROM durable_runtime.messages WHERE id=$1 AND session_id=$2
    AND intake_status IN ('DISPATCH_INTENT','STAGED') AND cancel_revision=0 AND sealed_revision=$3 AND sealed_payload_hash=$4 FOR UPDATE`,
    [messageId, scope.sessionId, binding.sealedRevision, binding.payloadHash]
  )
  if (pending.rowCount !== 1) {
    throw new InputStoreError('INPUT_MESSAGE_NOT_CLAIMABLE')
  }
  const frame = await readRecoveryContextFrame(tx, scope)
  const claimed = await claimCommand(authority, original, executorId)
  if (claimed.disposition !== 'CLAIMED') {
    return { visibility: 'TRANSACTION_LOCAL' as const, disposition: 'NOT_CLAIMABLE' as const }
  }
  const controller = context.controller
  const changed = await tx.query(
    `UPDATE durable_runtime.messages SET intake_status='EFFECT_POSSIBLE'
    WHERE id=$4 AND session_id=$5 AND cancel_revision=0 AND intake_status IN ('DISPATCH_INTENT','STAGED')
    AND sealed_revision=$6 AND sealed_payload_hash=$7
    AND EXISTS(SELECT 1 FROM durable_runtime.sessions s WHERE s.id=$5 AND s.lifecycle='OPEN' AND s.context_revision=$8)
    AND ${currentAuthoritySql} RETURNING id`,
    [
      controller.scope,
      controller.owner,
      controller.term,
      messageId,
      scope.sessionId,
      binding.sealedRevision,
      binding.payloadHash,
      binding.contextRevision
    ]
  )
  if (changed.rowCount !== 1) {
    throw new InputStoreError('INPUT_EFFECT_CAS_CONFLICT')
  }
  const effect = await tx.query(
    "UPDATE durable_runtime.delivery_attempts SET state='EFFECT_POSSIBLE',effect_possible_at=clock_timestamp() WHERE id=$1 AND state='STAGED' RETURNING id",
    [deliveryId]
  )
  if (effect.rowCount !== 1) {
    throw new InputStoreError('INPUT_EFFECT_CAS_CONFLICT')
  }
  return {
    visibility: 'TRANSACTION_LOCAL' as const,
    disposition: 'CLAIMED' as const,
    messageId,
    deliveryAttemptId: deliveryId,
    commandClaim: claimed.claim,
    sealedRevision: binding.sealedRevision,
    payloadHash: binding.payloadHash,
    bodyRef: binding.bodyRef,
    providerBindingRevision: target.provider_binding_revision,
    contextFrame: frame
  }
}
