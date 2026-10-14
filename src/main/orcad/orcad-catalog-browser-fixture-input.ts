import { randomUUID } from 'node:crypto'
import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import type { OrcadBrowserProvider } from './orcad-browser-provider'
import { ExternalChromiumBrowserProcess } from './external-chromium-browser-process'
import type { CatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import { captureCatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import type { PreparedCatalogLaunch } from '../durable-runtime/catalog/launch.ts'
import { captureCatalogLaunch } from '../durable-runtime/catalog/launch.ts'
import type { UnitIntentAuthority } from '../durable-runtime/lifecycle/types.ts'
import type { CatalogRegistration } from '../durable-runtime/catalog/register.ts'
import { logicalId } from '../../shared/durable-runtime/identity.ts'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host.ts'

export const browserFixturePrincipal = 'synthetic-browser-catalog-owner'
export function browserFixtureAuthority(repoId: string): CatalogAuthority {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Synthetic fixture authority only; not an authentication issuer or production entry.
  return captureCatalogAuthority({ principalId: browserFixturePrincipal,
    repositoryIds: [repoId], projectGroupIds: [], workspacePublicIds: [] } as CatalogAuthority)
}
export function browserFixtureLaunch(repoId: string, name: string): PreparedCatalogLaunch {
  const workspaceId = logicalId('workspace', randomUUID())
  const unitId = logicalId('runtime-unit', randomUUID())
  const sessionId = logicalId('session', randomUUID())
  const tabId = logicalId('tab', randomUUID())
  const parentTabId = `browser-fixture-${randomUUID()}`, leafId = randomUUID()
  const path = `/synthetic/browser-catalog/${name}`, publicId = `${repoId}::${path}`
  const git = { path, head: '', branch: name, isBare: false, isMainWorktree: false }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Synthetic fixture intent scope, consumed by the real Catalog validators; no live permission is minted.
  const unitAuthority = { principalId: browserFixturePrincipal, runtimeUnitId: unitId,
    scope: `workspace:${workspaceId}` } as UnitIntentAuthority
  const launch = {
    workspace: { id: workspaceId, publicId, kind: 'GIT', repoId, projectGroupId: null,
      reservedPath: path, reservedName: name, generatedName: false, nameChoice: 0,
      aliases: [`browser-alias:${workspaceId}`], payload: { ...git, id: publicId, repoId,
        hostId: LOCAL_EXECUTION_HOST_ID, displayName: 'Browser fixture shared label', comment: '',
        linkedIssue: null, linkedPR: null, linkedLinearIssue: null, isArchived: false,
        isUnread: false, isPinned: false, sortOrder: 0, lastActivityAt: 0,
        parentWorktreeId: null, childWorktreeIds: [], lineage: null, git } },
    tab: { id: tabId, publicId: `${parentTabId}::${leafId}`, parentTabId, leafId,
      terminalHandle: `synthetic-browser-handle:${tabId}`, uiOrder: 0,
      payload: { type: 'terminal', id: `${parentTabId}::${leafId}`, parentTabId, leafId,
        title: 'Synthetic shell', isActive: true, status: 'pending-handle', terminal: null } },
    sessionId, agent: { id: logicalId('agent', randomUUID()), provider: 'shell', create: true },
    unit: { id: unitId, create: true, authority: unitAuthority },
    storage: { id: logicalId('storage-binding', randomUUID()), createUnverified: true,
      backendId: 'synthetic-browser-backend', exportId: 'synthetic-browser-export',
      canonicalDirectory: `/synthetic/browser-catalog/homes/${sessionId}` },
    launchRequest: { command: 'synthetic-only', env: {} },
    policy: { operationDeadlineMs: 10000, idleDurationMs: null }
  } satisfies Omit<PreparedCatalogLaunch, symbol>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the synthetic nominal launch marker is supplied here; real capture validates all fields/UUIDs/public IDs before PG use.
  return captureCatalogLaunch(launch as PreparedCatalogLaunch)
}
export function browserFixtureRegistration(repoId: string): CatalogRegistration {
  return { mutationId: `browser-registration:${randomUUID()}`, group: null,
    repo: { id: repoId, path: '/synthetic/browser-catalog/repo', displayName: 'Synthetic browser repo',
      badgeColor: '#ffffff', addedAt: 1, kind: 'git', executionHostId: LOCAL_EXECUTION_HOST_ID },
    ui: { lastActiveRepoId: null, lastActiveWorktreeId: null, activeView: 'terminal', sidebarWidth: 240,
      rightSidebarOpen: false, rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files', rightSidebarWidth: 320,
      groupBy: 'none', sortBy: 'smart', projectOrderBy: 'manual', showActiveOnly: false,
      hideDefaultBranchWorkspace: false, filterRepoIds: [], collapsedGroups: [], uiZoomLevel: 0,
      editorFontZoomLevel: 0, worktreeCardProperties: [], statusBarItems: [], statusBarVisible: true,
      dismissedUpdateVersion: null, lastUpdateCheckAt: null } }
}
export function browserFixtureHost(): RuntimeBrowserCommandHost {
  return {
    getAgentBrowserBridge() { return null },
    async resolveWorktreeSelector() { throw new Error('Unexpected legacy Worktree resolver') },
    async resolveBrowserWorkspace() { throw new Error('Unexpected legacy Workspace resolver') },
    resolveBrowserNetworkExecutionHost() { throw new Error('Not a network fixture') },
    getBrowserHostLeaseRegistry() { throw new Error('Not a lease fixture') },
    getRuntimeBrowserPageRegistry() { throw new Error('Not a page registry fixture') },
    getAuthoritativeWindow() { throw new Error('Not an Electron fixture') },
    getAvailableAuthoritativeWindow() { return null },
    getOffscreenBrowserBackend() { return null }
  }
}
/** Construct the real commands only. Never start/stop the process or call native CLI. */
export function browserFixtureProvider(capture: (host: RuntimeBrowserCommandHost) => void): OrcadBrowserProvider {
  const process = new ExternalChromiumBrowserProcess('not-executed-fixture',
    { executablePath: 'not-executed-fixture', provider: 'chromium' }, '/tmp/orca-catalog-browser-unstarted', {})
  return { kind: 'chromium', factory(host) { capture(host); return process.createCommands(host) },
    isAvailable() { return true }, async stop() { throw new Error('Borrowed provider must not be stopped') } }
}
