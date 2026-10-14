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
  const disposition = state && ['APPLIED', 'COMPLETED', 'SUCCEEDED', 'DONE'].includes(state) ? 'applied'
    : state && ['FAILED', 'REFUSED', 'SUPERSEDED_BEFORE_ACCEPTANCE'].includes(state) ? 'failed'
      : row.command_unresolved || row.step === 'BLOCKED' || row.step === 'UNKNOWN' ? 'blocked'
        : row.result === null && row.step === 'INTENT_QUEUED' ? 'queued' : 'unverifiable'
  return { id: row.id, runtimeUnitId: row.runtime_unit_id, kind: row.kind, step: row.step,
    revision: row.revision, stepRevision: row.step_revision, intentRevision: row.intent_revision,
    disposition, reason: disposition === 'blocked' ? 'UNRESOLVED_COMMAND_OR_OPERATION' : disposition === 'failed' ? state : null,
    result: row.result === null ? null : { state }, deadlineAt: opsTime(row.deadline_at), retryAt: opsTime(row.retry_at) }
}
export const OPS_OPERATION_SELECT = `SELECT o.id,o.runtime_unit_id,o.kind,o.step,o.revision,o.step_revision,
  o.intent_revision,o.deadline_at,o.retry_at,o.result,EXISTS(SELECT 1 FROM durable_runtime.runtime_commands c
  WHERE c.operation_id=o.id AND c.runtime_unit_id=o.runtime_unit_id AND c.state IN ('ACCEPTED','EXECUTING','UNKNOWN')) AS command_unresolved
  FROM durable_runtime.operations o`
export async function readOpsOperation(tx: DurableTransaction, actor: OpsActor, id: string): Promise<OpsOperation> {
  const found = await tx.query<OpsOperationRow>(`${OPS_OPERATION_SELECT} WHERE o.id=$1`, [id])
  if (!found.rows[0]) { throw new OpsHttpError(404, 'not_found', 'The operation was not found.') }
  await requireUnitAccess(tx, actor, found.rows[0].runtime_unit_id)
  return projectOpsOperation(found.rows[0])
}
