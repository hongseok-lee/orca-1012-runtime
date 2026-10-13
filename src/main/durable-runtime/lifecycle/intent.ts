import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { SessionId } from '../../../shared/durable-runtime/identity.ts'
import { runDurableMutation } from '../db/atomic.ts'
import { DurableDatabaseError, type DurableTransaction } from '../db/connection.ts'
import type { RuntimeUnitRow } from '../db/rows.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { discoverUnitMembers, lockUnitMembers } from './locks.ts'
import type { IntentRecorded, IntentMutation, LifecycleOperation, UnitIntentRequest } from './types.ts'

export const LIFECYCLE_CONTROLLER_SCOPE = 'orca-serve:orca-1012-dev-v1'

function validate(request: UnitIntentRequest): void {
  const { authority, policy } = request
  logicalId('runtime-unit', authority.runtimeUnitId)
  counter('row:runtime-unit', request.expectedRevision)
  counter('intent-revision', request.expectedIntentRevision)
  if (!authority.principalId || !authority.scope || !request.operationKey ||
      !['RUNNING', 'DELETED'].includes(request.desired) ||
      !Number.isSafeInteger(policy.operationDeadlineMs) || policy.operationDeadlineMs <= 0 ||
      (policy.idleDurationMs !== null && (!Number.isSafeInteger(policy.idleDurationMs) || policy.idleDurationMs <= 0))) {
    throw new DurableDatabaseError('LIFECYCLE_REQUEST')
  }
}
export async function initializeLifecycleScope(tx: DurableTransaction): Promise<void> {
  // Reception observes a term; it does not acquire execution ownership or extend
  // an existing lease. Lease-only controller takeover must not lock aggregates later.
  await tx.query(`INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at)
    VALUES($1,'unowned',0,'epoch') ON CONFLICT(scope) DO NOTHING`, [LIFECYCLE_CONTROLLER_SCOPE])
}

async function chooseOperation(
  tx: DurableTransaction, unit: RuntimeUnitRow, request: UnitIntentRequest
): Promise<{ operation: LifecycleOperation; blocked: boolean }> {
  const blocker = await tx.query<LifecycleOperation>(`SELECT o.* FROM durable_runtime.runtime_commands c
    JOIN durable_runtime.operations o ON o.id=c.operation_id AND o.runtime_unit_id=c.runtime_unit_id
    WHERE c.runtime_unit_id=$1 AND c.state IN ('ACCEPTED','EXECUTING','UNKNOWN')`, [unit.id])
  if (blocker.rows[0]) {
    return { operation: blocker.rows[0], blocked: true }
  }
  const kind = request.desired === 'RUNNING' ? 'WAKE' : 'DELETE'
  const existing = await tx.query<LifecycleOperation>(`SELECT * FROM durable_runtime.operations
    WHERE runtime_unit_id=$1 AND intent_revision=$2 AND kind=$3 AND result IS NULL ORDER BY id`,
    [unit.id, unit.intent_revision, kind])
  if (existing.rowCount! > 1) {
    throw new DurableDatabaseError('LIFECYCLE_OPERATION_CONFLICT')
  }
  if (existing.rows[0]) {
    return { operation: existing.rows[0], blocked: false }
  }
  // A previously started unresolved operation is not bypassed by a new name.
  const started = await tx.query<LifecycleOperation>(`SELECT * FROM durable_runtime.operations
    WHERE runtime_unit_id=$1 AND result IS NULL AND step<>'INTENT_QUEUED' ORDER BY id`, [unit.id])
  if (started.rows[0]) {
    return { operation: started.rows[0], blocked: true }
  }
  await initializeLifecycleScope(tx)
  const operationId = logicalId('operation', randomUUID())
  const inserted = await tx.query<LifecycleOperation>(`INSERT INTO durable_runtime.operations
    (id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,
     execution_epoch,expected_pod_uid,external_resource_name,deadline_at)
    SELECT $1,u.id,$3,u.intent_revision,c.scope,c.term,'INTENT_QUEUED',u.execution_epoch,a.pod_uid,$4,
      clock_timestamp()+$5::bigint*interval '1 millisecond'
    FROM durable_runtime.runtime_units u JOIN durable_runtime.controller_leases c ON c.scope=$6
    LEFT JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id
    WHERE u.id=$2 RETURNING *`,
    [operationId, unit.id, kind, `orca-unit-${operationId}`, request.policy.operationDeadlineMs, LIFECYCLE_CONTROLLER_SCOPE])
  return { operation: inserted.rows[0], blocked: false }
}

