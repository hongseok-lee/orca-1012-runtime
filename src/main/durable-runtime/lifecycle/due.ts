import { RECOVERY_OPERATION_PLANNABLE_SQL } from './recovery-chain.ts'
import type { Pool } from 'pg'
import type { RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { withDurableTransaction } from '../db/connection.ts'

export async function listDueReconciliations(pool: Pool): Promise<RuntimeUnitId[]> {
  return withDurableTransaction(pool, async tx => {
    const due = await tx.query<{ id: string }>(`SELECT u.id FROM durable_runtime.runtime_units u
      WHERE u.reconcile_due_at<=clock_timestamp() OR u.idle_due_at<=clock_timestamp()
      OR EXISTS(SELECT 1 FROM durable_runtime.operations o WHERE o.runtime_unit_id=u.id AND o.result IS NULL AND ${RECOVERY_OPERATION_PLANNABLE_SQL}
        AND (o.deadline_at<=clock_timestamp() OR o.retry_at<=clock_timestamp()))
      OR (u.desired_mode='RUNNING' AND (u.active_attempt_id IS NULL OR u.phase<>'READY'))
      OR (u.desired_mode IN ('SUSPENDED','DELETED') AND u.active_attempt_id IS NOT NULL)
      OR EXISTS(SELECT 1 FROM durable_runtime.messages x JOIN durable_runtime.runtime_members m ON m.session_id=x.session_id
        WHERE m.runtime_unit_id=u.id AND x.intake_status IN ('DURABLE','DISPATCH_INTENT','STAGED') AND x.cancel_requested_at IS NULL)
      ORDER BY u.id`)
    return due.rows.map(row => logicalId('runtime-unit', row.id))
  })
}
