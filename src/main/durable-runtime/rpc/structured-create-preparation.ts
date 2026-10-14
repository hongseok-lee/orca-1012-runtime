import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { CatalogAuthority } from '../catalog/authority.ts'
import type { PreparedCatalogAgentSession } from '../catalog/agent-session.ts'
import type { CatalogWorkspace } from '../catalog/read.ts'
import { withCatalogReadSnapshot } from '../catalog/read.ts'
import { inspectCatalogMembership, catalogUnitMembers } from '../catalog/membership.ts'
import { parseCatalogRepo } from '../catalog/payload.ts'
import { captureCatalogParsed } from '../catalog/immutable.ts'
import { CatalogError } from '../catalog/errors.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { SessionId } from '../../../shared/durable-runtime/identity.ts'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection.ts'
import type { RuntimeMobileSessionAgentTab } from '../../../shared/runtime-mobile-session-tab-contracts.ts'
import type { UnitIntentAuthority } from '../lifecycle/types.ts'
import type { StructuredCreateConfiguration } from '../structured/durable-types.ts'
import type { PreparedStructuredWire } from '../structured/wire.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { requireCatalogLaunchRepository } from './launch-preparation.ts'
import { catalogLaunchContains, catalogLaunchPath } from './launch-config.ts'

