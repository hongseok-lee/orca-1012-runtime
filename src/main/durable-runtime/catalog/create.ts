import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { makePaneKey } from '../../../shared/stable-pane-id.ts'
import { selectSuggestedCreatureName, normalizeSuggestedName } from '../../../shared/worktree-name-suggestion.ts'
import type { CatalogNameReservationRow, RuntimeUnitRow, StorageBindingRow } from '../db/rows.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { runDurableMutation, type MutationOutcome } from '../db/atomic.ts'
import { lockAggregates } from '../db/locks.ts'
import { catalogReceiptIdentity, type PreparedCatalogCall, type ResolvedCatalogScope } from './request.ts'
import { capturePreparedCatalogCall, resolveCatalogMutation, publishCatalogMutation } from './mutation.ts'
import { inspectCatalogMembership, type CatalogMembership } from './membership.ts'
import { captureCatalogLaunch, type PreparedCatalogLaunch } from './launch.ts'
import type { CatalogOwnerEntries } from './owners.ts'
import { lockCatalogMetadata } from './heads.ts'
import { captureCatalogJson } from './immutable.ts'
import { parseCatalogWorkspace, parseCatalogTab } from './payload.ts'
import { withCatalogReadSnapshot } from './read.ts'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree.ts'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types.ts'
import { readWorkspaceTabsInTransaction } from './projection.ts'
import { loadCatalogTabs } from './metadata.ts'
import { CatalogError } from './errors.ts'

async function insertUnpublishedLaunchRows(tx: DurableTransaction, launch: PreparedCatalogLaunch): Promise<void> {
  if (launch.agent.create) {await tx.query('INSERT INTO durable_runtime.agents(id,provider) VALUES($1,$2)', [launch.agent.id, launch.agent.provider])}
  const agent = (await tx.query<{ provider: string }>('SELECT provider FROM durable_runtime.agents WHERE id=$1', [launch.agent.id])).rows[0]
  if (agent?.provider !== launch.agent.provider) {throw new CatalogError('CATALOG_AGENT_CONFIGURATION')}
  await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')",
    [launch.sessionId, launch.agent.id, launch.workspace.id])
  if (launch.unit.create) {await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [launch.unit.id])}
}

