import { randomUUID } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import { appendSessionEvent, enqueueOutbox, appendAudit } from '../journal/store.ts'
import type { CancelInputRequest, CancelInterruptStatus } from './cancel-types.ts'
import type { ObservedTurnTarget } from './observed-turn-target.ts'

export type CancelMessageRow = { revision: string; intake_status: string }
export type CancelDeliveryRow = {
  id: string
  runtime_unit_id: string
  attempt_id: string
  execution_epoch: string
  provider_ref: string | null
}

export async function recordCancelIntent(
  tx: DurableTransaction,
  request: CancelInputRequest,
  unit: RuntimeUnitId | null,
  row: CancelMessageRow,
  effect: CancelDeliveryRow | undefined,
  possible: boolean,
  interrupt: CancelInterruptStatus,
  observed?: ObservedTurnTarget
) {
  const operationId = logicalId('operation', randomUUID()) // Genuine cancel intent identity; not a wake/controller operation.
  const changed = await tx.query<{
    cancel_revision: string
    cancel_requested_at: Date
    revision: string
  }>(
    `UPDATE durable_runtime.messages SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),
   cancel_revision=cancel_revision+1,revision=revision+1,merge_closed=true,
   intake_status=CASE WHEN NOT $2::boolean AND intake_status IN ('DURABLE','DISPATCH_INTENT','STAGED') THEN 'CANCELLED' ELSE intake_status END
   WHERE id=$1 RETURNING cancel_revision,cancel_requested_at,revision`,
    [request.targetMessageId, possible]
  )
  if (!possible) {
    await tx.query(
      "UPDATE durable_runtime.delivery_attempts SET state='CANCELLED' WHERE message_id=$1 AND state IN ('DISPATCH_INTENT','STAGED')",
      [request.targetMessageId]
    )
  }
  const cancellation = changed.rows[0]
  const intent = await tx.query<{ requested_at: Date }>(
    `INSERT INTO durable_runtime.cancel_intents
  (operation_id,session_id,target_message_id,target_message_revision,target_runtime_unit_id,target_attempt_id,
   target_execution_epoch,target_provider_turn_ref,requested_by,requested_at,cancel_revision,interrupt_status,updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp(),$10,$11,clock_timestamp()) RETURNING requested_at`,
    [
      operationId,
      request.authority.sessionId,
      request.targetMessageId,
      row.revision,
      effect?.runtime_unit_id ?? null,
      effect?.attempt_id ?? null,
      effect?.execution_epoch ?? null,
      effect?.provider_ref ?? null,
      request.authority.principal,
      cancellation.cancel_revision,
      interrupt
    ]
  )
  const context = await tx.query<{ context_revision: string }>(
    'UPDATE durable_runtime.sessions SET context_revision=context_revision+1 WHERE id=$1 RETURNING context_revision',
    [request.authority.sessionId]
  )
  const contextRevision = context.rows[0].context_revision
  const facts: JsonValue = {
    kind: 'CANCEL_INTENT',
    operationId,
    targetMessageId: request.targetMessageId,
    targetMessageRevision: row.revision,
    cancelRevision: cancellation.cancel_revision,
    interruptStatus: interrupt,
    preEffect: !possible,
    fixedDelivery: effect
      ? {
          deliveryAttemptId: effect.id,
          runtimeUnitId: effect.runtime_unit_id,
          attemptId: effect.attempt_id,
          executionEpoch: effect.execution_epoch,
          providerTurnRef: effect.provider_ref,
          ...(observed ? {
            provider: observed.provider, nativeSessionRef: observed.nativeSessionRef,
            nativeTurnId: observed.nativeTurnId, podUid: observed.podUid
          } : {})
        }
      : null,
    ...(observed ? {
      observedTurnProvenance: observed.provenance.map((entry) => ({ ...entry }))
    } : {})
  }
  await tx.query(
    `INSERT INTO durable_runtime.session_context_records
  (id,session_id,revision,kind,target_message_id,body_ref) VALUES ($1,$2,$3,'CANCEL_INTENT',$4,$5)`,
    [
      randomUUID(),
      request.authority.sessionId,
      contextRevision,
      request.targetMessageId,
      JSON.stringify(facts)
    ]
  )
  const event = await appendSessionEvent(tx, {
    sessionId: request.authority.sessionId,
    source: {
      kind: 'PRODUCER',
      sourceKind: 'CANCEL_INTENT',
      producerId: operationId,
      incarnation: 'durable-cancel-v1',
      producerSeq: counter('sequence:producer', '1')
    },
    body: facts
  })
  await appendAudit(tx, {
    actorId: request.authority.principal,
    sessionId: request.authority.sessionId,
    runtimeUnitId: unit,
    kind: 'CANCEL_INTENT',
    previousState: { messageState: row.intake_status },
    nextState: facts,
    occurredAt: intent.rows[0].requested_at,
    receivedAt: intent.rows[0].requested_at,
    producerId: operationId,
    producerSeq: counter('sequence:producer', '1'),
    evidenceRefs: []
  })
  if (interrupt === 'REQUESTED' && effect) {
    await enqueueOutbox(tx, {
      eventId: event.eventId,
      aggregateId: request.authority.sessionId,
      aggregateKind: 'session',
      revision: counter('row:session-context', contextRevision),
      event: { ...facts, kind: 'INTERRUPT_FIXED_DELIVERY' }
    })
  }
  // No desired mode/intent revision/activity update or provider I/O.
  return {
    result: {
      operationId,
      targetMessageId: request.targetMessageId,
      targetMessageRevision: row.revision,
      cancelRevision: cancellation.cancel_revision,
      interruptStatus: interrupt,
      contextRevision
    },
    event
  }
}

