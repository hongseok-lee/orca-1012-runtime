import { randomUUID } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { AttemptId, RuntimeUnitId, SessionId, RowRevision, IntentRevision } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, type DurableTransaction } from '../db/connection.ts'
import type { RuntimeUnitRow } from '../db/rows.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { ensureIntentOperation } from './intent.ts'
import { lockUnitMembers } from './locks.ts'
import type { IntentRecorded, LifecyclePolicy } from './types.ts'

declare const activityEvidence: unique symbol
// Authentication/collection and pinning are outside the SQL transaction. No
// production verifier/factory is supplied; absent evidence means UNKNOWN.
export type PreparedMemberActivity = {
  readonly [activityEvidence]: true
  readonly sessionId: SessionId
  readonly attemptId: AttemptId
  readonly podUid: string
  readonly executionEpoch: string
  readonly observedAt: Date
  readonly producerCommittedWatermark: string
  readonly observedWatermark: string
  readonly sourceEvidenceRef: string
  readonly activeTurn: boolean
  readonly activeTool: boolean
  readonly backgroundWriter: boolean
  readonly inFlightDispatch: boolean
}
export type LifecycleActivityAuthority = {
  // Only immutable prepared local data; no Promise or provider/filesystem I/O.
  member(sessionId: SessionId, attemptId: AttemptId): PreparedMemberActivity | null
  pinValid(evidence: PreparedMemberActivity): boolean
}
export type SleepReservation =
  | { readonly status: 'RESERVED'; readonly intent: IntentRecorded }
  | { readonly status: 'DEFERRED'; readonly reason: 'RUNNABLE_PENDING' | 'IN_FLIGHT_DISPATCH' | 'MEMBER_ACTIVE' | 'WRITER_UNVERIFIABLE' | 'SESSION_CLOSING' | 'UNRESOLVED_COMMAND' }

export type SleepReservationRequest = {
  readonly unitId: RuntimeUnitId
  readonly actorId: string
  readonly discoveredMembers: readonly SessionId[]
  readonly expectedRevision: RowRevision<'runtime-unit'>
  readonly expectedIntentRevision: IntentRevision
  readonly policy: LifecyclePolicy
  readonly activityFreshnessMs: number
  readonly activity: LifecycleActivityAuthority | null
}

/** Catalog composes this SQL-only entry with its own P1-03 receipt transaction.
 * No hidden commit, provider stop, new grant or physical-fence proof occurs. */
