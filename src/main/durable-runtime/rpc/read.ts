import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { CatalogCallContext } from '../catalog/request.ts'
import type { CatalogSnapshot, CatalogWorkspace } from '../catalog/read.ts'
import type { CatalogMethod } from '../catalog/wire.ts'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts.ts'
import { captureCatalogParsed } from '../catalog/immutable.ts'
import { projectSessionTabsForClient } from '../../runtime/rpc/methods/session-tabs-inventory.ts'
import { isStructuredNativeChatEnabled } from '../../runtime/rpc/methods/structured-agent-session-policy.ts'
import { SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version.ts'
import { captureCatalogReadContext } from './context.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { CatalogReadError } from './config.ts'

export type CatalogReadInvocation = {
  readonly context: CatalogCallContext
  readonly params: unknown
  readonly clientKind: RpcContext['clientKind']
  readonly capabilities: RpcContext['clientCapabilities']
  readonly structuredEnabled: boolean
}
export function captureReadInvocation(config: CapturedCatalogReadConfig, params: unknown, context: RpcContext): CatalogReadInvocation {
  return Object.freeze({ context: captureCatalogReadContext(config, context),
    params: captureCatalogParsed(params === undefined ? null : params), clientKind: context.clientKind,
    capabilities: context.clientCapabilities === undefined ? undefined : Object.freeze([...context.clientCapabilities]),
    structuredEnabled: isStructuredNativeChatEnabled(context.runtime) })
}
export async function catalogModules() {
  const [read, projection, request, payload] = await Promise.all([
    import('../catalog/read.ts'), import('../catalog/projection.ts'), import('../catalog/request.ts'), import('../catalog/payload.ts')
  ])
  return { read, projection, request, payload }
}
export function validateCatalogSnapshot(config: CapturedCatalogReadConfig, snapshot: CatalogSnapshot): void {
  config.assertCurrentHost()
  if (!snapshot.heads.some(head => head.scope === 'catalog') || snapshot.heads.some(head => head.dataset_name !== config.datasetName)) {
    throw new CatalogReadError('CATALOG_DATASET_MISMATCH')
  }
  for (const repo of snapshot.repositories) {
    if ((repo.executionHostId ?? 'local') !== config.hostId) { throw new CatalogReadError('CATALOG_REGISTRATION_HOST_MISMATCH') }
  }
  for (const row of snapshot.workspaces) {
    const host = row.payload.hostId ?? row.payload.executionHostId ??
      snapshot.repositories.find(repo => repo.id === row.repo_id)?.executionHostId ?? 'local'
    if (host !== config.hostId) { throw new CatalogReadError('CATALOG_REGISTRATION_HOST_MISMATCH') }
  }
}
export function projectTabs(invocation: CatalogReadInvocation, tabs: RuntimeMobileSessionTabsResult): RuntimeMobileSessionTabsResult {
  return projectSessionTabsForClient(tabs, invocation.clientKind, invocation.capabilities, invocation.structuredEnabled)
}
export function authoritativeInventory(invocation: CatalogReadInvocation): { authoritative?: true } {
  return invocation.capabilities?.includes(SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY) ? { authoritative: true } : {}
}
export async function resolveReadWorkspace(config: CapturedCatalogReadConfig, invocation: CatalogReadInvocation, selector: string): Promise<CatalogWorkspace> {
  const { read } = await catalogModules()
  const workspace = await read.withCatalogReadSnapshot(config.pool, tx => read.resolveCatalogWorkspace(tx, selector, invocation.context.authority))
  config.assertCurrentHost()
  return workspace
}
/** Receives a detached invocation. Every result comes from one RR Catalog
 * snapshot/projector; the original runtime/PTY restore path is never called. */
export async function readCatalogRpc(config: CapturedCatalogReadConfig, method: CatalogMethod, invocation: CatalogReadInvocation): Promise<unknown> {
  const modules = await catalogModules()
  const call = modules.request.prepareCatalogCall(method, invocation.params, invocation.context)
  const canonical = method === 'worktree.show' || method === 'session.tabs.list'
    ? await resolveReadWorkspace(config, invocation, (call.params as unknown as { worktree: string }).worktree) : null
  const snapshot = await modules.read.readCatalogSnapshot(config.pool, invocation.context.authority)
  validateCatalogSnapshot(config, snapshot)
  switch (method) {
    case 'repo.list': return { repos: [...snapshot.repositories] }
    case 'projectGroup.list': return { groups: [...snapshot.projectGroups] }
    case 'folderWorkspace.list': return { folderWorkspaces: snapshot.workspaces.filter(row => row.kind === 'FOLDER_WORKSPACE').map(modules.payload.parseCatalogWorkspace) }
    case 'worktree.list': return modules.projection.projectCatalogList(snapshot, modules.request.prepareCatalogCall('worktree.list', invocation.params, invocation.context))
    case 'worktree.ps': return modules.projection.projectCatalogPs(snapshot, modules.request.prepareCatalogCall('worktree.ps', invocation.params, invocation.context))
    case 'ui.get': {
      if (!snapshot.ui) { throw new CatalogReadError('CATALOG_UI_NOT_INITIALIZED') }
      const { parseCatalogUi } = await import('../catalog/ui.ts')
      config.assertCurrentHost()
      return { ui: parseCatalogUi(snapshot.ui.payload) }
    }
    case 'worktree.show': case 'session.tabs.list': {
      const workspace = snapshot.workspaces.find(row => row.workspace_id === canonical?.workspace_id)
      if (!workspace || workspace.public_id !== canonical?.public_id) { throw new CatalogReadError('CATALOG_WORKSPACE_UNAVAILABLE') }
      return method === 'worktree.show' ? { worktree: modules.projection.projectCatalogWorktree(workspace) }
        : projectTabs(invocation, modules.projection.projectCatalogTabs(snapshot, workspace))
    }
    case 'session.tabs.listAll': return { snapshots: snapshot.workspaces.map(row => projectTabs(invocation,
      modules.projection.projectCatalogTabs(snapshot, row))), ...authoritativeInventory(invocation) }
    default: throw new CatalogReadError('CATALOG_METHOD_NOT_CONNECTED')
  }
}