/** Same-transaction Catalog entry. Records intent, never invokes an actuator. */
export async function recordUnitIntent(
  tx: DurableTransaction, request: UnitIntentRequest, discoveredMembers: readonly SessionId[]
): Promise<IntentRecorded> {
  validate(request)
  const id = request.authority.runtimeUnitId
  const members = await lockUnitMembers(tx, id, discoveredMembers)
  const state = await tx.query<RuntimeUnitRow>('SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [id])
  const before = state.rows[0]
  if (!before || before.desired_mode === 'DELETED') {
    throw new DurableDatabaseError('LIFECYCLE_UNIT_DELETED')
  }
  if (before.revision !== request.expectedRevision || before.intent_revision !== request.expectedIntentRevision) {
    throw new DurableDatabaseError('LIFECYCLE_STALE_REVISION')
  }
  if (request.desired === 'RUNNING' && members.length) {
    const open = await tx.query(`SELECT id FROM durable_runtime.sessions WHERE id=ANY($1::uuid[]) AND lifecycle='OPEN'`, [members])
    if (!open.rowCount) {
      throw new DurableDatabaseError('LIFECYCLE_SESSIONS_CLOSED')
    }
  }
  const shared = before.desired_mode === request.desired
  const updated = await tx.query<RuntimeUnitRow>(`UPDATE durable_runtime.runtime_units
    SET desired_mode=$2,intent_revision=intent_revision+CASE WHEN desired_mode=$2 THEN 0 ELSE 1 END,
      phase=CASE WHEN $2='DELETED' THEN 'DELETING' ELSE phase END,
      reconcile_due_at=LEAST(COALESCE(reconcile_due_at,clock_timestamp()),clock_timestamp()),revision=revision+1
    WHERE id=$1 AND revision=$3 AND intent_revision=$4 AND desired_mode<>'DELETED' RETURNING *`,
    [id, request.desired, request.expectedRevision, request.expectedIntentRevision])
  if (updated.rowCount !== 1) {
    throw new DurableDatabaseError('LIFECYCLE_STALE_REVISION')
  }
  const unit = updated.rows[0]
  const selected = await chooseOperation(tx, unit, request)
  const result: IntentRecorded = {
    runtimeUnitId: id, desired: unit.desired_mode, intentRevision: unit.intent_revision,
    revision: unit.revision, operationId: selected.operation.id, sharedIntent: shared,
    executionDisposition: selected.blocked ? 'BLOCKED_BY_UNRESOLVED_COMMAND' : 'QUEUED'
  }
  const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now
  await appendAudit(tx, {
    actorId: request.authority.principalId, runtimeUnitId: id, operationId: selected.operation.id,
    kind: 'UNIT_INTENT_RECORDED', previousState: { desired: before.desired_mode, intentRevision: before.intent_revision },
    nextState: { ...result }, occurredAt: now, receivedAt: now,
    producerId: id, producerSeq: counter('sequence:producer', unit.revision), evidenceRefs: []
  })
  await enqueueOutbox(tx, {
    eventId: logicalId('event', randomUUID()), aggregateId: id, aggregateKind: 'runtime-unit',
    revision: unit.revision, event: { kind: 'UNIT_INTENT_RECORDED', ...result }
  })
  return result
}

/** Authenticated unit scope is supplied first. P1-03 receipt-first replay skips
 * current intent/lifecycle checks, and alone owns uncertain COMMIT resolution. */
export async function requestUnitIntent(pool: Pool, request: UnitIntentRequest): Promise<IntentMutation> {
  validate(request)
  const payload = JSON.stringify([request.authority.runtimeUnitId, request.authority.scope,
    request.desired, request.expectedRevision, request.expectedIntentRevision,
    request.policy.operationDeadlineMs, request.policy.idleDurationMs])
  const identity = {
    key: { principalId: request.authority.principalId, sessionScope: request.authority.scope,
      method: 'lifecycle.request-unit-intent', operationKey: request.operationKey },
    payloadHash: createHash('sha256').update(payload).digest('hex')
  }
  const members = await discoverUnitMembers(pool, request.authority.runtimeUnitId)
  return runDurableMutation(pool, { ...identity, locks: {
    sessionIds: members, runtimeUnitIds: [request.authority.runtimeUnitId]
  } }, async tx => ({ ...await recordUnitIntent(tx, request, members) }))
}