export async function reserveSleep(tx: DurableTransaction, request: SleepReservationRequest): Promise<SleepReservation> {
  const source = request.activity
  const input: SleepReservationRequest = Object.freeze({
    ...request,
    discoveredMembers: Object.freeze([...request.discoveredMembers]),
    policy: Object.freeze({ ...request.policy }),
    activity: source === null ? null : Object.freeze({
      member: source.member.bind(source), pinValid: source.pinValid.bind(source)
    })
  })
  logicalId('runtime-unit', input.unitId)
  counter('row:runtime-unit', input.expectedRevision)
  counter('intent-revision', input.expectedIntentRevision)
  if (!Number.isSafeInteger(input.activityFreshnessMs) || input.activityFreshnessMs <= 0 ||
      !Number.isSafeInteger(input.policy.operationDeadlineMs) || input.policy.operationDeadlineMs <= 0 ||
      typeof input.actorId !== 'string' || !input.actorId) {
    throw new DurableDatabaseError('LIFECYCLE_POLICY')
  }
  const members = await lockUnitMembers(tx, input.unitId, input.discoveredMembers)
  const rows = await tx.query<RuntimeUnitRow & { pod_uid: string | null; now: Date }>(`SELECT u.*,a.pod_uid,clock_timestamp() AS now
    FROM durable_runtime.runtime_units u LEFT JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id WHERE u.id=$1`, [input.unitId])
  const unit = rows.rows[0]
  if (unit.desired_mode === 'DELETED') {
    throw new DurableDatabaseError('LIFECYCLE_UNIT_DELETED')
  }
  if (unit.revision !== input.expectedRevision || unit.intent_revision !== input.expectedIntentRevision) {
    throw new DurableDatabaseError('LIFECYCLE_STALE_REVISION')
  }
  // CLOSED memberships remain in every lock and current writer/dispatch check.
  // CLOSED alone is not permanent busy; CLOSING still means unfinished cleanup.
  const closing = await tx.query("SELECT id FROM durable_runtime.sessions WHERE id=ANY($1::uuid[]) AND lifecycle='CLOSING'", [members])
  if (closing.rowCount) { return { status: 'DEFERRED', reason: 'SESSION_CLOSING' } }
  const pending = await tx.query(`SELECT x.id FROM durable_runtime.messages x JOIN durable_runtime.sessions s ON s.id=x.session_id
    WHERE x.session_id=ANY($1::uuid[]) AND s.lifecycle='OPEN'
    AND x.intake_status IN ('DURABLE','DISPATCH_INTENT','STAGED') AND x.cancel_requested_at IS NULL`, [members])
  if (pending.rowCount) { return { status: 'DEFERRED', reason: 'RUNNABLE_PENDING' } }
  const inFlight = await tx.query(`SELECT d.id FROM durable_runtime.delivery_attempts d JOIN durable_runtime.attempts a ON a.id=d.attempt_id
    WHERE d.session_id=ANY($1::uuid[]) AND (d.state IN ('DISPATCH_INTENT','STAGED','EFFECT_POSSIBLE','ADMITTED')
    OR (d.state='UNKNOWN' AND a.stopped_at IS NULL))`, [members])
  if (inFlight.rowCount) { return { status: 'DEFERRED', reason: 'IN_FLIGHT_DISPATCH' } }
  const unresolved = await tx.query(`SELECT id FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1 AND state IN ('ACCEPTED','EXECUTING','UNKNOWN')`, [unit.id])
  if (unresolved.rowCount) { return { status: 'DEFERRED', reason: 'UNRESOLVED_COMMAND' } }
  if (unit.active_attempt_id) {
    for (const sessionId of members) {
      let work: PreparedMemberActivity | null = null
      let pinValid = false
      try {
        work = input.activity?.member(sessionId, unit.active_attempt_id) ?? null
        if (work) { pinValid = input.activity?.pinValid(work) === true }
      } catch { /* unknown */ }
      if (!work || !Object.isFrozen(work) || !pinValid ||
          work.sessionId !== sessionId || work.attemptId !== unit.active_attempt_id || work.podUid !== unit.pod_uid ||
          work.executionEpoch !== unit.execution_epoch || !work.sourceEvidenceRef ||
          work.observedWatermark !== work.producerCommittedWatermark ||
          !Number.isFinite(work.observedAt.getTime()) || work.observedAt > unit.now ||
          unit.now.getTime() - work.observedAt.getTime() > input.activityFreshnessMs) {
        return { status: 'DEFERRED', reason: 'WRITER_UNVERIFIABLE' }
      }
      if (work.activeTurn || work.activeTool || work.backgroundWriter || work.inFlightDispatch) {
        return { status: 'DEFERRED', reason: 'MEMBER_ACTIVE' }
      }
    }
    if (!members.length) { return { status: 'DEFERRED', reason: 'WRITER_UNVERIFIABLE' } }
  } else {
    const writer = await tx.query(`SELECT id FROM durable_runtime.execution_grants
      WHERE runtime_unit_id=$1 AND state IN ('RESERVED','ACTIVE','REVOKING')`, [unit.id])
    if (writer.rowCount) { return { status: 'DEFERRED', reason: 'WRITER_UNVERIFIABLE' } }
  }
  const changed = await tx.query<RuntimeUnitRow>(`UPDATE durable_runtime.runtime_units SET desired_mode='SUSPENDED',phase='QUIESCING',
    intent_revision=intent_revision+CASE WHEN desired_mode='SUSPENDED' THEN 0 ELSE 1 END,revision=revision+1,
    reconcile_due_at=clock_timestamp() WHERE id=$1 AND revision=$2 AND intent_revision=$3 RETURNING *`,
    [unit.id, input.expectedRevision, input.expectedIntentRevision])
  if (changed.rowCount !== 1) { throw new DurableDatabaseError('LIFECYCLE_STALE_REVISION') }
  const after = changed.rows[0]
  const selected = await ensureIntentOperation(tx, after, input.policy)
  const intent: IntentRecorded = { runtimeUnitId: unit.id, desired: 'SUSPENDED', intentRevision: after.intent_revision,
    revision: after.revision, operationId: selected.operation.id, sharedIntent: unit.desired_mode === 'SUSPENDED',
    executionDisposition: selected.blocked ? 'BLOCKED_BY_UNRESOLVED_COMMAND' : 'QUEUED' }
  await appendAudit(tx, { actorId: input.actorId, runtimeUnitId: unit.id, operationId: selected.operation.id,
    kind: 'SLEEP_RESERVED', previousState: { desired: unit.desired_mode, intentRevision: unit.intent_revision },
    nextState: { ...intent }, occurredAt: unit.now, receivedAt: unit.now, producerId: unit.id,
    producerSeq: counter('sequence:producer', after.revision), evidenceRefs: [] })
  await enqueueOutbox(tx, { eventId: logicalId('event', randomUUID()), aggregateId: unit.id,
    aggregateKind: 'runtime-unit', revision: after.revision, event: { kind: 'SLEEP_RESERVED', ...intent } })
  return { status: 'RESERVED', intent }
}
