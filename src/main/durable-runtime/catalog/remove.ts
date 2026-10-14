import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { MutationOutcome } from '../db/atomic.ts'
import { lockAggregates } from '../db/locks.ts'
import type { UnitIntentRequest } from '../lifecycle/types.ts'
import type { PreparedCatalogCall } from './request.ts'
import type { CatalogOwnerEntries } from './owners.ts'
import type { PreparedCatalogClose } from './close.ts'
import { cancelCatalogSessionMessages, captureCatalogClose } from './close.ts'
import { captureCatalogParsed } from './immutable.ts'
import { capturePreparedCatalogCall, lockCatalogWorkspaceMetadata, mutateCatalogWorkspace, publishCatalogMutation } from './mutation.ts'
import { catalogUnitMembers } from './membership.ts'
import { loadCatalogTabs } from './metadata.ts'
import { CatalogError } from './errors.ts'

export type PreparedCatalogRemoval = {
  readonly close: PreparedCatalogClose
  readonly intents: readonly UnitIntentRequest[]
}

/** SQL intent/tombstone only. Original options are retained beside their operation IDs in durable outbox. */
export async function reserveCatalogRemoval(
  pool: Pool, input: PreparedCatalogCall<'worktree.rm'>, prepared: PreparedCatalogRemoval, entries: CatalogOwnerEntries
): Promise<MutationOutcome> {
  const call = capturePreparedCatalogCall(input), close = captureCatalogClose(prepared.close)
  const intents = captureCatalogParsed(prepared.intents) as readonly UnitIntentRequest[]
  const owners = Object.freeze({ ...entries })
  if (intents.some(request => request.desired !== 'DELETED' || request.authority.principalId !== call.context.authority.principalId)) {
    throw new CatalogError('CATALOG_DELETE_AUTHORITY')
  }
  return mutateCatalogWorkspace(pool, call, call.params.worktree, async (tx, workspace, membership) => {
    const unitIds = [...new Set(intents.map(request => request.authority.runtimeUnitId))].sort()
    if (unitIds.length !== intents.length || JSON.stringify(unitIds) !== JSON.stringify(membership.units)) {throw new CatalogError('CATALOG_DELETE_INTENT_SET')}
    // Never widen a Workspace-local removal into deleting a peer Workspace's Unit.
    // Workspace-scoped cleanup of a still-shared Unit needs the root's owner contract.
    if (membership.pairs.some(pair => !membership.workspaceSessions.includes(pair.sessionId))) {
      throw new CatalogError('CATALOG_SHARED_UNIT_REMOVAL_CONTRACT_REQUIRED')
    }
    const operations = (await tx.query<{ id: string }>(
      'SELECT id FROM durable_runtime.operations WHERE runtime_unit_id=ANY($1::uuid[]) ORDER BY id', [unitIds])).rows
    await lockAggregates(tx, { operationIds: operations.map(row => logicalId('operation', row.id)) })
    const tabs = await loadCatalogTabs(tx, workspace.workspace_id)
    const cancelled = new Set<string>()
    for (const tab of tabs.filter(row => row.lifecycle === 'OPEN')) {
      if (tab.session_id === null || cancelled.has(tab.session_id)) {continue}
      await cancelCatalogSessionMessages(tx, call, tab, membership, close, owners)
      cancelled.add(tab.session_id)
    }
    const reserved = []
    for (const request of [...intents].sort((left, right) => left.authority.runtimeUnitId.localeCompare(right.authority.runtimeUnitId))) {
      reserved.push(await owners.recordUnitIntent(tx, { ...request, operationKey: call.operationKey },
        catalogUnitMembers(membership, request.authority.runtimeUnitId)))
    }
    await lockCatalogWorkspaceMetadata(tx, membership)
    for (const sessionId of membership.workspaceSessions) {await tx.query(`UPDATE durable_runtime.sessions
      SET lifecycle='CLOSING',session_fence=session_fence+1,revision=revision+1 WHERE id=$1 AND lifecycle='OPEN'`, [sessionId])}
    await tx.query(`UPDATE durable_runtime.tabs SET lifecycle='CLOSED',closed_at=clock_timestamp(),revision=revision+1
      WHERE workspace_id=$1 AND lifecycle='OPEN'`, [workspace.workspace_id])
    for (const tab of tabs) {await tx.query('UPDATE durable_runtime.catalog_tab_metadata SET payload=$2,updated_at=clock_timestamp() WHERE tab_id=$1',
      [tab.tab_id, JSON.stringify({ ...tab.payload, isActive: false })])}
    await tx.query('UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp(),revision=revision+1 WHERE id=$1', [workspace.workspace_id])
    await tx.query('UPDATE durable_runtime.catalog_name_reservations SET retired=true WHERE workspace_id=$1', [workspace.workspace_id])
    // Full original request/options remain immutable in the outer receipt hash and linked outbox event.
    const detail = { worktreeId: workspace.public_id, originalRequest: call.original,
      operations: reserved.map(intent => ({ ...intent })), physicalDeletionVerified: false }
    await publishCatalogMutation(tx, call, workspace.workspace_id, 'CATALOG_REMOVE_RESERVED', detail)
    return { ...detail, logicalDeleted: true, reservation: 'RESERVED' }
  })
}
