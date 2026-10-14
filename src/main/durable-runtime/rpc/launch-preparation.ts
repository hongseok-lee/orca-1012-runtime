import { randomUUID, randomInt } from 'node:crypto'
import { posix } from 'node:path'
import type { Repo } from '../../../shared/repo-types.ts'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types.ts'
import type { RuntimeWorktreeRecord } from '../../../shared/runtime-worktree-contracts.ts'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../shared/runtime-mobile-session-tab-contracts.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { selectSuggestedCreatureName } from '../../../shared/worktree-name-suggestion.ts'
import { createWorktreeIdentity } from '../../../shared/worktree/identity.ts'
import { computeWorktreePath, sanitizeWorktreeName } from '../../ipc/worktree-logic.ts'
import { resolveWorktreeCreateDisplayNameRequest, resolveWorktreeCreateDisplayNameMeta } from '../../ipc/worktree-display-name.ts'
import { mergeWorktree } from '../../ipc/worktree-metadata-merge.ts'
import { getRuntimeFolderWorkspaceInstanceId, mergeRuntimeFolderWorkspace } from '../../runtime/runtime-folder-workspace.ts'
import { captureCatalogLaunch, type PreparedCatalogLaunch } from '../catalog/launch.ts'
import { captureCatalogParsed } from '../catalog/immutable.ts'
import type { PreparedCatalogCall } from '../catalog/request.ts'
import type { CatalogWorkspace } from '../catalog/read.ts'
import { parseCatalogWorkspace } from '../catalog/payload.ts'
import type { UnitIntentAuthority } from '../lifecycle/types.ts'
import { CatalogError } from '../catalog/errors.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { catalogLaunchContains, catalogLaunchPath, type CatalogLaunchRepositoryConfig } from './launch-config.ts'

