import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type {
  AttemptId, ContextRecordId, ContextRevision, DeliveryAttemptId, EventId,
  ExecutionEpoch, MessageId, RuntimeUnitId, SessionId
} from '../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { assertInputScope } from './authority.ts'
import { inputScopeKey } from './canonical.ts'
import { requireInputSessionLock } from './composition.ts'
import { InputStoreError, type InputAuthority } from './types.ts'

type Provider = 'claude' | 'codex'
type State = 'ADMITTED' | 'SETTLED' | 'INTERRUPTED'
type Classification = 'ORIGINAL_EXECUTION' | 'CONTRADICTORY_NO_PERMISSION'
export type ObservedTurnProvenance = Readonly<{
  eventId: EventId
  contextId: ContextRecordId
  contextRevision: ContextRevision
  journalEpoch: string
  journalSequence: string
  state: State
  classification: Classification
  evidenceRef: string
  observedAt: string
  committedAt: string
}>
/** Historical identity only: neither execution permission nor completion/stop proof. */
export type ObservedTurnTarget = Readonly<{
  sessionId: SessionId
  messageId: MessageId
  deliveryAttemptId: DeliveryAttemptId
  runtimeUnitId: RuntimeUnitId
  attemptId: AttemptId
  executionEpoch: ExecutionEpoch
  podUid: string
  provider: Provider
  nativeSessionRef: string
  nativeTurnId: string
  provenance: readonly ObservedTurnProvenance[]
}>
function invalid(): never {
  throw new InputStoreError('OBSERVED_TURN_HISTORY_INVALID')
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) { return invalid() }
  // Object.entries avoids trusting an unchecked JSON type assertion.
  return Object.fromEntries(Object.entries(value))
}
function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) { return invalid() }
  return value
}
function uuid<K extends string>(kind: K, value: unknown) {
  try { return logicalId(kind, string(value)) } catch { return invalid() }
}
function decimal<K extends string>(kind: K, value: unknown) {
  try { return counter(kind, string(value)) } catch { return invalid() }
}
function time(value: unknown): string {
  if (value instanceof Date && !Number.isFinite(value.getTime())) { return invalid() }
  const text = value instanceof Date ? value.toISOString() : string(value)
  if (!Number.isFinite(new Date(text).getTime())) { return invalid() }
  return text
}
function state(value: unknown): State {
  if (value !== 'ADMITTED' && value !== 'SETTLED' && value !== 'INTERRUPTED') { return invalid() }
  return value
}
function provider(value: unknown): Provider {
  if (value !== 'claude' && value !== 'codex') { return invalid() }
  return value
}
function classification(value: unknown): Classification {
  if (value !== 'ORIGINAL_EXECUTION' && value !== 'CONTRADICTORY_NO_PERMISSION') { return invalid() }
  return value
}

