import { DurableDatabaseError } from '../db/connection.ts'
import type { DurableTransaction } from '../db/connection.ts'
import type { OpsOperation } from './contract.ts'
import type { JsonValue } from '../db/atomic.ts'
import type { OpsActor } from './types.ts'
import { requireUnitAccess } from './access.ts'
import { OpsHttpError } from './errors.ts'
export type OpsOperationRow = {
  id: string; runtime_unit_id: string; kind: string; step: string; revision: string
  step_revision: string; intent_revision: string; deadline_at: Date | null; retry_at: Date | null
  result: JsonValue; command_unresolved: boolean
  recovery_root_id?: string | null; recovery_retry_count?: string; recovery_retry_limit?: string
  recovery_retry_at?: Date | null; recovery_deadline_at?: Date | null; recovery_exhausted_reason?: string | null
  recovery_resolved_at?: Date | null; recovery_predecessor_id?: string | null
}
export function opsTime(value: Date | string | null | undefined): string | null {
  if (value == null) { return null }
  const time = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(time.getTime())) { throw new OpsHttpError(503, 'invalid_stored_time', 'The stored observation time is unavailable.') }
  return time.toISOString()
}
export function projectOpsOperation(row: OpsOperationRow): OpsOperation {
  const state = row.result && typeof row.result === 'object' && !Array.isArray(row.result) &&
    typeof row.result.state === 'string' && /^[A-Z0-9_]{1,64}$/.test(row.result.state) ? row.result.state : null
  const failureReason = row.result && typeof row.result==='object' && !Array.isArray(row.result) &&
    typeof row.result.reason==='string' && /^[A-Z0-9_]{1,80}$/.test(row.result.reason) ? row.result.reason : null
  const disposition = row.recovery_exhausted_reason ? 'blocked' : state && ['APPLIED', 'COMPLETED', 'SUCCEEDED', 'DONE'].includes(state) ? 'applied'
    : state && ['FAILED', 'REFUSED', 'SUPERSEDED_BEFORE_ACCEPTANCE'].includes(state) ? 'failed'
      : row.command_unresolved || row.step === 'BLOCKED' || row.step === 'UNKNOWN' ? 'blocked'
        : row.result === null && row.step === 'INTENT_QUEUED' ? 'queued' : 'unverifiable'
  return { id: row.id, runtimeUnitId: row.runtime_unit_id, kind: row.kind, step: row.step,
    revision: row.revision, stepRevision: row.step_revision, intentRevision: row.intent_revision,
    disposition, reason: row.recovery_exhausted_reason ?? (disposition === 'blocked' ? 'UNRESOLVED_COMMAND_OR_OPERATION' : disposition === 'failed' ? failureReason ?? state : null),
    result: row.result === null ? null : { state }, deadlineAt: opsTime(row.deadline_at), retryAt: opsTime(row.retry_at),
    ...(row.recovery_root_id ? {recovery:{rootOperationId:row.recovery_root_id,retryCount:row.recovery_retry_count!,retryLimit:row.recovery_retry_limit!,
      retryAt:opsTime(row.recovery_retry_at),deadlineAt:opsTime(row.recovery_deadline_at),exhaustionReason:row.recovery_exhausted_reason??null,
      resolvedAt:opsTime(row.recovery_resolved_at),predecessorOperationId:row.recovery_predecessor_id??null}} : {}) }
}
export const OPS_OPERATION_SELECT = `SELECT o.id,o.runtime_unit_id,o.kind,o.step,o.revision,o.step_revision,
  o.intent_revision,o.deadline_at,o.retry_at,o.result,o.recovery_root_id,r.retry_count AS recovery_retry_count,
  r.retry_limit AS recovery_retry_limit,r.retry_at AS recovery_retry_at,r.deadline_at AS recovery_deadline_at,
  r.retry_exhausted_reason AS recovery_exhausted_reason,r.recovery_resolved_at,r.recovery_predecessor_id,
  EXISTS(SELECT 1 FROM durable_runtime.runtime_commands c
  WHERE c.operation_id=o.id AND c.runtime_unit_id=o.runtime_unit_id AND c.state IN ('ACCEPTED','EXECUTING','UNKNOWN')) AS command_unresolved
  FROM durable_runtime.operations o LEFT JOIN durable_runtime.operations r ON r.id=o.recovery_root_id`
export async function readOpsOperation(tx: DurableTransaction, actor: OpsActor, id: string): Promise<OpsOperation> {
  const found = await tx.query<OpsOperationRow>(`${OPS_OPERATION_SELECT} WHERE o.id=$1`, [id])
  if (!found.rows[0]) { throw new DurableDatabaseError('OPS_OPERATION_MISSING') }
  await requireUnitAccess(tx, actor, found.rows[0].runtime_unit_id)
  return projectOpsOperation(found.rows[0])
}