export type CatalogCreationMethod = 'worktree.create' | 'session.tabs.createTerminal'
export type ExistingCatalogLaunchUnit = {
  readonly unitId: string; readonly bindingId: string
  readonly backendId: string; readonly exportId: string; readonly canonicalDirectory: string
}
export function requireCatalogLaunchRepository(config: CapturedCatalogReadConfig, repo: Repo): CatalogLaunchRepositoryConfig {
  const launch = config.launch?.repositories.find(item => item.repositoryId === repo.id)
  if (!launch) { throw new CatalogError('CATALOG_METHOD_NOT_CONNECTED') }
  if (config.hostId !== 'local' || (repo.executionHostId ?? 'local') !== 'local' || repo.connectionId) {
    throw new CatalogError('CATALOG_LAUNCH_LOCAL_REPOSITORY_REQUIRED')
  }
  const path = catalogLaunchPath(repo.path)
  if (!catalogLaunchContains(launch.storage.canonicalDirectory, path) && (repo.kind ?? 'git') === 'folder') {
    throw new CatalogError('CATALOG_LAUNCH_CONFIGURATION')
  }
  if ((repo.kind ?? 'git') === 'git' && launch.worktreeRoot === undefined) { throw new CatalogError('CATALOG_LAUNCH_CONFIGURATION') }
  return launch
}
function provider(call: PreparedCatalogCall<CatalogCreationMethod>): 'shell' | 'claude' | 'codex' {
  const params = call.params as Record<string, unknown>
  const requested = call.method === 'worktree.create' ? params.startupAgent ?? params.createdWithAgent : params.launchAgent ?? params.agent
  if (requested === undefined) { return 'shell' }
  if (requested !== 'claude' && requested !== 'codex') { throw new CatalogError('CATALOG_LAUNCH_PROVIDER_NOT_CONNECTED') }
  return requested
}
function launchTail(
  config: CapturedCatalogReadConfig, call: PreparedCatalogCall<CatalogCreationMethod>, repo: CatalogLaunchRepositoryConfig,
  workspace: PreparedCatalogLaunch['workspace'], unit: ExistingCatalogLaunchUnit | null, uiOrder: number
): PreparedCatalogLaunch {
  const sessionId = logicalId('session', randomUUID()), agentId = logicalId('agent', randomUUID())
  const unitId = logicalId('runtime-unit', unit?.unitId ?? randomUUID())
  const tabId = logicalId('tab', randomUUID()), parentTabId = randomUUID(), leafId = randomUUID()
  const publicId = `${parentTabId}::${leafId}`, terminalHandle = `term_${randomUUID()}`
  const params = call.params as Record<string, unknown>, selectedProvider = provider(call)
  const launchAgent = call.method === 'worktree.create' ? params.startupAgent : params.launchAgent ?? params.agent
  const draft = call.method === 'worktree.create' ? params.startupDraft : undefined
  const payload: RuntimeMobileSessionTerminalClientTab = {
    type: 'terminal', id: publicId, parentTabId, leafId, title: 'Terminal', isActive: params.activate !== false,
    status: 'pending-handle', terminal: null,
    ...(launchAgent === 'claude' || launchAgent === 'codex' ? { launchAgent } : {}),
    ...(typeof draft === 'string' ? { launchDraft: draft } : {}),
    ...(params.viewMode === 'chat' || params.viewMode === 'terminal' ? { viewMode: params.viewMode } : {}),
    startupCwd: typeof params.cwd === 'string' ? params.cwd : workspace.reservedPath
  }
  // Issued only from the captured authenticated principal and server namespace.
  // This is logical Unit intent authority, never physical writer authority.
  const authority = Object.freeze({ principalId: call.context.authority.principalId, runtimeUnitId: unitId,
    scope: JSON.stringify(['catalog-launch-v1', config.datasetName, config.hostId, workspace.repoId, unitId]) }) as UnitIntentAuthority
  const original = call.original as Record<string, unknown>
  const launchRequest = { ...original, server: { agentHomePath: posix.join(repo.agentHomeRoot, agentId) } }
  const fields: Omit<PreparedCatalogLaunch, symbol> = { workspace, tab: { id: tabId, publicId, parentTabId, leafId, terminalHandle, uiOrder, payload },
    sessionId, agent: { id: agentId, provider: selectedProvider, create: true }, unit: { id: unitId, create: unit === null, authority },
    storage: { id: logicalId('storage-binding', unit?.bindingId ?? randomUUID()), createUnverified: unit === null,
      backendId: repo.storage.backendId, exportId: repo.storage.exportId, canonicalDirectory: repo.storage.canonicalDirectory },
    launchRequest, policy: config.launch!.policy }
  // All fields are checked against the actual launch structure above. Only
  // this authenticated server issuer connects its private brand; core capture
  // still performs the existing deep freeze and runtime relationship checks.
  return captureCatalogLaunch(fields as PreparedCatalogLaunch)
}