export type StructuredServerLaunch = Readonly<{
  agentHomePath: string
  storagePathMapping: Readonly<{ localDirectory: string; canonicalDirectory: string }>
}>
/** Actual PG metadata only. The caller has already authenticated the exact public target. */
export async function preparePublicStructuredReservation(
  config: CapturedCatalogReadConfig, wire: PreparedStructuredWire,
  authority: CatalogAuthority, workspace: CatalogWorkspace
): Promise<StructuredCreateConfiguration> {
  const mutation = wire.mutation
  const provider = wire.params.agent
  if (wire.method !== 'agentSession.create' || wire.target.kind !== 'WORKTREE' || !mutation ||
      (provider !== 'claude' && provider !== 'codex')) { throw new CatalogError('STRUCTURED_CREATE_CONFIGURATION') }
  if (workspace.deleted_at !== null) { throw new CatalogError('CATALOG_WORKSPACE_DELETED') }
  if (!workspace.repo_id || (workspace.kind !== 'GIT' && workspace.kind !== 'REPO_FOLDER')) {
    throw new CatalogError('CATALOG_METHOD_NOT_CONNECTED')
  }
  const metadata = await withCatalogReadSnapshot(config.pool, async tx => {
    const row = (await tx.query<{ id: string; payload: Record<string, unknown>; deleted_at: Date | null }>(
      'SELECT id,payload,deleted_at FROM durable_runtime.catalog_repositories WHERE id=$1', [workspace.repo_id])).rows[0]
    if (!row || row.deleted_at !== null) { throw new CatalogError('CATALOG_REPO_NOT_FOUND') }
    const repo = parseCatalogRepo(row)
    const launch = requireCatalogLaunchRepository(config, repo)
    const localDirectory = launch.storage.localDirectory ?? launch.storage.canonicalDirectory
    if (!catalogLaunchContains(localDirectory, catalogLaunchPath(workspace.reserved_path))) {
      throw new CatalogError('CATALOG_STORAGE_CONFIGURATION')
    }
    if (!workspace.runtime_unit_id) { throw new CatalogError('CATALOG_UNIT_CONFIGURATION') }
    const unitId = logicalId('runtime-unit', workspace.runtime_unit_id)
    const membership = await inspectCatalogMembership(tx, workspace.workspace_id)
    const members = (await tx.query<{ session_id: SessionId; runtime_unit_id: string; storage_binding_id: string;
      backend_id: string; export_id: string; canonical_directory: string }>(`SELECT m.session_id,m.runtime_unit_id,
      m.storage_binding_id,b.backend_id,b.export_id,b.canonical_directory
      FROM durable_runtime.runtime_members m JOIN durable_runtime.sessions s ON s.id=m.session_id
      JOIN durable_runtime.runtime_units u ON u.id=m.runtime_unit_id
      JOIN durable_runtime.storage_bindings b ON b.id=m.storage_binding_id
      WHERE m.runtime_unit_id=$1 ORDER BY m.session_id`, [unitId])).rows
    const peers = catalogUnitMembers(membership, unitId)
    if (!members.length || !membership.units.includes(unitId) ||
        !members.some(member => membership.workspaceSessions.includes(member.session_id)) ||
        JSON.stringify(members.map(member => member.session_id)) !== JSON.stringify(peers) ||
        members.some(member => member.runtime_unit_id !== unitId || member.storage_binding_id !== members[0].storage_binding_id ||
          member.backend_id !== launch.storage.backendId || member.export_id !== launch.storage.exportId ||
          member.canonical_directory !== launch.storage.canonicalDirectory)) {
      throw new CatalogError('CATALOG_STORAGE_CONFIGURATION')
    }
    const last = (await tx.query<{ ui_order: string }>(
      'SELECT ui_order FROM durable_runtime.tabs WHERE workspace_id=$1 ORDER BY ui_order DESC LIMIT 1', [workspace.workspace_id])).rows[0]
    const uiOrder = last === undefined ? 0 : Number(last.ui_order) + 1
    if (!Number.isSafeInteger(uiOrder) || uiOrder < 0) { throw new CatalogError('CATALOG_AGENT_SESSION_CONFIGURATION') }
    return { launch, localDirectory, membership, peers, unitId,
      storageId: logicalId('storage-binding', members[0].storage_binding_id), uiOrder }
  })
  config.assertCurrentHost()
  const sessionId = logicalId('session', randomUUID()), agentId = logicalId('agent', randomUUID()), tabId = logicalId('tab', randomUUID())
  const unitFields: Omit<UnitIntentAuthority, symbol> = { principalId: authority.principalId, runtimeUnitId: metadata.unitId,
    scope: JSON.stringify(['catalog-structured-create-v1', config.datasetName, config.hostId, workspace.public_id, metadata.unitId]) }
  // Issued only after the authenticated exact Workspace and its PG Unit/membership/binding were verified.
  const unitAuthority = Object.freeze(unitFields) as UnitIntentAuthority
  const payload: RuntimeMobileSessionAgentTab = { type: 'agent-session', id: structuredAgentSessionTabId(mutation.publicSessionId),
    title: provider === 'claude' ? 'Claude' : 'Codex', sessionId: mutation.publicSessionId, agent: provider, isActive: true }
  const serverLaunch: StructuredServerLaunch = { agentHomePath: posix.join(metadata.launch.agentHomeRoot, agentId),
    storagePathMapping: { localDirectory: metadata.localDirectory, canonicalDirectory: metadata.launch.storage.canonicalDirectory } }
  const reservation: PreparedCatalogAgentSession = { authority,
    workspace: { workspace_id: workspace.workspace_id, public_id: workspace.public_id,
      repo_id: workspace.repo_id, project_group_id: workspace.project_group_id },
    membership: metadata.membership, unitPeers: metadata.peers, publicSessionId: mutation.publicSessionId,
    operationKey: mutation.operationKey,
    runtime: { workspace: { id: workspace.workspace_id }, sessionId, agent: { id: agentId, provider, create: true },
      unit: { id: metadata.unitId, create: false, authority: unitAuthority },
      storage: { id: metadata.storageId, createUnverified: false, backendId: metadata.launch.storage.backendId,
        exportId: metadata.launch.storage.exportId, canonicalDirectory: metadata.launch.storage.canonicalDirectory },
      policy: config.launch!.policy },
    tab: { id: tabId, uiOrder: metadata.uiOrder, payload }, originalRequest: { ...wire.params },
    serverLaunch: captureCatalogParsed(serverLaunch) }
  const configuration: StructuredCreateConfiguration = { reservation, location: { workspaceId: workspace.public_id,
    executionHostId: config.hostId, wslDistro: null, workspaceKind: workspace.kind === 'GIT' ? 'git-worktree' : 'folder' } }
  return Object.freeze(configuration)
}
