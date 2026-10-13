import type { RuntimeMobileSessionTerminalClientTab } from '../../../shared/runtime-mobile-session-tab-contracts.ts'
import type { RuntimeWorktreeRecord } from '../../../shared/runtime-worktree-contracts.ts'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types.ts'
import type { AgentId, SessionId, TabId, RuntimeUnitId, WorkspaceId, StorageBindingId } from '../../../shared/durable-runtime/identity.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { makePaneKey, isTerminalLeafId } from '../../../shared/stable-pane-id.ts'
import { isValidHostTerminalTabId } from '../../../shared/terminal-tab-id.ts'
import { getRepoMainWorktreeId, FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../../shared/worktree/id.ts'
import { folderWorkspaceKey } from '../../../shared/workspace-scope.ts'
import type { UnitIntentAuthority, LifecyclePolicy } from '../lifecycle/types.ts'
import { captureCatalogParsed } from './immutable.ts'
import { CatalogError } from './errors.ts'

declare const preparedLaunch: unique symbol
/** Prepared by the authorized runtime configuration boundary. No issuer in Catalog. */
export type PreparedCatalogLaunch = {
  readonly [preparedLaunch]: true
  readonly workspace: {
    readonly id: WorkspaceId; readonly publicId: string
    readonly kind: 'GIT' | 'REPO_FOLDER' | 'FOLDER_WORKSPACE'
    readonly repoId: string | null; readonly projectGroupId: string | null
    readonly reservedPath: string; readonly reservedName: string; readonly generatedName: boolean
    /** Fixed entropy used by the incumbent generator under the namespace lock. */
    readonly nameChoice: number
    readonly payload: RuntimeWorktreeRecord | FolderWorkspace
    readonly aliases: readonly string[]
  }
  readonly tab: { readonly id: TabId; readonly publicId: string; readonly parentTabId: string
    readonly leafId: string; readonly terminalHandle: string; readonly uiOrder: number
    readonly payload: RuntimeMobileSessionTerminalClientTab }
  readonly sessionId: SessionId
  readonly agent: { readonly id: AgentId; readonly provider: 'shell' | 'claude' | 'codex'; readonly create: boolean }
  readonly unit: { readonly id: RuntimeUnitId; readonly create: boolean; readonly authority: UnitIntentAuthority }
  readonly storage: { readonly id: StorageBindingId; readonly createUnverified: boolean
    readonly backendId: string; readonly exportId: string; readonly canonicalDirectory: string }
  readonly launchRequest: Record<string, unknown>
  readonly policy: LifecyclePolicy
}

/** Synchronous, detached configuration and original launch DTO before the first await. */
export function captureCatalogLaunch(input: PreparedCatalogLaunch): PreparedCatalogLaunch {
  const launch = captureCatalogParsed(input) as PreparedCatalogLaunch
  logicalId('workspace', launch.workspace.id); logicalId('session', launch.sessionId)
  logicalId('tab', launch.tab.id); logicalId('agent', launch.agent.id)
  logicalId('runtime-unit', launch.unit.id); logicalId('storage-binding', launch.storage.id)
  if (!isValidHostTerminalTabId(launch.tab.parentTabId) || !isTerminalLeafId(launch.tab.leafId) ||
    !launch.tab.terminalHandle || !Number.isSafeInteger(launch.tab.uiOrder) || launch.tab.uiOrder < 0 ||
    launch.tab.publicId !== `${launch.tab.parentTabId}::${launch.tab.leafId}` ||
    launch.tab.payload.id !== launch.tab.publicId || launch.tab.payload.parentTabId !== launch.tab.parentTabId ||
    launch.tab.payload.leafId !== launch.tab.leafId || launch.tab.payload.type !== 'terminal' ||
    launch.tab.payload.status !== 'pending-handle' || launch.tab.payload.terminal !== null ||
    (launch.tab.payload.ptyId !== undefined && launch.tab.payload.ptyId !== null) ||
    (launch.tab.payload.incarnationId !== undefined && launch.tab.payload.incarnationId !== null) ||
    launch.unit.authority.runtimeUnitId !== launch.unit.id || !launch.unit.authority.principalId ||
    !launch.workspace.reservedName || !launch.workspace.reservedPath ||
    !Number.isFinite(launch.workspace.nameChoice) || launch.workspace.nameChoice < 0 || launch.workspace.nameChoice >= 1 ||
    !['shell', 'claude', 'codex'].includes(launch.agent.provider) ||
    !launch.storage.backendId || !launch.storage.exportId ||
    !/^\/(?!.*(?:\/\/|(?:^|\/)\.{1,2}(?:\/|$)))/.test(launch.storage.canonicalDirectory) ||
    (launch.storage.canonicalDirectory !== '/' && launch.storage.canonicalDirectory.endsWith('/'))) {
    throw new CatalogError('CATALOG_LAUNCH_CONFIGURATION')
  }
  makePaneKey(launch.tab.parentTabId, launch.tab.leafId)
  const workspace = launch.workspace
  if ('ps' in workspace.payload) {throw new CatalogError('CATALOG_INITIAL_PHYSICAL_PROJECTION_FORBIDDEN')}
  const expected = workspace.kind === 'FOLDER_WORKSPACE'
    ? folderWorkspaceKey(workspace.payload.id)
    : getRepoMainWorktreeId({ id: workspace.repoId ?? '', path: workspace.reservedPath }) +
      (workspace.kind === 'REPO_FOLDER' ? `${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}${workspace.id}` : '')
  if (expected !== workspace.publicId || (workspace.kind !== 'FOLDER_WORKSPACE' && workspace.payload.id !== expected)) {
    throw new CatalogError('CATALOG_PUBLIC_IDENTITY')
  }
  if (workspace.kind === 'FOLDER_WORKSPACE') {
    const payload = workspace.payload as FolderWorkspace
    if (payload.folderPath !== workspace.reservedPath || payload.projectGroupId !== workspace.projectGroupId) {throw new CatalogError('CATALOG_LAUNCH_CONFIGURATION')}
  } else {
    const payload = workspace.payload as RuntimeWorktreeRecord
    if (payload.path !== workspace.reservedPath || payload.repoId !== workspace.repoId) {throw new CatalogError('CATALOG_LAUNCH_CONFIGURATION')}
  }
  if (workspace.aliases.some(alias => !alias)) {throw new CatalogError('CATALOG_ALIAS')}
  return launch
}
