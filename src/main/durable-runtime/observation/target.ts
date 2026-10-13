import type { DurableTransaction } from '../db/connection.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { RuntimeUnitRow } from '../db/rows.ts'
import { snapshotObservationTarget } from './snapshot.ts'
import type { ObservationTarget } from './types.ts'

/** A same-TX binding check. The caller already holds every Session and the Unit;
 * this function never acquires a lower-ranked row or manufactures an episode. */
export async function assertCurrentObservationTarget(
  tx: DurableTransaction, caller: ObservationTarget
): Promise<RuntimeUnitRow> {
  const target = snapshotObservationTarget(caller)
  if (!tx.isLockHeld(2, target.runtimeUnitId)) {
    throw new DurableDatabaseError('OBSERVATION_UNIT_LOCK_REQUIRED')
  }
  const rows = await tx.query<RuntimeUnitRow>(`SELECT u.* FROM durable_runtime.runtime_units u
    JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id
    WHERE u.id=$1 AND u.active_attempt_id=$2 AND u.execution_epoch=$4
    AND a.runtime_unit_id=u.id AND a.id=$2 AND a.pod_uid=$3 AND a.execution_epoch=$4`,
    [target.runtimeUnitId, target.attemptId, target.podUid, target.executionEpoch])
  if (rows.rowCount !== 1) { throw new DurableDatabaseError('OBSERVATION_TARGET_STALE') }
  return rows.rows[0]
}
