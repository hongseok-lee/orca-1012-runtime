import type { Pool } from 'pg'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import { withDurableTransaction, type DurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import { lockAggregates } from '../db/locks.ts'
import { assertInputScope } from '../input/authority.ts'
import { inputPayloadHash } from '../input/canonical.ts'
import { requireInputSessionLock, composeMessagePayload } from '../input/composition.ts'
import { InputStoreError, type InputAuthority, type InputKind } from '../input/types.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { RecoveryContextFrame } from './types.ts'

function freezeContextJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freezeContextJson(child)
    }
    Object.freeze(value)
  }
  return value
}

/** One Session-locked PG snapshot. Current runtime/binding/clock are not frame content. */
export async function readRecoveryContextFrame(
  tx: DurableTransaction,
  authority: InputAuthority
): Promise<RecoveryContextFrame> {
  authority = { ...authority, scope: { ...authority.scope } }
  requireInputSessionLock(tx, authority.sessionId)
  await assertInputScope(tx, authority)
  const session = await tx.query<{ context_revision: string }>(
    'SELECT context_revision FROM durable_runtime.sessions WHERE id=$1',
    [authority.sessionId]
  )
  const records = await tx.query<{
    id: string
    revision: string
    kind: string
    target_message_id: string | null
    target_event_id: string | null
    body_ref: JsonValue
    created_at: Date
  }>(
    `SELECT id,revision,kind,target_message_id,target_event_id,body_ref,created_at
     FROM durable_runtime.session_context_records WHERE session_id=$1 ORDER BY revision,id`,
    [authority.sessionId]
  )
  // Only context-referenced targets affect the frame. New unrelated inputs cannot
  // silently change its hash under an unchanged context revision.
  const targets = [
    ...new Set(
      records.rows.map((r) => r.target_message_id).filter((id): id is string => id !== null)
    )
  ].sort()
  const facts: JsonValue[] = []
  for (const id of targets) {
    const message = await tx.query<{
      input_kind: InputKind
      intake_status: string
      cancel_revision: string
      cancel_requested_at: Date | null
      sealed_revision: string | null
      sealed_payload_hash: string | null
    }>(
      'SELECT input_kind,intake_status,cancel_revision,cancel_requested_at,sealed_revision,sealed_payload_hash FROM durable_runtime.messages WHERE session_id=$1 AND id=$2',
      [authority.sessionId, id]
    )
    const row = message.rows[0]
    if (!row) {
      throw new InputStoreError('CONTEXT_TARGET_MISSING')
    }
    const deliveries = await tx.query<{
      id: string
      runtime_unit_id: string
      attempt_id: string
      execution_epoch: string
      state: string
      provider_ref: string | null
      failure_reason: string | null
    }>(
      'SELECT id,runtime_unit_id,attempt_id,execution_epoch,state,provider_ref,failure_reason FROM durable_runtime.delivery_attempts WHERE session_id=$1 AND message_id=$2 ORDER BY id',
      [authority.sessionId, id]
    )
    facts.push({
      messageId: id,
      state: row.intake_status,
      cancelRevision: row.cancel_revision,
      cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
      sealedRevision: row.sealed_revision,
      sealedPayloadHash: row.sealed_payload_hash,
      originalComposition: await composeMessagePayload(
        tx,
        authority.sessionId,
        logicalId('message', id),
        row.input_kind
      ),
      deliveries: deliveries.rows.map((d) => ({
        deliveryAttemptId: d.id,
        runtimeUnitId: d.runtime_unit_id,
        attemptId: d.attempt_id,
        executionEpoch: d.execution_epoch,
        state: d.state,
        providerRef: d.provider_ref,
        failureReason: d.failure_reason
      }))
    })
  }
  const eventIds = [
    ...new Set(records.rows.map((r) => r.target_event_id).filter((id): id is string => id !== null))
  ].sort()
  const originalEvents: JsonValue[] = []
  for (const id of eventIds) {
    const event = await tx.query<{
      event_id: string
      producer_id: string
      incarnation: string
      producer_seq: string
      agent_id: string
      payload: JsonValue
      committed_at: Date
    }>(
      `SELECT q.event_id,q.producer_id,q.incarnation,q.producer_seq,q.agent_id,q.payload,q.committed_at
       FROM durable_runtime.runtime_event_queue q JOIN durable_runtime.runtime_event_targets t ON t.event_id=q.event_id
       WHERE q.event_id=$1 AND t.session_id=$2`,
      [id, authority.sessionId]
    )
    const row = event.rows[0]
    if (!row) {
      throw new InputStoreError('CONTEXT_EVENT_TARGET_MISSING')
    }
    // Immutable original only. Mutable claim/retry state is quoted in the
    // source owner's immutable failure record, never silently re-read as a new directive.
    originalEvents.push({
      eventId: row.event_id,
      producerId: row.producer_id,
      incarnation: row.incarnation,
      sequence: row.producer_seq,
      agentId: row.agent_id,
      originalPayload: row.payload,
      committedAt: row.committed_at.toISOString()
    })
  }
  const revision = counter('context-revision', session.rows[0].context_revision)
  const payload: JsonValue = {
    version: 1,
    sessionId: authority.sessionId,
    contextRevision: revision,
    records: records.rows.map((r) => ({
      id: r.id,
      revision: r.revision,
      kind: r.kind,
      targetMessageId: r.target_message_id,
      targetEventId: r.target_event_id,
      body: r.body_ref,
      createdAt: r.created_at.toISOString()
    })),
    facts,
    ...(originalEvents.length ? { originalEvents } : {})
  }
  freezeContextJson(payload)
  return Object.freeze({
    version: 1,
    sessionId: authority.sessionId,
    revision,
    payload,
    hash: inputPayloadHash(payload)
  })
}
export async function getRecoveryContextFrame(
  pool: Pool,
  authority: InputAuthority
): Promise<RecoveryContextFrame> {
  authority = { ...authority, scope: { ...authority.scope } }
  return withDurableTransaction(pool, async (tx) => {
    await assertInputScope(tx, authority)
    await lockAggregates(tx, { sessionIds: [authority.sessionId] })
    return readRecoveryContextFrame(tx, authority)
  })
}
