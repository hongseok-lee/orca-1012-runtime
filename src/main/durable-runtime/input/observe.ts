import { counter } from '../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import { appendSessionEvent, appendAudit } from '../journal/store.ts'
import { assertInputScope } from './authority.ts'
import { requireInputSessionLock } from './composition.ts'
import { InputStoreError, type InputAuthority } from './types.ts'
import type { FixedInputDelivery, InputDeliveryObservation } from './observation-types.ts'

/** Original execution history only. Opaque proofs come from the actual verifier, never ACK booleans. */
export async function observeInputDeliveryInTransaction(
  tx: DurableTransaction,
  scope: InputAuthority,
  fixed: FixedInputDelivery,
  observation: InputDeliveryObservation
) {
  fixed = { ...fixed }
  observation =
    observation.kind === 'UNKNOWN'
      ? {
          ...observation,
          uncertainty: {
            ...observation.uncertainty,
            evidenceRefs: [...observation.uncertainty.evidenceRefs]
          }
        }
      : ({
          ...observation,
          proof: { ...observation.proof, providerRef: { ...observation.proof.providerRef } }
        } as InputDeliveryObservation)
  requireInputSessionLock(tx, scope.sessionId)
  if (!tx.isLockHeld(2, fixed.runtimeUnitId)) {
    throw new InputStoreError('INPUT_OBSERVATION_UNIT_LOCK')
  }
  const evidence = observation.kind === 'UNKNOWN' ? observation.uncertainty : observation.proof
  const observedAt = new Date(evidence.observedAt)
  if (!evidence.evidenceRef || !Number.isFinite(observedAt.getTime())) {
    throw new InputStoreError('INPUT_OBSERVATION_PROOF')
  }
  if (observation.kind === 'UNKNOWN') {
    if (
      observation.uncertainty.kind !== 'INPUT_EFFECT_UNCERTAIN' ||
      !/^[A-Z][A-Z0-9_]*$/.test(observation.uncertainty.reasonCode)
    ) {
      throw new InputStoreError('INPUT_OBSERVATION_PROOF')
    }
  } else {
    const proof = observation.proof
    const kind =
      observation.kind === 'ADMITTED'
        ? 'PROVIDER_ADMISSION'
        : observation.kind === 'SETTLED'
          ? 'PROVIDER_TARGET_COMPLETED'
          : 'PROVIDER_TARGET_STOPPED'
    if (
      proof.kind !== kind ||
      proof.attemptId !== fixed.attemptId ||
      proof.podUid !== fixed.podUid ||
      proof.executionEpoch !== fixed.executionEpoch ||
      !proof.providerRef?.nativeSessionRef
    ) {
      throw new InputStoreError('INPUT_OBSERVATION_PROOF')
    }
    if (observation.kind !== 'INTERRUPTED') {
      const p = observation.proof
      if (
        p.messageId !== fixed.messageId ||
        p.deliveryAttemptId !== fixed.deliveryAttemptId ||
        !['PROVIDER_PROTOCOL', 'PROVIDER_NATIVE_RECORD'].includes(p.source)
      ) {
        throw new InputStoreError('INPUT_OBSERVATION_PROOF')
      }
    }
  }
  await assertInputScope(tx, scope)
  const rows = await tx.query<{
    state: string
    provider_ref: string | null
    message_state: string
  }>(
    `SELECT d.state,d.provider_ref,m.intake_status AS message_state FROM durable_runtime.delivery_attempts d
     JOIN durable_runtime.messages m ON m.id=d.message_id AND m.session_id=d.session_id
     JOIN durable_runtime.attempts a ON a.id=d.attempt_id
     WHERE d.id=$1 AND d.message_id=$2 AND d.session_id=$3 AND d.runtime_unit_id=$4
       AND d.attempt_id=$5 AND d.execution_epoch=$6 AND a.pod_uid=$7 FOR UPDATE OF d,m`,
    [
      fixed.deliveryAttemptId,
      fixed.messageId,
      scope.sessionId,
      fixed.runtimeUnitId,
      fixed.attemptId,
      fixed.executionEpoch,
      fixed.podUid
    ]
  )
  const old = rows.rows[0]
  if (!old) {
    throw new InputStoreError('INPUT_OBSERVATION_TARGET')
  }
  if (observation.kind === 'INTERRUPTED') {
    const p = observation.proof
    if (
      (p.targetMessageId !== undefined && p.targetMessageId !== fixed.messageId) ||
      (p.targetTurnId !== undefined &&
        (p.providerRef.nativeTurnId !== p.targetTurnId ||
          (old.provider_ref !== null && old.provider_ref !== p.targetTurnId))) ||
      (p.targetMessageId === undefined &&
        (p.targetTurnId === undefined || old.provider_ref !== p.targetTurnId))
    ) {
      throw new InputStoreError('INPUT_OBSERVATION_PROOF')
    }
  }
  const facts: JsonValue =
    observation.kind === 'UNKNOWN'
      ? {
          kind: 'INPUT_OBSERVATION',
          state: observation.kind,
          ...fixed,
          evidenceRef: evidence.evidenceRef,
          observedAt: evidence.observedAt,
          reasonCode: observation.uncertainty.reasonCode,
          evidenceRefs: [...observation.uncertainty.evidenceRefs]
        }
      : {
          kind: 'INPUT_OBSERVATION',
          state: observation.kind,
          ...fixed,
          evidenceRef: evidence.evidenceRef,
          observedAt: evidence.observedAt,
          provider: observation.proof.providerRef.provider,
          nativeSessionRef: observation.proof.providerRef.nativeSessionRef,
          nativeTurnId: observation.proof.providerRef.nativeTurnId ?? null
        }
  const next = await tx.query<{ next_event_seq: string }>(
    'SELECT next_event_seq FROM durable_runtime.sessions WHERE id=$1',
    [scope.sessionId]
  )
  const event = await appendSessionEvent(tx, {
    sessionId: scope.sessionId,
    source: {
      kind: 'NATIVE',
      sourceKind: `INPUT_${observation.kind}`,
      provider:
        observation.kind === 'UNKNOWN' ? 'platform' : observation.proof.providerRef.provider,
      lineage: fixed.deliveryAttemptId,
      nativeId: evidence.evidenceRef
    },
    body: facts
  })
  if (event.sequence !== next.rows[0].next_event_seq) {
    return {
      visibility: 'TRANSACTION_LOCAL' as const,
      disposition: 'REPLAYED' as const,
      eventId: event.eventId
    }
  }
  const possible = ['EFFECT_POSSIBLE', 'ADMITTED', 'UNKNOWN'].includes(old.state)
  const conflict = !possible && old.state !== observation.kind
  if (possible) {
    const providerRef =
      observation.kind === 'UNKNOWN'
        ? null
        : (observation.proof.providerRef.nativeTurnId ??
          observation.proof.providerRef.nativeSessionRef)
    await tx.query(
      `UPDATE durable_runtime.delivery_attempts SET state=$2,provider_ref=COALESCE(provider_ref,$3),
      admitted_at=CASE WHEN $2 IN ('ADMITTED','SETTLED') THEN COALESCE(admitted_at,$4) ELSE admitted_at END,
      completed_at=CASE WHEN $2 IN ('SETTLED','INTERRUPTED') THEN $4 ELSE completed_at END,
      failure_reason=CASE WHEN $2='UNKNOWN' THEN $5 ELSE failure_reason END WHERE id=$1`,
      [
        fixed.deliveryAttemptId,
        observation.kind,
        providerRef,
        observedAt,
        observation.kind === 'UNKNOWN' ? observation.uncertainty.reasonCode : null
      ]
    )
    await tx.query(
      `UPDATE durable_runtime.messages SET intake_status=$2,revision=revision+1
      WHERE id=$1 AND intake_status IN ('EFFECT_POSSIBLE','ADMITTED','UNKNOWN')`,
      [fixed.messageId, observation.kind]
    )
    if (observation.kind === 'INTERRUPTED' || observation.kind === 'SETTLED') {
      await tx.query(
        `UPDATE durable_runtime.cancel_intents ci SET interrupt_status=$7,
        interrupt_evidence_ref=$8,updated_at=clock_timestamp()
        WHERE ci.session_id=$1 AND ci.target_message_id=$2 AND ci.target_runtime_unit_id=$3
          AND ci.target_attempt_id=$4 AND ci.target_execution_epoch=$5
          AND ci.interrupt_status IN ('REQUESTED','UNKNOWN')
          AND EXISTS(SELECT 1 FROM durable_runtime.session_context_records cr WHERE cr.session_id=ci.session_id
            AND cr.target_message_id=ci.target_message_id AND cr.kind='CANCEL_INTENT'
            AND cr.body_ref->>'operationId'=ci.operation_id::text
            AND cr.body_ref->'fixedDelivery'->>'deliveryAttemptId'=$6)`,
        [
          scope.sessionId,
          fixed.messageId,
          fixed.runtimeUnitId,
          fixed.attemptId,
          fixed.executionEpoch,
          fixed.deliveryAttemptId,
          observation.kind === 'INTERRUPTED' ? 'CONFIRMED' : 'ALREADY_SETTLED',
          evidence.evidenceRef
        ]
      )
    }
  }
  const revision = await tx.query<{ context_revision: string }>(
    'UPDATE durable_runtime.sessions SET context_revision=context_revision+1 WHERE id=$1 RETURNING context_revision',
    [scope.sessionId]
  )
  const body: JsonValue = {
    observation: facts,
    classification: conflict ? 'CONTRADICTORY_NO_PERMISSION' : 'ORIGINAL_EXECUTION',
    previousState: old.state
  }
  await tx.query(
    `INSERT INTO durable_runtime.session_context_records
    (id,session_id,revision,kind,target_message_id,body_ref) VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      event.eventId,
      scope.sessionId,
      revision.rows[0].context_revision,
      `INPUT_${observation.kind}`,
      fixed.messageId,
      JSON.stringify(body)
    ]
  )
  await appendAudit(tx, {
    actorId: scope.principal,
    sessionId: scope.sessionId,
    runtimeUnitId: fixed.runtimeUnitId,
    attemptId: fixed.attemptId,
    podUid: fixed.podUid,
    kind: `INPUT_${observation.kind}`,
    previousState: { state: old.state },
    nextState: body,
    occurredAt: observedAt,
    receivedAt: event.recordedAt,
    producerId: event.eventId,
    producerSeq: counter('sequence:producer', '1'),
    evidenceRefs: [evidence.evidenceRef]
  })
  return {
    visibility: 'TRANSACTION_LOCAL' as const,
    disposition: 'RECORDED' as const,
    eventId: event.eventId,
    contextRevision: counter('context-revision', revision.rows[0].context_revision),
    conflict
  }
}
