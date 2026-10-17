import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { SessionId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, runDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { appendAudit, appendSessionEvent, enqueueOutbox } from '../journal/store.ts'
import { LockedGatewayAuthority, currentAuthoritySql } from '../runtime/gateway/authority.ts'
import { appendHistory, assertOriginal, originalIdentity, takeOverCommand } from '../runtime/gateway/store.ts'
import type { CommandRow } from '../runtime/gateway/types.ts'
import { commandObject, originalStageForDelivery, stageBinding } from './stage-binding.ts'
import type { InputOwnerLossRecord, InputOwnerLossRequest, InputOwnerLossResult } from './owner-loss-types.ts'

export type { InputOwnerLossRecord, InputOwnerLossRequest, InputOwnerLossResult } from './owner-loss-types.ts'
const reasonCode = 'INPUT_OWNER_LOST'
function deny(code: string): never { throw new DurableDatabaseError(`INPUT_OWNER_LOSS_${code}`) }
function text(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) { deny('SELECTOR') }
  return value
}
function capture(original: InputOwnerLossRequest): InputOwnerLossRequest {
  try {
    const context = original.context, controller = context.controller
    return Object.freeze({
      context: Object.freeze({ runtimeUnitId: logicalId('runtime-unit', context.runtimeUnitId),
        operationId: logicalId('operation', context.operationId), controller: Object.freeze({ ...controller,
          scope: text(controller.scope), owner: text(controller.owner), term: counter('controller-term', controller.term) }) }),
      commandId: logicalId('runtime-command', original.commandId),
      executionToken: logicalId('runtime-command-execution', original.executionToken),
      messageId: logicalId('message', original.messageId), deliveryAttemptId: logicalId('delivery-attempt', original.deliveryAttemptId)
    })
  } catch { return deny('SELECTOR') }
}
type Target = {
  session_id: SessionId; lifecycle: string; context_revision: string
  message_state: string; message_revision: string; cancel_revision: string
  cancel_requested_at: Date | null; sealed_revision: string | null; sealed_payload_hash: string | null
  delivery_state: string; attempt_id: string; execution_epoch: string; pod_uid: string | null
  operation_kind: string; operation_result: unknown; operation_epoch: string; operation_intent: string
  operation_pod: string | null
}

/** Logical UNKNOWN preservation under an actual current HA lease. No provider
 * proof, execution claim, retry, wake, grant or physical-stop authority is issued. */
