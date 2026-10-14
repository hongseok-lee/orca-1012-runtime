import type { Pool } from 'pg'
import { DurableTransaction, safeDatabaseError } from '../../db/connection.ts'
import { scopeSnapshot, immutable } from './snapshot.ts'
import type { ResourceAuthority, ScopeAuthorizer } from './types.ts'

export type DueResourceReservation = {
  operationId: string; runtimeUnitId: string; targetProfileRevision: string
  expiresAt: string; operationStep: string; originalShape: unknown
  originalFacts: unknown; authority: 'DATA_ONLY'; releaseAuthorized: false
}
/** Expiry is a read reason only. No extension, release, charge decrement,
 * occupancy inference, approved promotion or new target is performed. */
export async function listDueResourceReservations(pool: Pool, input: {
  readonly authority: ResourceAuthority; readonly authorizer: ScopeAuthorizer; readonly limit: number
}): Promise<readonly DueResourceReservation[]> {
  const common = scopeSnapshot(input), limit = input.limit
  if (!Number.isSafeInteger(limit) || limit <= 0) { throw new TypeError('Positive safe integer read limit required') }
  await common.authorize('READ')
  const client = await pool.connect(), tx = new DurableTransaction(client)
  let destroy = false
  try {
    await tx.query('BEGIN READ ONLY')
    const result = await tx.query<DueResourceReservation>(`SELECT r.operation_id AS "operationId",r.runtime_unit_id AS "runtimeUnitId",
      r.resource_profile_revision AS "targetProfileRevision",r.expires_at::text AS "expiresAt",o.step AS "operationStep",
      p.target_pod_shape AS "originalShape",p.facts AS "originalFacts",'DATA_ONLY'::text AS authority,false AS "releaseAuthorized"
      FROM durable_runtime.resource_reservations r
      JOIN durable_runtime.resource_reservation_accounting a ON a.operation_id=r.operation_id
      JOIN durable_runtime.resource_budget_scopes b ON b.scope=a.budget_scope
      JOIN durable_runtime.resource_operation_plans p ON p.operation_id=r.operation_id
      JOIN durable_runtime.operations o ON o.id=r.operation_id
      WHERE b.scope=$1 AND b.dataset_name=$2 AND b.budget_domain_id=$3 AND r.state='RESERVED'
      AND r.expires_at<=clock_timestamp() AND ($4::uuid IS NULL OR r.runtime_unit_id=$4)
      ORDER BY r.expires_at,r.operation_id LIMIT $5`, [common.authority.budgetScope, common.authority.datasetName,
      common.authority.domainIdentity, common.authority.runtimeUnitId, limit])
    await tx.query('COMMIT')
    return immutable(result.rows)
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { destroy = true }
    throw safeDatabaseError(error)
  } finally { tx.close(); client.release(destroy) }
}
