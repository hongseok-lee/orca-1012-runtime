import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { runDurableMutation, type JsonValue, type MutationOutcome } from '../db/atomic.ts'
import { appendSessionEvent, enqueueOutbox, appendAudit } from '../journal/store.ts'
import { discoverInputUnit, assertInputScope } from './authority.ts'
import { canonicalInputJson, inputPayloadHash, inputScopeKey } from './canonical.ts'
import { InputStoreError } from './types.ts'
import type { CancelInputRequest, CancelInterruptStatus } from './cancel-types.ts'

/** Fixed Message intent, not current-screen/latest-turn inference or provider interrupt. */
export async function requestInputCancel(
  pool: Pool,
  request: CancelInputRequest
): Promise<MutationOutcome> {
  request = {
    ...request,
    authority: { ...request.authority, scope: { ...request.authority.scope } },
    originalPayload: JSON.parse(canonicalInputJson(request.originalPayload))
  }
  const scope = inputScopeKey(request.authority)
  logicalId('message', request.targetMessageId)
  const original: JsonValue = JSON.parse(
    canonicalInputJson({
      version: 1,
      method: request.method,
      operationKey: request.operationKey,
      sessionId: request.authority.sessionId,
      scope: JSON.parse(scope),
      targetMessageId: request.targetMessageId,
      payload: request.originalPayload
    })
  )
  const unit = await discoverInputUnit(pool, request.authority)
  return runDurableMutation(
    pool,
    {
      key: {
        principalId: request.authority.principal,
        sessionScope: scope,
        method: request.method,
        operationKey: request.operationKey
      },
      payloadHash: inputPayloadHash(original),
      locks: { sessionIds: [request.authority.sessionId], runtimeUnitIds: unit ? [unit] : [] }
    },
    async (tx) => {
      await assertInputScope(tx, request.authority)
      const membership = await tx.query<{ runtime_unit_id: string }>(
        'SELECT runtime_unit_id FROM durable_runtime.runtime_members WHERE session_id=$1',
        [request.authority.sessionId]
      )
      if (!unit || membership.rows[0]?.runtime_unit_id !== unit) {
        throw new InputStoreError('CANCEL_MEMBERSHIP_CHANGED')
      }
      const message = await tx.query<{ revision: string; intake_status: string }>(
        'SELECT revision,intake_status FROM durable_runtime.messages WHERE id=$1 AND session_id=$2 FOR UPDATE',
        [request.targetMessageId, request.authority.sessionId]
      )
      const row = message.rows[0]
      if (!row) {
        throw new InputStoreError('CANCEL_TARGET_NOT_FOUND')
      }
      const deliveries = await tx.query<{
        id: string
        runtime_unit_id: string
        attempt_id: string
        execution_epoch: string
        state: string
        provider_ref: string | null
      }>(
        `SELECT * FROM durable_runtime.delivery_attempts WHERE message_id=$1 AND session_id=$2
       ORDER BY effect_possible_at DESC NULLS LAST,id FOR UPDATE`,
        [request.targetMessageId, request.authority.sessionId]
      )
      const effect = deliveries.rows.find((d) =>
        ['EFFECT_POSSIBLE', 'ADMITTED', 'UNKNOWN', 'SETTLED', 'INTERRUPTED'].includes(d.state)
      )
      // INTERRUPTED still belongs to an execution. Only a previously verified,
      // persisted stop observation for this exact original delivery is terminal
      // evidence; state text, a provider ACK, or a bare evidence string is not.
      const stopped =
        effect?.state === 'INTERRUPTED'
          ? await tx.query(
              `SELECT 1 FROM durable_runtime.cancel_intents ci
             JOIN durable_runtime.session_context_records cr
               ON cr.session_id=ci.session_id AND cr.target_message_id=ci.target_message_id
              AND cr.kind='CANCEL_INTENT'
              AND cr.body_ref->>'operationId'=ci.operation_id::text
              AND cr.body_ref->'fixedDelivery'->>'deliveryAttemptId'=$3
             WHERE ci.session_id=$1 AND ci.target_message_id=$2
               AND ci.target_runtime_unit_id=$4 AND ci.target_attempt_id=$5
               AND ci.target_execution_epoch=$6
               AND ci.interrupt_status='CONFIRMED'
               AND nullif(ci.interrupt_evidence_ref,'') IS NOT NULL
             LIMIT 1`,
              [
                request.authority.sessionId,
                request.targetMessageId,
                effect.id,
                effect.runtime_unit_id,
                effect.attempt_id,
                effect.execution_epoch
              ]
            )
          : null
      const settled =
        row.intake_status === 'SETTLED' || effect?.state === 'SETTLED' || !!stopped?.rowCount
      const possible =
        ['EFFECT_POSSIBLE', 'ADMITTED', 'UNKNOWN', 'SETTLED', 'INTERRUPTED'].includes(
          row.intake_status
        ) || !!effect
      const interrupt: CancelInterruptStatus = settled
        ? 'ALREADY_SETTLED'
        : possible
          ? 'REQUESTED'
          : 'NOT_REQUIRED'
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
              providerTurnRef: effect.provider_ref
            }
          : null
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
          event: { kind: 'INTERRUPT_FIXED_DELIVERY', ...facts }
        })
      }
      // No desired mode/intent revision/activity update or provider I/O.
      return {
        operationId,
        targetMessageId: request.targetMessageId,
        targetMessageRevision: row.revision,
        cancelRevision: cancellation.cancel_revision,
        interruptStatus: interrupt,
        contextRevision
      }
    }
  )
}