/** Caller owns authentication, Catalog access, Session lock, transaction and commit. */
export async function readObservedTurnTargetInTransaction(
  tx: DurableTransaction,
  authority: InputAuthority,
  expectedProvider: Provider,
  nativeTurnId: string
): Promise<ObservedTurnTarget> {
  const scope: InputAuthority = {
    principal: authority.principal,
    sessionId: authority.sessionId,
    scope: { ...authority.scope }
  }
  const query = tx.query.bind(tx)
  inputScopeKey(scope)
  requireInputSessionLock(tx, scope.sessionId)
  if ((expectedProvider !== 'claude' && expectedProvider !== 'codex') ||
      typeof nativeTurnId !== 'string' || nativeTurnId.length === 0) {
    throw new InputStoreError('OBSERVED_TURN_INPUT')
  }
  await assertInputScope(tx, scope)
  const result = await query<Record<string, unknown>>(
    `SELECT e.event_id,e.session_id,e.journal_epoch,e.seq,e.source_key,e.body,e.committed_at,
       c.id AS context_id,c.session_id AS context_session,c.target_message_id,c.kind AS context_kind,
       c.revision AS context_revision,c.body_ref,c.body_ref->'observation'=e.body AS context_matches,
       d.id AS delivery_id,d.message_id,d.session_id AS delivery_session,d.runtime_unit_id,
       d.attempt_id,d.execution_epoch,m.id AS original_message,m.session_id AS message_session,
       a.id AS original_attempt,a.runtime_unit_id AS attempt_unit,a.execution_epoch AS attempt_epoch,
       a.pod_uid,u.id AS original_unit,rm.session_id AS member_session
     FROM durable_runtime.session_events e
     LEFT JOIN durable_runtime.session_context_records c ON c.id=e.event_id
     LEFT JOIN durable_runtime.delivery_attempts d ON d.id::text=e.body->>'deliveryAttemptId'
     LEFT JOIN durable_runtime.messages m ON m.id=d.message_id AND m.session_id=d.session_id
     LEFT JOIN durable_runtime.attempts a ON a.id=d.attempt_id
     LEFT JOIN durable_runtime.runtime_units u ON u.id=d.runtime_unit_id
     LEFT JOIN durable_runtime.runtime_members rm
       ON rm.session_id=d.session_id AND rm.runtime_unit_id=d.runtime_unit_id
     WHERE e.session_id=$1 AND e.body->>'kind'='INPUT_OBSERVATION'
       AND e.body->>'nativeTurnId'=$2 ORDER BY e.journal_epoch,e.seq`,
    [scope.sessionId, nativeTurnId]
  )
  if (result.rows.length === 0) { throw new InputStoreError('OBSERVED_TURN_NOT_FOUND') }
  let target: Omit<ObservedTurnTarget, 'provenance'> | undefined
  let tupleKey: string | undefined
  let original = false
  const provenance: ObservedTurnProvenance[] = []
  for (const row of result.rows) {
    const body = object(row.body)
    const observedState = state(body.state)
    const observedProvider = provider(body.provider)
    if (observedProvider !== expectedProvider) {
      throw new InputStoreError('OBSERVED_TURN_PROVIDER_MISMATCH')
    }
    const fixed = Object.freeze({
      sessionId: uuid('session', row.session_id),
      messageId: uuid('message', body.messageId),
      deliveryAttemptId: uuid('delivery-attempt', body.deliveryAttemptId),
      runtimeUnitId: uuid('runtime-unit', body.runtimeUnitId),
      attemptId: uuid('attempt', body.attemptId),
      executionEpoch: decimal('execution-epoch', body.executionEpoch),
      podUid: string(body.podUid),
      provider: observedProvider,
      nativeSessionRef: string(body.nativeSessionRef),
      nativeTurnId: string(body.nativeTurnId)
    })
    const evidenceRef = string(body.evidenceRef)
    const eventId = uuid('event', row.event_id)
    const contextId = uuid('context-record', row.context_id)
    const context = object(row.body_ref)
    const contextClass = classification(context.classification)
    const previousState = string(context.previousState)
    if (!['DISPATCH_INTENT','STAGED','EFFECT_POSSIBLE','ADMITTED','SETTLED',
          'CANCELLED','UNKNOWN','INTERRUPTED'].includes(previousState)) { return invalid() }
    const contradictory = !['EFFECT_POSSIBLE','ADMITTED','UNKNOWN'].includes(previousState) &&
      previousState !== observedState
    if (body.kind !== 'INPUT_OBSERVATION' || fixed.sessionId !== scope.sessionId ||
        fixed.nativeTurnId !== nativeTurnId ||
        row.source_key !== JSON.stringify(['v1',scope.sessionId,'native',`INPUT_${observedState}`,
          expectedProvider,fixed.deliveryAttemptId,evidenceRef]) ||
        contextId !== row.event_id || row.context_session !== scope.sessionId ||
        row.target_message_id !== fixed.messageId || row.context_kind !== `INPUT_${observedState}` ||
        row.context_matches !== true ||
        contextClass !== (contradictory ? 'CONTRADICTORY_NO_PERMISSION' : 'ORIGINAL_EXECUTION') ||
        row.delivery_id !== fixed.deliveryAttemptId || row.message_id !== fixed.messageId ||
        row.delivery_session !== scope.sessionId || row.runtime_unit_id !== fixed.runtimeUnitId ||
        row.attempt_id !== fixed.attemptId || row.execution_epoch !== fixed.executionEpoch ||
        row.original_message !== fixed.messageId || row.message_session !== scope.sessionId ||
        row.original_attempt !== fixed.attemptId || row.attempt_unit !== fixed.runtimeUnitId ||
        row.attempt_epoch !== fixed.executionEpoch || row.pod_uid !== fixed.podUid ||
        row.original_unit !== fixed.runtimeUnitId || row.member_session !== scope.sessionId) { return invalid() }
    const journalEpoch = decimal('journal-epoch', row.journal_epoch)
    const journalSequence = decimal('sequence:journal', row.seq)
    if (journalSequence === '0') { return invalid() }
    const observation = Object.freeze({
      eventId, contextId,
      contextRevision: decimal('context-revision', row.context_revision),
      journalEpoch, journalSequence, state: observedState, classification: contextClass,
      evidenceRef, observedAt: time(body.observedAt), committedAt: time(row.committed_at)
    })
    const key = JSON.stringify([fixed.messageId,fixed.deliveryAttemptId,fixed.runtimeUnitId,
      fixed.attemptId,fixed.executionEpoch,fixed.podUid,fixed.provider,
      fixed.nativeSessionRef,fixed.nativeTurnId])
    if (tupleKey !== undefined && tupleKey !== key) {
      throw new InputStoreError('OBSERVED_TURN_AMBIGUOUS')
    }
    tupleKey = key
    target = fixed
    original ||= contextClass === 'ORIGINAL_EXECUTION'
    provenance.push(observation)
  }
  if (!original || !target) { throw new InputStoreError('OBSERVED_TURN_NO_ORIGINAL') }
  return Object.freeze({ ...target, provenance: Object.freeze(provenance) })
}