async function insertMembershipAndIntent(
  tx: DurableTransaction, launch: PreparedCatalogLaunch, call: PreparedCatalogCall,
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
  if (launch.storage.createUnverified) {
    // The null proof/verification and no-grant boundary is intentional.
    await tx.query(`INSERT INTO durable_runtime.storage_bindings
      (id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,$3,$4,'UNVERIFIED')`,
      [launch.storage.id, launch.storage.backendId, launch.storage.exportId, launch.storage.canonicalDirectory])
  }
  const storage = (await tx.query<StorageBindingRow>('SELECT * FROM durable_runtime.storage_bindings WHERE id=$1', [launch.storage.id])).rows[0]
  if (!storage || storage.backend_id !== launch.storage.backendId || storage.export_id !== launch.storage.exportId ||
    storage.canonical_directory !== launch.storage.canonicalDirectory) {throw new CatalogError('CATALOG_STORAGE_CONFIGURATION')}
  await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)',
    [launch.unit.id, launch.sessionId, launch.storage.id])
  const unit = (await tx.query<RuntimeUnitRow>('SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [launch.unit.id])).rows[0]
  if (!unit || (launch.unit.create && (unit.phase !== 'ABSENT' || unit.active_attempt_id !== null))) {throw new CatalogError('CATALOG_UNIT_CONFIGURATION')}
  if (launch.unit.authority.principalId !== call.context.authority.principalId) {throw new CatalogError('CATALOG_LAUNCH_AUTHORITY')}
  return owners.recordUnitIntent(tx, { authority: launch.unit.authority, desired: 'RUNNING',
    operationKey: call.operationKey, expectedRevision: unit.revision, expectedIntentRevision: unit.intent_revision,
    policy: launch.policy }, [...unitPeers, launch.sessionId].sort())
}

async function insertCatalogTerminal(tx: DurableTransaction, launch: PreparedCatalogLaunch, launchToken: string | null): Promise<void> {
  const tab = launch.tab
  // Native provider IDs are absent; this is the logical terminal surface only.
  await tx.query(`INSERT INTO durable_runtime.tabs
    (id,workspace_id,session_id,kind,terminal_handle,leaf_id,pane_key,ui_order,lifecycle)
    VALUES($1,$2,$3,'terminal',$4,$5,$6,$7,'OPEN')`, [tab.id, launch.workspace.id, launch.sessionId,
      tab.terminalHandle, tab.leafId, makePaneKey(tab.parentTabId, tab.leafId), tab.uiOrder])
  await tx.query(`INSERT INTO durable_runtime.catalog_tab_metadata
    (tab_id,public_tab_id,payload,launch_request,launch_token) VALUES($1,$2,$3,$4,$5)`,
    [tab.id, tab.publicId, JSON.stringify(tab.payload), JSON.stringify(launch.launchRequest), launchToken])
}

function withUnpublishedIds(membership: CatalogMembership, launch: PreparedCatalogLaunch): CatalogMembership {
  // New Session exists but is not yet a runtime member. Its actual row lock is still mandatory.
  return Object.freeze({ ...membership,
    workspaceSessions: Object.freeze([...membership.workspaceSessions, launch.sessionId].sort()),
    sessions: Object.freeze([...new Set([...membership.sessions, launch.sessionId])].sort()) })
}

export async function reserveCatalogWorkspace(
  pool: Pool, input: PreparedCatalogCall<'worktree.create'>, prepared: PreparedCatalogLaunch, entries: CatalogOwnerEntries
): Promise<MutationOutcome> {
  const call = capturePreparedCatalogCall(input), launch = captureCatalogLaunch(prepared)
  const owners = Object.freeze({ ...entries })
  const workspace = launch.workspace
  const namespace = workspace.repoId ?? workspace.projectGroupId
  if (!namespace || !(workspace.repoId ? call.context.authority.repositoryIds.includes(namespace) : call.context.authority.projectGroupIds.includes(namespace))) {
    throw new CatalogError('CATALOG_CREATE_SCOPE')
  }
  const scope = `${workspace.repoId ? 'repo' : 'group'}:${namespace}` as ResolvedCatalogScope
  // Canonical routing is resolved without rejecting tombstones before receipt replay.
  const selector = call.params.repo.startsWith('id:') ? call.params.repo.slice(3) : call.params.repo
  const selectedIds = await withCatalogReadSnapshot(pool, async tx => {
    if (!workspace.repoId) {return (await tx.query<{ id: string }>(
      'SELECT id FROM durable_runtime.catalog_project_groups WHERE id=$1', [selector])).rows.map(row => row.id)}
    return (await tx.query<{ id: string; payload: Record<string, unknown> }>(
      'SELECT id,payload FROM durable_runtime.catalog_repositories')).rows.filter(row =>
      call.context.authority.repositoryIds.includes(row.id) &&
      (row.id === selector || row.payload.path === selector || row.payload.displayName === selector)).map(row => row.id)
  })
  if (selectedIds.length !== 1) {throw new CatalogError(selectedIds.length ? 'CATALOG_REPO_AMBIGUOUS' : 'CATALOG_REPO_NOT_FOUND')}
  if (selectedIds[0] !== namespace) {throw new CatalogError('CATALOG_PREPARED_PROJECT_MISMATCH')}
  // No lifecycle/state lookup before receipt-first replay; prepared identities may differ on a retry.
  return runDurableMutation(pool, { ...catalogReceiptIdentity(call, scope), locks: {} }, async tx => {
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,$3,'PENDING')",
      [workspace.id, workspace.publicId, workspace.reservedName])
    await insertUnpublishedLaunchRows(tx, launch)
    // Discover shared peers without marking any unacquired locks.
    const initial = await inspectCatalogMembership(tx, workspace.id)
    const peerRows = (await tx.query<{ session_id: typeof launch.sessionId }>(
      'SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1 ORDER BY session_id', [launch.unit.id])).rows
    const intent = await insertMembershipAndIntent(tx, launch, call, initial, peerRows.map(row => row.session_id), owners)
    await lockCatalogMetadata(tx, [`namespace:${namespace}`, `workspace:${workspace.id}`])
    const registered = workspace.repoId
      ? (await tx.query<{ payload: { kind?: string } }>('SELECT payload FROM durable_runtime.catalog_repositories WHERE id=$1 AND deleted_at IS NULL', [workspace.repoId])).rows[0]
      : (await tx.query('SELECT id FROM durable_runtime.catalog_project_groups WHERE id=$1 AND deleted_at IS NULL', [workspace.projectGroupId])).rows[0]
    if (!registered) {throw new CatalogError('CATALOG_PROJECT_NOT_REGISTERED')}
    if (workspace.repoId) {
      const repo = registered as { payload: { kind?: string } }
      if ((repo.payload.kind ?? 'git') !== (workspace.kind === 'REPO_FOLDER' ? 'folder' : 'git')) {throw new CatalogError('CATALOG_PROJECT_KIND_MISMATCH')}
    }
    const names = (await tx.query<CatalogNameReservationRow>(
      'SELECT * FROM durable_runtime.catalog_name_reservations WHERE namespace=$1', [namespace])).rows
    if (workspace.generatedName) {
      const selected = selectSuggestedCreatureName(names.map(row => row.normalized_name), () => workspace.nameChoice)
      if (normalizeSuggestedName(selected) !== normalizeSuggestedName(workspace.reservedName)) {
        throw new CatalogError('CATALOG_PREPARED_NAME_STALE_RETRYABLE')
      }
    }
    const name = normalizeSuggestedName(workspace.reservedName)
    if (names.some(row => row.normalized_name === name)) {throw new CatalogError('CATALOG_NAME_RESERVED')}
    await tx.query(`INSERT INTO durable_runtime.catalog_name_reservations
      (namespace,normalized_name,workspace_id,generated) VALUES($1,$2,$3,$4)`, [namespace, name, workspace.id, workspace.generatedName])
    parseCatalogWorkspace({ kind: workspace.kind, payload: workspace.payload as unknown as Record<string, unknown> })
    await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata
      (workspace_id,kind,repo_id,project_group_id,reserved_path,payload,create_request,runtime_unit_id,provisioning_operation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [workspace.id, workspace.kind, workspace.repoId, workspace.projectGroupId,
        workspace.reservedPath, JSON.stringify(workspace.payload), JSON.stringify(call.original), launch.unit.id, intent.operationId])
    for (const alias of [...new Set([workspace.publicId, ...workspace.aliases])].sort()) {
      await tx.query('INSERT INTO durable_runtime.workspace_aliases(alias,workspace_id,origin) VALUES($1,$2,$3)',
        [alias, workspace.id, 'CATALOG_CREATE'])
    }
    await insertCatalogTerminal(tx, launch, null)
    await tx.query('INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)', [`workspace:${workspace.id}`, randomUUID()])
    const response = captureCatalogJson({ worktree: workspace.kind === 'FOLDER_WORKSPACE'
      ? folderWorkspaceToWorktree(workspace.payload as FolderWorkspace) : workspace.payload, agentTerminalHandle: launch.tab.terminalHandle,
      startupTerminal: { spawned: false, handle: launch.tab.terminalHandle, tabId: launch.tab.parentTabId,
        paneKey: makePaneKey(launch.tab.parentTabId, launch.tab.leafId), ptyId: null, surface: 'visible' }, warnings: [] })
    await publishCatalogMutation(tx, call, workspace.id, 'CATALOG_WORKSPACE_RESERVED', { publicId: workspace.publicId, operationId: intent.operationId })
    return response
  })
}