export async function reconcileInputAfterOwnerLoss(pool: Pool, original: InputOwnerLossRequest): Promise<InputOwnerLossResult> {
  const request = capture(original), connect = pool.connect.bind(pool)
  const borrowed: Pool = Object.create(pool, { connect: { value: connect } })
  const { context } = request
  return runDurableTransaction(borrowed, async tx => {
    const mapping = await tx.query<{ session_id: SessionId }>(
      `SELECT d.session_id FROM durable_runtime.delivery_attempts d
       JOIN durable_runtime.messages m ON m.id=d.message_id AND m.session_id=d.session_id
       WHERE d.id=$1 AND d.message_id=$2 AND d.runtime_unit_id=$3`,
      [request.deliveryAttemptId, request.messageId, context.runtimeUnitId])
    if (mapping.rowCount !== 1) { return deny('MAPPING') }
    const sessionId = logicalId('session', mapping.rows[0].session_id)
    await lockAggregates(tx, { sessionIds: [sessionId], runtimeUnitIds: [context.runtimeUnitId], operationIds: [context.operationId] })
    const authority = await LockedGatewayAuthority.acquire(tx, context)
    const commands = await tx.query<CommandRow>(
      'SELECT * FROM durable_runtime.runtime_commands WHERE id=$1 AND runtime_unit_id=$2 AND operation_id=$3 FOR UPDATE',
      [request.commandId, context.runtimeUnitId, context.operationId])
    const command = commands.rows[0]
    if (!command || command.command_name !== 'dispatchInput' || command.pod_target !== 'EXISTING_POD' ||
        !command.expected_pod_uid || command.execution_token !== request.executionToken || !command.executor_id) { return deny('COMMAND') }
    assertOriginal(command, originalIdentity(command))
    const input = commandObject(command.input)
    if (Object.keys(input).sort().join(',') !== 'deliveryAttemptId,messageId' ||
        input.messageId !== request.messageId || input.deliveryAttemptId !== request.deliveryAttemptId) { return deny('PAYLOAD') }
    const history = await tx.query<{ controller_term: string }>(
      `SELECT controller_term FROM durable_runtime.runtime_command_history
       WHERE command_id=$1 AND stage='EXECUTING' AND execution_token=$2 AND executor_id=$3`,
      [command.id, request.executionToken, command.executor_id])
    if (history.rowCount !== 1 || !/^(0|[1-9][0-9]*)$/.test(history.rows[0].controller_term) ||
        BigInt(history.rows[0].controller_term) < BigInt(command.original_controller_term) ||
        BigInt(history.rows[0].controller_term) > BigInt(command.owner_controller_term) ||
        BigInt(history.rows[0].controller_term) >= BigInt(context.controller.term)) { return deny('EXECUTION_HISTORY') }
    const executionTerm = history.rows[0].controller_term
    const targets = await tx.query<Target>(
      `SELECT d.session_id,s.lifecycle,s.context_revision,m.intake_status AS message_state,m.revision AS message_revision,
       m.cancel_revision,m.cancel_requested_at,m.sealed_revision,m.sealed_payload_hash,d.state AS delivery_state,
       d.attempt_id,d.execution_epoch,a.pod_uid,o.kind AS operation_kind,o.result AS operation_result,
       o.execution_epoch AS operation_epoch,o.intent_revision AS operation_intent,o.expected_pod_uid AS operation_pod
       FROM durable_runtime.delivery_attempts d JOIN durable_runtime.messages m ON m.id=d.message_id AND m.session_id=d.session_id
       JOIN durable_runtime.sessions s ON s.id=d.session_id
       JOIN durable_runtime.runtime_members member ON member.session_id=s.id AND member.runtime_unit_id=d.runtime_unit_id
       JOIN durable_runtime.attempts a ON a.id=d.attempt_id AND a.runtime_unit_id=d.runtime_unit_id AND a.execution_epoch=d.execution_epoch
       JOIN durable_runtime.operations o ON o.id=$5 AND o.runtime_unit_id=d.runtime_unit_id
       WHERE d.id=$1 AND d.message_id=$2 AND d.session_id=$3 AND d.runtime_unit_id=$4 FOR UPDATE OF d,m`,
      [request.deliveryAttemptId, request.messageId, sessionId, context.runtimeUnitId, context.operationId])
    const target = targets.rows[0]
    if (targets.rowCount !== 1 || !target ||
        target.operation_kind !== 'INPUT_DELIVERY' || target.execution_epoch !== command.execution_epoch ||
        target.operation_epoch !== command.execution_epoch || target.operation_intent !== command.intent_revision ||
        target.pod_uid !== command.expected_pod_uid || target.operation_pod !== command.expected_pod_uid) { return deny('LINEAGE') }
    const stage = await originalStageForDelivery(tx, request.deliveryAttemptId)
    if (!stage || stage.state !== 'RESOLVED' || commandObject(stage.result).receipt !== 'STAGED') { return deny('STAGE') }
    const binding = stageBinding(stage.input)
    if (binding.messageId !== request.messageId || binding.deliveryAttemptId !== request.deliveryAttemptId ||
        stage.runtime_unit_id !== context.runtimeUnitId || stage.execution_epoch !== command.execution_epoch ||
        stage.expected_pod_uid !== command.expected_pod_uid || target.sealed_revision !== binding.sealedRevision ||
        target.sealed_payload_hash !== binding.payloadHash || BigInt(target.context_revision) < BigInt(binding.contextRevision)) { return deny('STAGE_BINDING') }
    const result = (disposition: InputOwnerLossRecord['disposition'], eventId: InputOwnerLossRecord['eventId'] = null): InputOwnerLossRecord =>
      Object.freeze({ disposition, sessionId, commandId: request.commandId, messageId: request.messageId,
        deliveryAttemptId: request.deliveryAttemptId, eventId })
    const evidenceRef = `input-owner-loss:sha256:${createHash('sha256').update(command.id).digest('hex')}`
    const previous = await tx.query<{ event_id: string; matches: boolean }>(
      `SELECT event_id,body->>'reasonCode'=$4 AND body->>'commandId'=$5 AND body->>'executionControllerTerm'=$6 AS matches
       FROM durable_runtime.session_events WHERE session_id=$1 AND body->>'kind'='INPUT_OBSERVATION'
       AND body->>'state'='UNKNOWN' AND body->>'deliveryAttemptId'=$2 AND body->>'messageId'=$3
       AND body->>'evidenceRef'=$7`,
      [sessionId, request.deliveryAttemptId, request.messageId, reasonCode, command.id, executionTerm, evidenceRef])
    if (target.lifecycle !== 'OPEN' || target.cancel_revision !== '0' || target.cancel_requested_at !== null ||
        !['EXECUTING', 'UNKNOWN'].includes(command.state) || target.operation_result !== null) { return result('NOT_APPLICABLE') }
    if (target.message_state === 'UNKNOWN' && target.delivery_state === 'UNKNOWN' && command.state === 'UNKNOWN') {
      if (previous.rowCount === 1 && previous.rows[0].matches) { return result('ALREADY_UNKNOWN', logicalId('event', previous.rows[0].event_id)) }
      return result('NOT_APPLICABLE')
    }
    if (target.message_state !== 'EFFECT_POSSIBLE' || target.delivery_state !== 'EFFECT_POSSIBLE') { return result('NOT_APPLICABLE') }
    if (previous.rowCount) { return deny('EXISTING_EVENT') }
    await takeOverCommand(authority, originalIdentity(command))
    if (command.state === 'EXECUTING') {
      const changed = await tx.query<CommandRow>(
        `UPDATE durable_runtime.runtime_commands SET state='UNKNOWN',revision=revision+1
         WHERE id=$4 AND runtime_unit_id=$5 AND operation_id=$6 AND execution_token=$7 AND executor_id=$8
         AND owner_controller_term=$3 AND state='EXECUTING' AND ${currentAuthoritySql} RETURNING *`,
        [context.controller.scope, context.controller.owner, context.controller.term, command.id,
          context.runtimeUnitId, context.operationId, request.executionToken, command.executor_id])
      if (changed.rowCount !== 1) { return deny('COMMAND_CAS') }
      await appendHistory(authority, changed.rows[0], 'UNKNOWN')
    }
    const clock = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now
    const facts = { kind: 'INPUT_OBSERVATION', state: 'UNKNOWN', messageId: request.messageId,
      deliveryAttemptId: request.deliveryAttemptId, runtimeUnitId: context.runtimeUnitId, attemptId: target.attempt_id,
      executionEpoch: target.execution_epoch, podUid: target.pod_uid, evidenceRef, observedAt: clock.toISOString(),
      reasonCode, evidenceRefs: [], commandId: command.id, executionControllerTerm: executionTerm,
      authorityKind: 'CONTROLLER_OWNER_LOSS' }
    const message = await tx.query<{ revision: string }>(
      `UPDATE durable_runtime.messages SET intake_status='UNKNOWN',revision=revision+1
       WHERE id=$4 AND session_id=$5 AND intake_status='EFFECT_POSSIBLE' AND cancel_revision=0
       AND ${currentAuthoritySql} RETURNING revision`,
      [context.controller.scope, context.controller.owner, context.controller.term, request.messageId, sessionId])
    const delivery = await tx.query(
      `UPDATE durable_runtime.delivery_attempts SET state='UNKNOWN',failure_reason=$5
       WHERE id=$4 AND state='EFFECT_POSSIBLE' AND ${currentAuthoritySql} RETURNING id`,
      [context.controller.scope, context.controller.owner, context.controller.term, request.deliveryAttemptId, reasonCode])
    if (message.rowCount !== 1 || delivery.rowCount !== 1) { return deny('INPUT_CAS') }
    const event = await appendSessionEvent(tx, { sessionId, source: { kind: 'NATIVE', sourceKind: 'INPUT_UNKNOWN',
      provider: 'platform', lineage: request.deliveryAttemptId, nativeId: evidenceRef }, body: facts })
    const revision = await tx.query<{ context_revision: string }>(
      'UPDATE durable_runtime.sessions SET context_revision=context_revision+1 WHERE id=$1 RETURNING context_revision', [sessionId])
    const body = { observation: facts, classification: 'ORIGINAL_EXECUTION', previousState: target.delivery_state }
    await tx.query(`INSERT INTO durable_runtime.session_context_records
      (id,session_id,revision,kind,target_message_id,body_ref) VALUES($1,$2,$3,'INPUT_UNKNOWN',$4,$5::jsonb)`,
      [event.eventId, sessionId, revision.rows[0].context_revision, request.messageId, JSON.stringify(body)])
    await appendAudit(tx, { actorId: context.controller.owner, sessionId, runtimeUnitId: context.runtimeUnitId,
      operationId: context.operationId, attemptId: logicalId('attempt', target.attempt_id), podUid: command.expected_pod_uid,
      kind: 'INPUT_UNKNOWN', previousState: { state: target.delivery_state }, nextState: body,
      occurredAt: clock, receivedAt: event.recordedAt, producerId: event.eventId,
      producerSeq: counter('sequence:producer', '1'), evidenceRefs: [evidenceRef] })
    await enqueueOutbox(tx, { eventId: event.eventId, aggregateId: request.messageId, aggregateKind: 'input',
      revision: counter('row:message', message.rows[0].revision), event: facts })
    await authority.assertCurrent()
    return result('UNKNOWN_RECORDED', event.eventId)
  })
}
