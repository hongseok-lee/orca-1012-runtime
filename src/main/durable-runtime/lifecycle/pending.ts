import { randomUUID } from 'node:crypto'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { RuntimeUnitId, SessionId } from '../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { RuntimeUnitRow } from '../db/rows.ts'
import { lockAggregates } from '../db/locks.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { ensureIntentOperation } from './intent.ts'
import { lockUnitMembers } from './locks.ts'
import type { LifecyclePolicy, LifecycleOperation } from './types.ts'

/** Joins the actual P1-05 pending rows to their already committed intent. This
 * internal SQL entry creates neither an Input Component nor an input receipt,
 * wake revision, attempt or provider effect. Caller owns transaction/authority. */
export async function joinPendingUnitIntent(tx: DurableTransaction, caller: {
  readonly unitId: RuntimeUnitId
  readonly actorId: string
  readonly discoveredMembers: readonly SessionId[]
  readonly policy: LifecyclePolicy
}): Promise<{ readonly operation: LifecycleOperation; readonly blocked: boolean } | null> {
  const request = Object.freeze({ ...caller, discoveredMembers: Object.freeze([...caller.discoveredMembers]),
    policy: Object.freeze({ ...caller.policy }) })
  if (!request.actorId || !Number.isSafeInteger(request.policy.operationDeadlineMs) || request.policy.operationDeadlineMs <= 0) {
    throw new DurableDatabaseError('LIFECYCLE_REQUEST')
  }
  const members = await lockUnitMembers(tx, request.unitId, request.discoveredMembers)
  const unit = (await tx.query<RuntimeUnitRow & { last_work_event_at: Date | null; idle_due_at: Date | null }>(
    'SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [request.unitId])).rows[0]
  if (unit.desired_mode === 'DELETED') { throw new DurableDatabaseError('LIFECYCLE_UNIT_DELETED') }
  const pending = await tx.query(`SELECT x.id FROM durable_runtime.messages x JOIN durable_runtime.sessions s ON s.id=x.session_id
    WHERE x.session_id=ANY($1::uuid[]) AND s.lifecycle='OPEN' AND x.intake_status IN ('DURABLE','DISPATCH_INTENT','STAGED')
    AND x.cancel_requested_at IS NULL`, [members])
  if (!pending.rowCount) { return null }
  if (unit.desired_mode !== 'RUNNING') { throw new DurableDatabaseError('LIFECYCLE_PENDING_INTENT_MISMATCH') }
  const obsolete = await tx.query<{ id: string }>(`SELECT o.id FROM durable_runtime.operations o
    WHERE o.runtime_unit_id=$1 AND o.kind='SLEEP' AND o.intent_revision<>$2 AND o.result IS NULL AND o.step='INTENT_QUEUED'
    AND NOT EXISTS(SELECT 1 FROM durable_runtime.runtime_commands c WHERE c.operation_id=o.id) ORDER BY o.id`,
    [unit.id, unit.intent_revision])
  await lockAggregates(tx, { operationIds: obsolete.rows.map(row => logicalId('operation', row.id)) })
  await tx.query(`UPDATE durable_runtime.operations SET step='CANCELLED',step_revision=step_revision+1,revision=revision+1,
    result='{"state":"SUPERSEDED_BEFORE_ACCEPTANCE"}'::jsonb WHERE id=ANY($1::uuid[])`, [obsolete.rows.map(row => row.id)])
  const before = await tx.query('SELECT id FROM durable_runtime.operations WHERE runtime_unit_id=$1', [unit.id])
  const selected = await ensureIntentOperation(tx, unit, request.policy)
  // Reused operations keep their exact original name/deadline/retry. No read or
  // repeated reconciliation emits a synthetic activity event or new operation.
  const idleDue = request.policy.idleDurationMs === null || unit.last_work_event_at === null
    ? null : new Date(unit.last_work_event_at.getTime() + request.policy.idleDurationMs)
  if (!before.rows.some(row => row.id === selected.operation.id) || obsolete.rowCount ||
      unit.idle_due_at?.getTime() !== idleDue?.getTime()) {
    const updated = await tx.query<{ revision: string }>(`UPDATE durable_runtime.runtime_units SET revision=revision+1,idle_due_at=$3
      WHERE id=$1 AND revision=$2 RETURNING revision`, [unit.id, unit.revision, idleDue])
    if (updated.rowCount !== 1) { throw new DurableDatabaseError('LIFECYCLE_STALE_REVISION') }
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now
    const event = { kind: 'PENDING_INTENT_JOINED', runtimeUnitId: unit.id, operationId: selected.operation.id,
      intentRevision: unit.intent_revision }
    await appendAudit(tx, { actorId: request.actorId, runtimeUnitId: unit.id, operationId: selected.operation.id,
      kind: 'PENDING_INTENT_JOINED', nextState: event, occurredAt: now, receivedAt: now,
      producerId: unit.id, producerSeq: counter('sequence:producer', updated.rows[0].revision), evidenceRefs: [] })
    await enqueueOutbox(tx, { eventId: logicalId('event', randomUUID()), aggregateId: unit.id,
      aggregateKind: 'runtime-unit', revision: counter('row:runtime-unit', updated.rows[0].revision), event })
  }
  return selected
}
