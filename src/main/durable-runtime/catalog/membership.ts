import type { Pool } from 'pg'
import type { RuntimeUnitId, SessionId, WorkspaceId } from '../../../shared/durable-runtime/identity.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { withCatalogReadSnapshot } from './read.ts'
import { CatalogError } from './errors.ts'

export type CatalogMembership = {
  readonly workspaceId: WorkspaceId
  readonly workspaceSessions: readonly SessionId[]
  readonly sessions: readonly SessionId[]
  readonly units: readonly RuntimeUnitId[]
  readonly pairs: readonly { sessionId: SessionId; unitId: RuntimeUnitId }[]
}

/** Includes CLOSED and every peer in a shared Unit. Discovery is not a lock. */
export async function inspectCatalogMembership(tx: DurableTransaction, workspaceId: WorkspaceId): Promise<CatalogMembership> {
  const own = (await tx.query<{ id: SessionId }>(
    'SELECT id FROM durable_runtime.sessions WHERE workspace_id=$1 ORDER BY id', [workspaceId]
  )).rows.map(row => row.id)
  const pairs = (await tx.query<{ session_id: SessionId; runtime_unit_id: RuntimeUnitId }>(`SELECT m.session_id,m.runtime_unit_id
    FROM durable_runtime.runtime_members m WHERE m.runtime_unit_id IN (
      SELECT r.runtime_unit_id FROM durable_runtime.runtime_members r
      JOIN durable_runtime.sessions s ON s.id=r.session_id WHERE s.workspace_id=$1)
    ORDER BY m.session_id,m.runtime_unit_id`, [workspaceId])).rows
  return Object.freeze({ workspaceId, workspaceSessions: Object.freeze(own),
    sessions: Object.freeze([...new Set([...own, ...pairs.map(row => row.session_id)])].sort()),
    units: Object.freeze([...new Set(pairs.map(row => row.runtime_unit_id))].sort()),
    pairs: Object.freeze(pairs.map(row => Object.freeze({ sessionId: row.session_id, unitId: row.runtime_unit_id }))) })
}

export function discoverCatalogMembership(pool: Pool, workspaceId: WorkspaceId): Promise<CatalogMembership> {
  logicalId('workspace', workspaceId)
  return withCatalogReadSnapshot(pool, tx => inspectCatalogMembership(tx, workspaceId))
}

/** Never acquires a new lower-rank lock on a changed membership. */
export async function lockCatalogMembership(tx: DurableTransaction, expected: CatalogMembership): Promise<void> {
  await lockAggregates(tx, { sessionIds: expected.sessions, runtimeUnitIds: expected.units })
  const actual = await inspectCatalogMembership(tx, expected.workspaceId)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {throw new CatalogError('CATALOG_MEMBERSHIP_CHANGED_RETRYABLE')}
}

export function catalogUnitMembers(membership: CatalogMembership, unitId: RuntimeUnitId): readonly SessionId[] {
  return Object.freeze(membership.pairs.filter(pair => pair.unitId === unitId).map(pair => pair.sessionId).sort())
}
