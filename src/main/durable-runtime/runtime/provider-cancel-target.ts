import type { DurableTransaction } from '../db/connection.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { ProviderEffectIdentity } from '../providers/shared/contracts.ts'
import type { JsonValue } from '../db/atomic.ts'

/** A cancel command consumes the committed fixed-delivery intent. Neither an
 * input command nor a current-screen/latest-turn lookup can authorize it. */
export async function assertProviderCancelTarget(tx: DurableTransaction, identity: ProviderEffectIdentity, input: JsonValue) {
  const fail = (): never => { throw new DurableDatabaseError('PROVIDER_CANCEL_TARGET_NOT_CURRENT') }
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.cancelIntentId !== 'string' ||
      !identity.messageId || !identity.deliveryAttemptId || !identity.nativeTurnId) { return fail() }
  const b = identity.binding
  const found = await tx.query(`SELECT c.operation_id FROM durable_runtime.cancel_intents c
    JOIN durable_runtime.operations o ON o.cancel_intent_id=c.operation_id
    JOIN durable_runtime.delivery_attempts d ON d.session_id=c.session_id AND d.message_id=c.target_message_id
    JOIN durable_runtime.session_context_records r ON r.session_id=c.session_id AND r.kind='CANCEL_INTENT'
      AND r.body_ref->>'operationId'=c.operation_id::text
    WHERE c.operation_id::text=$1 AND o.id=$2 AND c.session_id=$3 AND c.target_message_id=$4
      AND c.target_runtime_unit_id=$5 AND c.target_attempt_id=$6 AND c.target_execution_epoch=$7
      AND c.target_provider_turn_ref=$8 AND c.interrupt_status='REQUESTED'
      AND d.id=$9 AND d.runtime_unit_id=$5 AND d.attempt_id=$6 AND d.execution_epoch=$7
      AND d.state IN ('EFFECT_POSSIBLE','ADMITTED','UNKNOWN')
      AND r.body_ref->'fixedDelivery'->>'deliveryAttemptId'=$9::uuid::text
      AND r.body_ref->'fixedDelivery'->>'nativeTurnId'=$8
      AND r.body_ref->'fixedDelivery'->>'podUid'=$10`,
  [input.cancelIntentId, identity.commandClaim.identity.originalEnvelope.operationId, b.sessionId,
    identity.messageId, b.runtimeUnitId, b.attemptId, b.executionEpoch, identity.nativeTurnId, identity.deliveryAttemptId, b.podUid])
  if (found.rowCount !== 1) { fail() }
}
