import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { runDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { observeInputDeliveryInTransaction } from '../input/observe.ts'
import type { ProviderCompletedProof } from '../input/observation-types.ts'
import type { CodexNativeNotification } from '../providers/codex/protocol.ts'
import type { ReadyProviderBinding } from '../providers/shared/contracts.ts'

/** The native turn a completion frame closes: Codex `turn/completed` (turn id)
 * or a Claude `result` (the user message uuid its delivery was admitted as). */
export function completedNativeTurn(notification: CodexNativeNotification): string | null {
  const params = notification.params
  if (!params || typeof params !== 'object' || Array.isArray(params)) { return null }
  if (notification.method === 'turn/completed') {
    const turn = Reflect.get(params, 'turn')
    return turn && typeof turn === 'object' && ['completed', 'failed'].includes(String(Reflect.get(turn, 'status'))) && typeof Reflect.get(turn, 'id') === 'string'
      ? String(Reflect.get(turn, 'id')) : null
  }
  if (notification.method === 'claude/message' && Reflect.get(params, 'type') === 'result' && Reflect.get(params, 'subtype') === 'success') {
    const uuid = Reflect.get(params, 'user_message_uuid')
    return typeof uuid === 'string' && uuid ? uuid : null
  }
  return null
}

/** A turn admitted under an owner that was lost finishes in the Pod; the
 * re-attached owner sees its completion frame (live or replayed) on the same
 * connection and records it like the original driver would. Only an ADMITTED
 * delivery of this exact attempt whose native turn is this one is settled;
 * deliveries this owner submitted are settled by its own driver. */
export async function settleOrphanedTurn(pool: Pool, binding: ReadyProviderBinding, notification: CodexNativeNotification,
  ownDeliveries: ReadonlySet<string>): Promise<boolean> {
  const turnId = completedNativeTurn(notification)
  if (!turnId || notification.connectionId !== binding.connectionInstanceId ||
      (notification.method === 'turn/completed' && Reflect.get(notification.params as object, 'threadId') !== binding.providerRef.nativeSessionRef)) { return false }
  const found = await pool.query<{ id: string; message_id: string; sender: string }>(`SELECT d.id,d.message_id,
      (SELECT i.authenticated_sender FROM durable_runtime.input_components i WHERE i.message_id=d.message_id ORDER BY i.input_seq DESC LIMIT 1) AS sender
    FROM durable_runtime.delivery_attempts d WHERE d.session_id=$1 AND d.attempt_id=$2 AND d.state='ADMITTED' AND d.provider_ref=$3`,
  [binding.sessionId, binding.attemptId, turnId])
  const row = found.rows[0]
  if (found.rowCount !== 1 || !row.sender || ownDeliveries.has(row.id)) { return false }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: completion frame of this admitted native turn on the recorded connection.
  const proof = Object.freeze({ kind: 'PROVIDER_TARGET_COMPLETED', source: 'PROVIDER_PROTOCOL',
    ...(notification.method === 'turn/completed' ? { terminalStatus: Reflect.get(Reflect.get(notification.params as object, 'turn') as object, 'status') } : {}),
    evidenceRef: `orphaned-turn-completed:${notification.connectionId}:${notification.sequence}`, observedAt: notification.observedAt,
    attemptId: binding.attemptId, podUid: binding.podUid, executionEpoch: binding.executionEpoch,
    messageId: logicalId('message', row.message_id), deliveryAttemptId: logicalId('delivery-attempt', row.id),
    providerRef: Object.freeze({ ...binding.providerRef, nativeTurnId: turnId }) }) as unknown as ProviderCompletedProof
  const settled = await runDurableTransaction(pool, async tx => {
    await lockAggregates(tx, { sessionIds: [binding.sessionId], runtimeUnitIds: [binding.runtimeUnitId] })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sender recorded with this message's accepted input.
    const authority = { principal: row.sender as never, sessionId: binding.sessionId,
      scope: { kind: 'TERMINAL' as const, terminalHandle: binding.terminalHandle } }
    return observeInputDeliveryInTransaction(tx, authority, { messageId: proof.messageId, deliveryAttemptId: proof.deliveryAttemptId,
      runtimeUnitId: binding.runtimeUnitId, attemptId: binding.attemptId, podUid: binding.podUid, executionEpoch: binding.executionEpoch },
    { kind: 'SETTLED', proof })
  })
  return settled.ok && settled.commitOutcome === 'ACKNOWLEDGED'
}

/** Completion frames a lost owner already journaled before it could record
 * the turn (so a re-attach does not replay them): settle the ADMITTED
 * deliveries of this attempt they close, once, at adoption. */
export async function settleJournaledOrphanedTurns(pool: Pool, binding: ReadyProviderBinding, ownDeliveries: ReadonlySet<string>): Promise<number> {
  const frames = await pool.query<{ notification: CodexNativeNotification }>(`SELECT e.body->'notification' AS notification
    FROM durable_runtime.session_events e JOIN durable_runtime.delivery_attempts d ON d.session_id=e.session_id
    WHERE e.session_id=$1 AND d.attempt_id=$2 AND d.state='ADMITTED' AND e.body->>'kind'='TERMINAL_CODEX_NOTIFICATION'
      AND e.body->'notification'->>'connectionId'=$3
      AND ((e.body->'notification'->>'method'='turn/completed' AND e.body->'notification'->'params'->'turn'->>'id'=d.provider_ref)
        OR (e.body->'notification'->>'method'='claude/message' AND e.body->'notification'->'params'->>'type'='result'
          AND e.body->'notification'->'params'->>'user_message_uuid'=d.provider_ref))
    ORDER BY e.seq`, [binding.sessionId, binding.attemptId, binding.connectionInstanceId])
  let settled = 0
  for (const row of frames.rows) { if (await settleOrphanedTurn(pool, binding, row.notification, ownDeliveries)) { settled++ } }
  return settled
}

/** Reconcile original terminal frames even when its host has stopped. The
 * binding comes from the committed READY/control records, and only a frame of
 * that exact admitted attempt/connection/thread may settle an original input. */
export async function settleJournaledAttemptTurns(pool: Pool, attemptId: string, podUid: string): Promise<number> {
  const rows = await pool.query<{ binding: ReadyProviderBinding }>(`SELECT jsonb_build_object(
      'sessionId',s.id,'tabId',t.id,'terminalHandle',t.terminal_handle,
      'providerBindingRevision',s.provider_binding_revision::text,'runtimeUnitId',a.runtime_unit_id,
      'attemptId',a.id,'podUid',a.pod_uid,'executionEpoch',a.execution_epoch::text,
      'connectionInstanceId',h.connection_instance_id,'providerRef',jsonb_build_object(
        'provider',h.provider,'nativeSessionRef',e.next_state->'providerRef'->>'nativeSessionRef')) AS binding
    FROM durable_runtime.attempts a JOIN durable_runtime.agent_control_hosts h ON h.attempt_id=a.id
    JOIN durable_runtime.runtime_members m ON m.runtime_unit_id=a.runtime_unit_id
    JOIN durable_runtime.sessions s ON s.id=m.session_id
    JOIN durable_runtime.tabs t ON t.session_id=s.id AND t.kind='terminal' AND t.lifecycle='OPEN'
    JOIN LATERAL (SELECT next_state FROM durable_runtime.runtime_audit_events
      WHERE kind='INITIAL_PROVIDER_READY' AND next_state->>'attemptId'=a.id::text
      AND next_state->'providerRef'->>'provider'=h.provider
      AND next_state->'providerRef'->>'nativeSessionRef' IS NOT NULL ORDER BY occurred_at DESC LIMIT 1) e ON true
    WHERE a.id=$1 AND a.pod_uid=$2 AND EXISTS(SELECT 1 FROM durable_runtime.delivery_attempts d
      WHERE d.attempt_id=a.id AND d.session_id=s.id AND d.state='ADMITTED')`, [attemptId, podUid])
  let count = 0
  for (const row of rows.rows) { count += await settleJournaledOrphanedTurns(pool, row.binding, new Set()) }
  return count
}