/** Read-only inputs from registered PG metadata; no Git/FS/SSH/PTY/provider calls. */
export function prepareCatalogWorktreeLaunch(
  config: CapturedCatalogReadConfig, call: PreparedCatalogCall<'worktree.create'>, repo: Repo, usedNames: readonly string[]
): PreparedCatalogLaunch {
  const launch = requireCatalogLaunchRepository(config, repo), params = call.params
  const workspaceId = logicalId('workspace', randomUUID())
  const generatedName = params.nameWasGenerated === true || !params.name?.trim()
  const nameChoice = randomInt(0x100000000) / 0x100000000
  const name = generatedName ? selectSuggestedCreatureName(usedNames, () => nameChoice) : params.name!
  let reservedName: string
  try { reservedName = sanitizeWorktreeName(name) } catch { throw new CatalogError('CATALOG_LAUNCH_NAME') }
  const folder = (repo.kind ?? 'git') === 'folder'
  const reservedPath = folder ? repo.path : computeWorktreePath(reservedName, repo.path,
    { workspaceDir: launch.worktreeRoot!, nestWorkspaces: false }, launch.worktreeRoot!)
  catalogLaunchPath(reservedPath)
  if (!catalogLaunchContains(launch.storage.canonicalDirectory, reservedPath)) { throw new CatalogError('CATALOG_LAUNCH_CONFIGURATION') }
  const label = resolveWorktreeCreateDisplayNameRequest(params.displayName, params.displayNameKind, name,
    params.cliProvenanceRequest !== undefined, generatedName)
  const meta: WorktreeMeta = { displayName: '', isArchived: false, isUnread: false, isPinned: false,
    sortOrder: 0, lastActivityAt: 0, instanceId: workspaceId, hostId: config.hostId, comment: params.comment ?? '',
    ...resolveWorktreeCreateDisplayNameMeta(label.value, reservedName, label.kind, { requestedName: name, sanitizedName: reservedName }),
    linkedIssue: params.linkedIssue ?? null, linkedPR: params.linkedPR ?? null, linkedLinearIssue: params.linkedLinearIssue ?? null,
    linkedLinearIssueWorkspaceId: params.linkedLinearIssueWorkspaceId ?? null,
    linkedLinearIssueOrganizationUrlKey: params.linkedLinearIssueOrganizationUrlKey ?? null,
    linkedGitLabMR: params.linkedGitLabMR ?? null, linkedGitLabIssue: params.linkedGitLabIssue ?? null,
    linkedBitbucketPR: params.linkedBitbucketPR ?? null, linkedAzureDevOpsPR: params.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: params.linkedGiteaPR ?? null, linkedWorkItem: params.linkedWorkItem ?? null,
    linkedTaskSourceContext: params.linkedTaskSourceContext ?? null,
    ...(params.manualOrder === undefined ? {} : { manualOrder: params.manualOrder }),
    ...(params.workspaceStatus === undefined ? {} : { workspaceStatus: params.workspaceStatus }) }
  // No observed checkout HEAD/branch, live PTY or execution success is invented.
  const git = { path: reservedPath, head: '', branch: '', isBare: false, isMainWorktree: false }
  const projected = folder ? mergeRuntimeFolderWorkspace(repo, getRuntimeFolderWorkspaceInstanceId(repo, workspaceId), meta)
    : mergeWorktree(repo.id, git, meta)
  const identity = createWorktreeIdentity({ worktreeId: projected.id, executionHostId: config.hostId, instanceId: workspaceId })
  const payload: RuntimeWorktreeRecord = { ...projected, identity, parentWorktreeId: null, childWorktreeIds: [], lineage: null, git }
  // The complete legacy DTO was structurally checked above. This boundary
  // connects its frozen readonly arrays to that incumbent mutable DTO type;
  // the captured object remains deeply frozen and is not mutated here.
  const capturedPayload = captureCatalogParsed(payload) as unknown as RuntimeWorktreeRecord
  return launchTail(config, call, launch, { id: workspaceId, publicId: payload.id, kind: folder ? 'REPO_FOLDER' : 'GIT',
    repoId: repo.id, projectGroupId: null, reservedPath, reservedName, generatedName, nameChoice, payload: capturedPayload, aliases: [] }, null, 0)
}

export function prepareCatalogTerminalLaunch(
  config: CapturedCatalogReadConfig, call: PreparedCatalogCall<'session.tabs.createTerminal'>,
  repo: Repo, workspace: CatalogWorkspace, unit: ExistingCatalogLaunchUnit, uiOrder: number
): PreparedCatalogLaunch {
  const launch = requireCatalogLaunchRepository(config, repo)
  if (workspace.kind !== 'GIT' && workspace.kind !== 'REPO_FOLDER') { throw new CatalogError('CATALOG_METHOD_NOT_CONNECTED') }
  if (workspace.repo_id !== repo.id || workspace.runtime_unit_id !== unit.unitId ||
      unit.backendId !== launch.storage.backendId || unit.exportId !== launch.storage.exportId ||
      unit.canonicalDirectory !== launch.storage.canonicalDirectory ||
      !catalogLaunchContains(launch.storage.canonicalDirectory, catalogLaunchPath(workspace.reserved_path))) {
    throw new CatalogError('CATALOG_STORAGE_CONFIGURATION')
  }
  const payload = parseCatalogWorkspace(workspace) as RuntimeWorktreeRecord
  return launchTail(config, call, launch, { id: workspace.workspace_id, publicId: workspace.public_id, kind: workspace.kind,
    repoId: repo.id, projectGroupId: workspace.project_group_id, reservedPath: workspace.reserved_path,
    reservedName: workspace.name, generatedName: false, nameChoice: 0, payload, aliases: [] }, unit, uiOrder)
}