export async function createCatalogTerminal(
  pool: Pool, input: PreparedCatalogCall<'session.tabs.createTerminal'>, prepared: PreparedCatalogLaunch, entries: CatalogOwnerEntries
): Promise<MutationOutcome> {
  const call = capturePreparedCatalogCall(input), launch = captureCatalogLaunch(prepared)
  const owners = Object.freeze({ ...entries })
  const found = await resolveCatalogMutation(pool, call, call.params.worktree)
  if (found.workspace.workspace_id !== launch.workspace.id || found.workspace.public_id !== launch.workspace.publicId) {throw new CatalogError('CATALOG_LAUNCH_WORKSPACE')}
  return runDurableMutation(pool, { ...catalogReceiptIdentity(call, `workspace:${found.workspace.workspace_id}` as ResolvedCatalogScope), locks: {} }, async tx => {
    await insertUnpublishedLaunchRows(tx, launch)
    const expected = withUnpublishedIds(found.membership, launch)
    const peers = (await tx.query<{ session_id: typeof launch.sessionId }>(
      'SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1 ORDER BY session_id', [launch.unit.id])).rows.map(row => row.session_id)
    await insertMembershipAndIntent(tx, launch, call, expected, peers, owners)
    await lockCatalogMetadata(tx, [`workspace:${found.workspace.workspace_id}`])
    const current = (await tx.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM durable_runtime.workspaces WHERE id=$1 FOR UPDATE', [launch.workspace.id])).rows[0]
    if (!current || current.deleted_at !== null) {throw new CatalogError('CATALOG_WORKSPACE_DELETED')}
    if (launch.tab.payload.isActive) {
      for (const tab of await loadCatalogTabs(tx, launch.workspace.id)) {
        if (tab.lifecycle === 'OPEN' && tab.payload.isActive) {await tx.query(
          'UPDATE durable_runtime.catalog_tab_metadata SET payload=$2,updated_at=clock_timestamp() WHERE tab_id=$1',
          [tab.tab_id, JSON.stringify({ ...tab.payload, isActive: false })])}
      }
    }
    await insertCatalogTerminal(tx, launch, call.params.launchToken ?? null)
    const created = (await loadCatalogTabs(tx, launch.workspace.id)).find(row => row.tab_id === launch.tab.id)!
    parseCatalogTab(created)
    await publishCatalogMutation(tx, call, launch.workspace.id, 'CATALOG_TERMINAL_RESERVED', { publicTabId: launch.tab.publicId })
    const snapshot = await readWorkspaceTabsInTransaction(tx, found.workspace)
    return captureCatalogJson({ tab: parseCatalogTab(created), publicationEpoch: snapshot.publicationEpoch, snapshotVersion: snapshot.snapshotVersion })
  })
}
