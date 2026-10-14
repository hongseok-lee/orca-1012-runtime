import type { DurableTransaction } from '../db/connection.ts'
import type { RuntimeUnitRow, StorageBindingRow } from '../db/rows.ts'
import { lockAggregates } from '../db/locks.ts'
import type { PreparedCatalogLaunch } from './launch.ts'
import type { PreparedCatalogCall } from './request.ts'
import type { CatalogOwnerEntries } from './owners.ts'
import { inspectCatalogMembership, type CatalogMembership } from './membership.ts'
import { CatalogError } from './errors.ts'

/** Runtime rows common to terminal and structured surfaces; no terminal DTO. */
export type CatalogRuntimeLaunch = Pick<PreparedCatalogLaunch,
  'sessionId' | 'agent' | 'unit' | 'storage' | 'policy'> & {
  readonly workspace: Pick<PreparedCatalogLaunch['workspace'], 'id'>
}

export async function insertUnpublishedLaunchRows(tx: DurableTransaction, launch: CatalogRuntimeLaunch, initialFence?: 1): Promise<void> {
  if (launch.agent.create) {await tx.query('INSERT INTO durable_runtime.agents(id,provider) VALUES($1,$2)', [launch.agent.id, launch.agent.provider])}
  const agent = (await tx.query<{ provider: string }>('SELECT provider FROM durable_runtime.agents WHERE id=$1', [launch.agent.id])).rows[0]
  if (agent?.provider !== launch.agent.provider) {throw new CatalogError('CATALOG_AGENT_CONFIGURATION')}
  await tx.query(initialFence === 1
    ? "INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle,session_fence) VALUES($1,$2,$3,'OPEN',1)"
    : "INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')",
  [launch.sessionId, launch.agent.id, launch.workspace.id])
  if (launch.unit.create) {await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [launch.unit.id])}
}

export async function insertMembershipAndIntent(
  tx: DurableTransaction, launch: CatalogRuntimeLaunch, call: Pick<PreparedCatalogCall, 'context' | 'operationKey'>,
  expected: CatalogMembership, unitPeers: readonly typeof launch.sessionId[], owners: CatalogOwnerEntries
) {
  await lockAggregates(tx, { sessionIds: [...new Set([...expected.sessions, ...unitPeers])].sort(),
    runtimeUnitIds: [...new Set([...expected.units, launch.unit.id])].sort() })
  if (JSON.stringify(await inspectCatalogMembership(tx, launch.workspace.id)) !== JSON.stringify(expected)) {
    throw new CatalogError('CATALOG_MEMBERSHIP_CHANGED_RETRYABLE')
  }
  const actualPeers = (await tx.query<{ session_id: typeof launch.sessionId }>(
    'SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1 ORDER BY session_id', [launch.unit.id])).rows.map(row => row.session_id)
  if (JSON.stringify(actualPeers) !== JSON.stringify(unitPeers)) {throw new CatalogError('CATALOG_MEMBERSHIP_CHANGED_RETRYABLE')}
  await lockAggregates(tx, { storageDomains: [{ backendId: launch.storage.backendId, exportId: launch.storage.exportId }] })
  // The domain lock serializes exact-tuple selection and creation in this
  // mutation. Reusing a canonical binding never changes proof, epoch or writer
  // state, and never grants concurrent physical access to the shared directory.
  let storage: StorageBindingRow | undefined
  if (launch.storage.createUnverified) {
    storage = (await tx.query<StorageBindingRow>(`SELECT * FROM durable_runtime.storage_bindings
      WHERE backend_id=$1 AND export_id=$2 AND canonical_directory=$3`,
    [launch.storage.backendId, launch.storage.exportId, launch.storage.canonicalDirectory])).rows[0]
    if (!storage) {
      storage = (await tx.query<StorageBindingRow>(`INSERT INTO durable_runtime.storage_bindings
        (id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,$3,$4,'UNVERIFIED') RETURNING *`,
      [launch.storage.id, launch.storage.backendId, launch.storage.exportId, launch.storage.canonicalDirectory])).rows[0]
    }
  } else {
    storage = (await tx.query<StorageBindingRow>('SELECT * FROM durable_runtime.storage_bindings WHERE id=$1', [launch.storage.id])).rows[0]
  }
  if (!storage || storage.backend_id !== launch.storage.backendId || storage.export_id !== launch.storage.exportId ||
    storage.canonical_directory !== launch.storage.canonicalDirectory) {throw new CatalogError('CATALOG_STORAGE_CONFIGURATION')}
  await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)',
    [launch.unit.id, launch.sessionId, storage.id])
  const unit = (await tx.query<RuntimeUnitRow>('SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [launch.unit.id])).rows[0]
  if (!unit || (launch.unit.create && (unit.phase !== 'ABSENT' || unit.active_attempt_id !== null))) {throw new CatalogError('CATALOG_UNIT_CONFIGURATION')}
  if (launch.unit.authority.principalId !== call.context.authority.principalId) {throw new CatalogError('CATALOG_LAUNCH_AUTHORITY')}
  return owners.recordUnitIntent(tx, { authority: launch.unit.authority, desired: 'RUNNING',
    operationKey: call.operationKey, expectedRevision: unit.revision, expectedIntentRevision: unit.intent_revision,
    policy: launch.policy }, [...unitPeers, launch.sessionId].sort())
}

export function withUnpublishedIds(membership: CatalogMembership, launch: CatalogRuntimeLaunch): CatalogMembership {
  // New Session exists but is not yet a runtime member. Its actual row lock is still mandatory.
  return Object.freeze({ ...membership,
    workspaceSessions: Object.freeze([...membership.workspaceSessions, launch.sessionId].sort()),
    sessions: Object.freeze([...new Set([...membership.sessions, launch.sessionId])].sort()) })
}
