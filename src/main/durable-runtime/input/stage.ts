import type { DurableTransaction } from '../db/connection.ts'
import type { InputAuthority } from './types.ts'
import { InputStoreError } from './types.ts'
import { assertInputScope } from './authority.ts'
import { requireInputSessionLock } from './composition.ts'
import { sealInputMessageInTransaction } from './seal.ts'
import { LockedGatewayAuthority } from '../runtime/gateway/authority.ts'
import { submitCommand, originalIdentity, assertOriginal } from '../runtime/gateway/store.ts'
import { claimCommand, settleOwnedExecution } from '../runtime/gateway/claim.ts'
import { canonicalInput } from '../runtime/gateway/input.ts'
import type { GatewayContext, SubmitCommand, ExecutorId } from '../runtime/gateway/types.ts'
import {
  stageBinding,
  originalStageForDelivery,
  sameStageInput,
  readInputExecutionTarget,
  commandObject
} from './stage-binding.ts'

/** Internal DB staging only. Every helper failure must unwind the owning P1-03 transaction. */
export async function stageInputInTransaction(
  tx: DurableTransaction,
  scope: InputAuthority,
  context: GatewayContext,
  request: SubmitCommand,
  executorId: ExecutorId
) {
  scope = { ...scope, scope: { ...scope.scope } }
  context = { ...context, controller: { ...context.controller } }
  requireInputSessionLock(tx, scope.sessionId)
  await assertInputScope(tx, scope)
  request = {
    ...request,
    envelope: { ...request.envelope },
    input: JSON.parse(canonicalInput(request.input))
  }
  if (request.command !== 'stageInput' || request.envelope.podTarget !== 'EXISTING_POD') {
    throw new InputStoreError('INPUT_STAGE_COMMAND')
  }
  const binding = stageBinding(request.input)
  const authority = await LockedGatewayAuthority.acquire(tx, context)
  const prior = await originalStageForDelivery(tx, binding.deliveryAttemptId)
  if (prior) {
    assertOriginal(prior, {
      command: request.command,
      originalEnvelope: request.envelope,
      inputHash: request.inputHash
    })
    if (
      prior.runtime_unit_id !== context.runtimeUnitId ||
      !sameStageInput(prior.input, request.input)
    ) {
      throw new InputStoreError('INPUT_STAGE_BINDING_CONFLICT')
    }
    if (prior.state !== 'RESOLVED' || commandObject(prior.result).receipt !== 'STAGED') {
      throw new InputStoreError('INPUT_STAGE_UNRESOLVED')
    }
    const delivery = await tx.query(
      'SELECT id FROM durable_runtime.delivery_attempts WHERE id=$1 AND session_id=$2 AND message_id=$3 AND runtime_unit_id=$4 AND execution_epoch=$5',
      [
        binding.deliveryAttemptId,
        scope.sessionId,
        binding.messageId,
        context.runtimeUnitId,
        request.envelope.executionEpoch
      ]
    )
    if (delivery.rowCount !== 1) {
      throw new InputStoreError('INPUT_STAGE_BINDING_CONFLICT')
    }
    return {
      visibility: 'TRANSACTION_LOCAL' as const,
      disposition: 'REPLAYED' as const,
      deliveryAttemptId: binding.deliveryAttemptId
    }
  }
  const target = await readInputExecutionTarget(tx, scope, context.runtimeUnitId)
  if (
    target.lifecycle !== 'OPEN' ||
    target.desired_mode !== 'RUNNING' ||
    !target.active_attempt_id ||
    target.pod_uid !== request.envelope.expectedPodUid ||
    target.execution_epoch !== request.envelope.executionEpoch ||
    target.context_revision !== binding.contextRevision
  ) {
    throw new InputStoreError('INPUT_STAGE_TARGET_STALE')
  }
  const occupied = await tx.query('SELECT id FROM durable_runtime.delivery_attempts WHERE id=$1', [
    binding.deliveryAttemptId
  ])
  if (occupied.rowCount) {
    throw new InputStoreError('INPUT_STAGE_BINDING_CONFLICT')
  }
  const sealed = await sealInputMessageInTransaction(tx, {
    authority: scope,
    messageId: binding.messageId,
    expectedRevision: binding.sealedRevision
  })
  const pending = await tx.query(
    "SELECT id FROM durable_runtime.messages WHERE id=$1 AND cancel_revision=0 AND intake_status IN ('DISPATCH_INTENT','STAGED')",
    [binding.messageId]
  )
  if (pending.rowCount !== 1 || sealed.payloadHash !== binding.payloadHash) {
    throw new InputStoreError('INPUT_STAGE_MESSAGE_STALE')
  }
  const submitted = await submitCommand(authority, request)
  if (submitted.disposition !== 'ACCEPTED') {
    throw new InputStoreError('INPUT_STAGE_NOT_CLAIMABLE')
  }
  const claim = await claimCommand(authority, originalIdentity(submitted.command), executorId)
  if (claim.disposition !== 'CLAIMED') {
    throw new InputStoreError('INPUT_STAGE_NOT_CLAIMABLE')
  }
  await tx.query(
    `INSERT INTO durable_runtime.delivery_attempts
    (id,message_id,session_id,runtime_unit_id,attempt_id,execution_epoch,state) VALUES ($1,$2,$3,$4,$5,$6,'STAGED')`,
    [
      binding.deliveryAttemptId,
      binding.messageId,
      scope.sessionId,
      context.runtimeUnitId,
      target.active_attempt_id,
      target.execution_epoch
    ]
  )
  await tx.query("UPDATE durable_runtime.messages SET intake_status='STAGED' WHERE id=$1", [
    binding.messageId
  ])
  await settleOwnedExecution(authority, claim.claim, {
    state: 'RESOLVED',
    result: { receipt: 'STAGED' },
    evidenceRefs: []
  })
  return {
    visibility: 'TRANSACTION_LOCAL' as const,
    disposition: 'STAGED' as const,
    deliveryAttemptId: binding.deliveryAttemptId
  }
}
