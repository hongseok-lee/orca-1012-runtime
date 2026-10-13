import { randomUUID } from 'node:crypto'
import type { DurableTransaction } from '../db/connection.ts'
import type { ProviderContextDeliveryRow } from '../db/rows.ts'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import { assertInputScope } from '../input/authority.ts'
import { requireInputSessionLock } from '../input/composition.ts'
import { inputPayloadHash } from '../input/canonical.ts'
import { InputStoreError, type InputAuthority } from '../input/types.ts'
import { readRecoveryContextFrame } from './frame.ts'
import type { RecoveryContextFrame, VerifiedContextDeliveryProof } from './types.ts'

/** Append-only historical proof. The opaque verifier, not a reference string, supplies authority. */
export async function recordContextDeliveryInTransaction(
  tx: DurableTransaction,
  scope: InputAuthority,
  frame: RecoveryContextFrame,
  proof: VerifiedContextDeliveryProof
) {
  frame = { ...frame }
  scope = { ...scope, scope: { ...scope.scope } }
  proof = { ...proof, providerRef: { ...proof.providerRef } }
  requireInputSessionLock(tx, scope.sessionId)
  await assertInputScope(tx, scope)
  if (
    proof.kind !== 'PROVIDER_CONTEXT_DELIVERY' ||
    !['PROVIDER_PROTOCOL', 'PROVIDER_NATIVE_RECORD'].includes(proof.source) ||
    proof.sessionId !== scope.sessionId ||
    frame.sessionId !== scope.sessionId ||
    frame.version !== 1 ||
    proof.contextRevision !== frame.revision ||
    proof.contextHash !== frame.hash ||
    inputPayloadHash(frame.payload) !== frame.hash ||
    !proof.evidenceRef ||
    !proof.providerRef?.nativeSessionRef ||
    !proof.podUid ||
    !Number.isFinite(Date.parse(proof.observedAt))
  ) {
    throw new InputStoreError('CONTEXT_PROOF_BINDING')
  }
  counter('context-revision', proof.contextRevision)
  counter('row:provider-binding', proof.providerBindingRevision)
  const session = await tx.query<{ context_revision: string; provider_binding_revision: string }>(
    'SELECT context_revision,provider_binding_revision FROM durable_runtime.sessions WHERE id=$1',
    [scope.sessionId]
  )
  if (
    BigInt(proof.contextRevision) > BigInt(session.rows[0].context_revision) ||
    BigInt(proof.providerBindingRevision) > BigInt(session.rows[0].provider_binding_revision)
  ) {
    throw new InputStoreError('CONTEXT_PROOF_FUTURE')
  }
  const target = await tx.query(
    `SELECT a.id FROM durable_runtime.attempts a
    WHERE a.id=$1 AND a.runtime_unit_id=$2 AND a.execution_epoch=$3 AND a.pod_uid=$4
    AND (EXISTS(SELECT 1 FROM durable_runtime.runtime_members m WHERE m.session_id=$5 AND m.runtime_unit_id=a.runtime_unit_id)
      OR EXISTS(SELECT 1 FROM durable_runtime.delivery_attempts d WHERE d.session_id=$5 AND d.attempt_id=a.id AND d.runtime_unit_id=a.runtime_unit_id))`,
    [proof.attemptId, proof.runtimeUnitId, proof.executionEpoch, proof.podUid, scope.sessionId]
  )
  if (target.rowCount !== 1) {
    throw new InputStoreError('CONTEXT_PROOF_TARGET')
  }
  const values = [
    scope.sessionId,
    proof.providerBindingRevision,
    proof.attemptId,
    proof.contextRevision,
    proof.contextHash,
    proof.evidenceRef
  ]
  await tx.query(
    `INSERT INTO durable_runtime.provider_context_deliveries
    (id,session_id,provider_binding_revision,attempt_id,context_revision,context_hash,evidence_ref,
     runtime_unit_id,pod_uid,execution_epoch,provider,native_session_ref,native_turn_id,source,observed_at)
    VALUES ($7,$1,$2,$3,$4,$5,$6,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT
    (session_id,provider_binding_revision,attempt_id,context_revision,context_hash,evidence_ref) DO NOTHING`,
    [
      ...values,
      randomUUID(),
      proof.runtimeUnitId,
      proof.podUid,
      proof.executionEpoch,
      proof.providerRef.provider,
      proof.providerRef.nativeSessionRef,
      proof.providerRef.nativeTurnId ?? null,
      proof.source,
      proof.observedAt
    ]
  )
  const original = await tx.query<ProviderContextDeliveryRow>(
    `SELECT * FROM durable_runtime.provider_context_deliveries
    WHERE session_id=$1 AND provider_binding_revision=$2 AND attempt_id=$3 AND context_revision=$4 AND context_hash=$5 AND evidence_ref=$6`,
    values
  )
  const row = original.rows[0]
  if (
    !row ||
    row.runtime_unit_id !== proof.runtimeUnitId ||
    row.pod_uid !== proof.podUid ||
    row.execution_epoch !== proof.executionEpoch ||
    row.provider !== proof.providerRef.provider ||
    row.native_session_ref !== proof.providerRef.nativeSessionRef ||
    row.native_turn_id !== (proof.providerRef.nativeTurnId ?? null) ||
    row.source !== proof.source ||
    row.observed_at.toISOString() !== new Date(proof.observedAt).toISOString()
  ) {
    throw new InputStoreError('CONTEXT_PROOF_RETRY_CONFLICT')
  }
  const current = await isCurrentContextDeliveredInTransaction(tx, scope, row.id)
  return {
    visibility: 'TRANSACTION_LOCAL' as const,
    deliveryProofId: row.id,
    currentSatisfied: current
  }
}

/** No wake or submission. Old binding/attempt/context proof remains history only. */
export async function isCurrentContextDeliveredInTransaction(
  tx: DurableTransaction,
  scope: InputAuthority,
  proofId: string
) {
  scope = { ...scope, scope: { ...scope.scope } }
  requireInputSessionLock(tx, scope.sessionId)
  await assertInputScope(tx, scope)
  const frame = await readRecoveryContextFrame(tx, scope)
  const row = await tx.query(
    `SELECT p.id FROM durable_runtime.provider_context_deliveries p
    JOIN durable_runtime.sessions s ON s.id=p.session_id
    JOIN durable_runtime.runtime_members m ON m.session_id=s.id
    JOIN durable_runtime.runtime_units u ON u.id=m.runtime_unit_id
    JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id
    WHERE p.id=$1 AND p.session_id=$2 AND p.context_revision=$3 AND p.context_hash=$4
      AND p.provider_binding_revision=s.provider_binding_revision AND p.runtime_unit_id=u.id
      AND p.attempt_id=u.active_attempt_id AND p.execution_epoch=u.execution_epoch AND p.pod_uid=a.pod_uid`,
    [proofId, scope.sessionId, frame.revision, frame.hash]
  )
  return row.rowCount === 1
}
