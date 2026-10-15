import type { Pool } from 'pg'
import type { RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { requireInputSessionLock } from './composition.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { runDurableMutation, type JsonValue, type MutationOutcome } from '../db/atomic.ts'
import { discoverInputUnit, assertInputScope } from './authority.ts'
import { canonicalInputJson, inputPayloadHash, inputScopeKey } from './canonical.ts'
import { InputStoreError } from './types.ts'
import type { CancelInputRequest, CancelInterruptStatus, ObservedTurnCancelRequest } from './cancel-types.ts'
import { readObservedTurnTargetInTransaction } from './observed-turn-target.ts'
import { recordCancelIntent, type CancelMessageRow, type CancelDeliveryRow } from './cancel-record.ts'

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
    (tx) => recordInputCancel(tx, request, unit)
  )
}

/** Catalog-compatible callback core. Upper outer receipt/transaction owns COMMIT.
 * snapshotRequest must be fixed before the caller's first await; this helper also
 * snapshots its DTO before its first await. It never discovers/locks a replacement Unit.
 */
export async function recordInputCancel(
  tx: DurableTransaction,
  snapshotRequest: CancelInputRequest,
  expectedUnitId: RuntimeUnitId | null
) {
  const request: CancelInputRequest = {
    ...snapshotRequest,
    authority: { ...snapshotRequest.authority, scope: { ...snapshotRequest.authority.scope } },
    originalPayload: JSON.parse(canonicalInputJson(snapshotRequest.originalPayload))
  }
  const unit = expectedUnitId
  logicalId('message', request.targetMessageId)
  requireInputSessionLock(tx, request.authority.sessionId)
  if (unit !== null && !tx.isLockHeld(2, unit)) {
    throw new InputStoreError('CANCEL_UNIT_LOCK_REQUIRED')
  }
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
           AND ci.target_runtime_unit_id=$4::uuid AND ci.target_attempt_id=$5::uuid
           AND ci.target_execution_epoch=$6::bigint
           AND ci.interrupt_status='CONFIRMED'
           AND nullif(ci.interrupt_evidence_ref,'') IS NOT NULL
         UNION ALL
         SELECT 1 FROM durable_runtime.session_context_records cr
         WHERE cr.session_id=$1 AND cr.target_message_id=$2 AND cr.kind='INPUT_INTERRUPTED'
           AND cr.body_ref->>'classification'='ORIGINAL_EXECUTION'
           AND cr.body_ref->'observation'->>'state'='INTERRUPTED'
           AND cr.body_ref->'observation'->>'deliveryAttemptId'=$3
           AND cr.body_ref->'observation'->>'runtimeUnitId'=$4::uuid::text
           AND cr.body_ref->'observation'->>'attemptId'=$5::uuid::text
           AND cr.body_ref->'observation'->>'executionEpoch'=$6::bigint::text
           AND nullif(cr.body_ref->'observation'->>'evidenceRef','') IS NOT NULL
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
  const recorded = await recordCancelIntent(tx, request, unit, row, effect, possible, interrupt)
  return recorded.result
}

/** Historical target only. Caller owns auth, receipt replay, locks, transaction and COMMIT. */
export async function recordObservedTurnCancel(
  transaction: DurableTransaction,
  snapshotRequest: ObservedTurnCancelRequest,
  expectedUnitId: RuntimeUnitId
) {
  const request: ObservedTurnCancelRequest = {
    authority: {
      principal: snapshotRequest.authority.principal,
      sessionId: snapshotRequest.authority.sessionId,
      scope: { ...snapshotRequest.authority.scope }
    },
    provider: snapshotRequest.provider,
    nativeTurnId: snapshotRequest.nativeTurnId,
    method: snapshotRequest.method,
    operationKey: snapshotRequest.operationKey,
    originalPayload: JSON.parse(canonicalInputJson(snapshotRequest.originalPayload))
  }
  const unit = expectedUnitId
  const query = transaction.query.bind(transaction)
  const isLockHeld = transaction.isLockHeld.bind(transaction)
  // All nested readers/writers use the same captured method and receiver. The
  // borrowed transaction itself is neither modified nor frozen.
  const tx = new Proxy(transaction, {
    get(owner, key) {
      if (key === 'query') { return query }
      if (key === 'isLockHeld') { return isLockHeld }
      const value = Reflect.get(owner, key)
      return typeof value === 'function' ? value.bind(owner) : value
    }
  })
  inputScopeKey(request.authority)
  logicalId('runtime-unit', unit)
  requireInputSessionLock(tx, request.authority.sessionId)
  if (!isLockHeld(2, unit)) {
    throw new InputStoreError('CANCEL_UNIT_LOCK_REQUIRED')
  }
  await assertInputScope(tx, request.authority)
  const membership = await query<{ runtime_unit_id: string }>(
    'SELECT runtime_unit_id FROM durable_runtime.runtime_members WHERE session_id=$1',
    [request.authority.sessionId]
  )
  if (membership.rows[0]?.runtime_unit_id !== unit) {
    throw new InputStoreError('CANCEL_MEMBERSHIP_CHANGED')
  }
  const target = await readObservedTurnTargetInTransaction(
    tx, request.authority, request.provider, request.nativeTurnId
  )
  if (target.runtimeUnitId !== unit) {
    throw new InputStoreError('CANCEL_OBSERVED_UNIT_MISMATCH')
  }
  const message = await query<CancelMessageRow>(
    'SELECT revision,intake_status FROM durable_runtime.messages WHERE id=$1 AND session_id=$2 FOR UPDATE',
    [target.messageId, target.sessionId]
  )
  const row = message.rows[0]
  if (!row) {
    throw new InputStoreError('CANCEL_TARGET_NOT_FOUND')
  }
  const deliveries = await query<CancelDeliveryRow>(
    `SELECT d.id,d.runtime_unit_id,d.attempt_id,d.execution_epoch,d.provider_ref
     FROM durable_runtime.delivery_attempts d
     JOIN durable_runtime.attempts a ON a.id=d.attempt_id
     WHERE d.id=$1 AND d.session_id=$2 AND d.message_id=$3 AND d.runtime_unit_id=$4
       AND d.attempt_id=$5 AND d.execution_epoch=$6
       AND a.runtime_unit_id=$4 AND a.execution_epoch=$6 AND a.pod_uid=$7 FOR UPDATE OF d`,
    [target.deliveryAttemptId, target.sessionId, target.messageId, target.runtimeUnitId,
      target.attemptId, target.executionEpoch, target.podUid]
  )
  const delivery = deliveries.rows[0]
  if (!delivery || deliveries.rowCount !== 1) {
    throw new InputStoreError('CANCEL_OBSERVED_DELIVERY_MISMATCH')
  }
  // Message state and delivery state text are deliberately not completion evidence.
  const terminalObservation = target.provenance.some((entry) =>
    entry.classification === 'ORIGINAL_EXECUTION' &&
    (entry.state === 'SETTLED' || entry.state === 'INTERRUPTED')
  )
  // Production CONFIRMED is backed by the same atomic original observation.
  // A status/evidence string alone cannot replace that validated provenance.
  const interrupt: CancelInterruptStatus = terminalObservation
    ? 'ALREADY_SETTLED' : 'REQUESTED'
  const recorded = await recordCancelIntent(
    tx, { ...request, targetMessageId: target.messageId }, unit, row,
    { ...delivery, provider_ref: target.nativeTurnId }, true, interrupt, target
  )
  return {
    ...recorded.result,
    target,
    eventId: recorded.event.eventId,
    journalEpoch: recorded.event.journalEpoch,
    sequence: recorded.event.sequence
  }
}

