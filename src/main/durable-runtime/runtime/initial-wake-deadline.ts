import { RECOVERY_CHAIN_HEAD_SQL } from '../lifecycle/recovery-chain.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { DurableDatabaseError } from '../db/connection.ts'

/** A slow COLD response is identity evidence, not authority to certify READY
 * after its original finite wake budget. Called under the operation/unit lock.
 * Normal post-READY input has its own dispatch authority, not this startup gate. */
export async function assertInitialWakeDeadline(tx: DurableTransaction, operationId: string): Promise<void> {
  if (!tx.isLockHeld(4, operationId)) { throw new DurableDatabaseError('INITIAL_WAKE_DEADLINE_LOCK') }
  const allowed = await tx.query(`SELECT o.id FROM durable_runtime.operations o
    LEFT JOIN durable_runtime.operations r ON r.id=o.recovery_root_id AND r.runtime_unit_id=o.runtime_unit_id
    WHERE o.id=$1 AND o.kind='WAKE' AND o.deadline_at>clock_timestamp()
      AND (o.recovery_root_id IS NULL OR (r.id IS NOT NULL AND ${RECOVERY_CHAIN_HEAD_SQL} AND r.deadline_at>clock_timestamp() AND r.retry_exhausted_reason IS NULL))`, [operationId])
  if (allowed.rowCount !== 1) { throw new DurableDatabaseError('INITIAL_WAKE_DEADLINE_EXPIRED') }
}
