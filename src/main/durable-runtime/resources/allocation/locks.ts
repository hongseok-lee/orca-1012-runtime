import type { DurableTransaction } from '../../db/connection.ts'
import { DurableDatabaseError } from '../../db/connection.ts'
import type { ControllerAuthority } from '../../lifecycle/types.ts'
import { decimal } from './snapshot.ts'
import type { ResourceAuthority } from './types.ts'

export async function lockController(tx: DurableTransaction, controller: ControllerAuthority): Promise<void> {
  if (!tx.isLockHeld(5, controller.scope)) {
    tx.advanceLock(5, controller.scope)
    const row = await tx.query('SELECT scope FROM durable_runtime.controller_leases WHERE scope=$1 FOR UPDATE', [controller.scope])
    if (row.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_LEASE_MISSING') }
    tx.markLockAcquired(5, controller.scope)
  }
  // A separate statement AFTER the row-lock wait evaluates actual DB time.
  await requireLiveController(tx, controller)
}
export async function requireLiveController(tx: DurableTransaction, controller: ControllerAuthority): Promise<void> {
  const live = await tx.query(`SELECT scope FROM durable_runtime.controller_leases
    WHERE scope=$1 AND owner=$2 AND term=$3 AND expires_at>clock_timestamp()`,
    [controller.scope, controller.owner, decimal(controller.term)])
  if (live.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_STALE_LEASE') }
}
export async function lockBudget(tx: DurableTransaction, authority: ResourceAuthority): Promise<void> {
  const scope = authority.budgetScope
  if (tx.isLockHeld(11, scope)) { return }
  tx.advanceLock(11, scope)
  const row = await tx.query<{ dataset_name: string; budget_domain_id: string; memory_limit_bytes: string; cpu_limit_millicores: string }>(
    'SELECT dataset_name,budget_domain_id,memory_limit_bytes,cpu_limit_millicores FROM durable_runtime.resource_budget_scopes WHERE scope=$1 FOR UPDATE', [scope])
  if (row.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_BUDGET_SCOPE_MISSING') }
  if (row.rows[0].dataset_name !== authority.datasetName || row.rows[0].budget_domain_id !== authority.domainIdentity) {
    throw new DurableDatabaseError('RESOURCE_BUDGET_SCOPE_BINDING')
  }
  decimal(row.rows[0].memory_limit_bytes); decimal(row.rows[0].cpu_limit_millicores)
  tx.markLockAcquired(11, scope)
}
export function requireScopeLock(tx: DurableTransaction, scope: string): void {
  if (!tx.isLockHeld(11, scope)) { throw new DurableDatabaseError('RESOURCE_BUDGET_LOCK_REQUIRED') }
}
