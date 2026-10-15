import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { CatalogTab, CatalogWorkspace } from '../catalog/read.ts'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types.ts'
import type { RuntimeBrowserCommandHost } from '../../runtime/orca-runtime-browser'
import { ExternalChromiumBrowserProcess } from '../../orcad/external-chromium-browser-process.ts'
import { ExternalChromiumTabRegistry } from '../../orcad/external-chromium-tab-registry.ts'
import { CompositionNativeSession } from '../../orcad/ops-browser-composition-fixtures.ts'
import { createOpsBrowserSessionAuthority } from '../ops/browser-session-auth.ts'
import { fixtureConfig, fixtureRuntime } from './fixture-support.mts'

export const streamPage = 'e1e72385-4704-4a9a-bc3c-8a15430b1951'
export const streamWorkspace = 'folder:synthetic-stream-recovery'
export const streamOrigin = 'https://ops.example.test:8443'
export function streamRecoveryRows() {
  const workspaceId = logicalId('workspace', '583da887-e43a-4812-896f-f6ec8bb194dd')
  const payload: FolderWorkspace = { id: 'synthetic-stream-recovery', projectGroupId: 'synthetic-stream-group',
    name: 'Synthetic stream recovery', folderPath: '/synthetic/stream-recovery', comment: '', linkedTask: null,
    createdAt: 1, updatedAt: 1, lastActivityAt: 1, sortOrder: 0, isArchived: false, isUnread: false, isPinned: false }
  const workspace: CatalogWorkspace = { workspace_id: workspaceId, public_id: streamWorkspace, name: payload.name,
    kind: 'FOLDER_WORKSPACE', repo_id: null, project_group_id: payload.projectGroupId,
    reserved_path: payload.folderPath, payload: { ...payload }, create_request: {},
    workspace_revision: '0', provisioning_state: 'PENDING', deleted_at: null,
    runtime_unit_id: null, provisioning_operation_id: null, created_at: new Date(0), updated_at: new Date(0) }
  const tab: CatalogTab = { tab_id: logicalId('tab', '430b21ca-30b9-4e6b-9d44-5d3b09ed0658'), public_tab_id: streamPage,
    workspace_id: workspaceId, session_id: null, kind: 'browser', terminal_handle: null, lifecycle: 'OPEN',
    tab_revision: '0', launch_token: null, binding_revision: counter('row:catalog-tab-binding', '0'), updated_at: new Date(0),
    payload: { type: 'browser', id: streamPage, title: 'Stored Ops',
      browserWorkspaceId: streamPage, browserPageId: streamPage, browserProfileId: 'default',
      url: `${streamOrigin}/ops/`, loading: false, canGoBack: false, canGoForward: false, isActive: false },
    launch_request: { method: 'browser.tabCreate', paramsSupplied: true,
      params: { worktree: `id:${streamWorkspace}`, page: streamPage, url: `${streamOrigin}/ops/`, profileId: 'default' } } }
  return { workspace, tab }
}

/** Explicit SQL read double. Every unrecognized SQL statement fails; no PG/native process is started. */
export function streamRecoveryReadPool() {
  const rows = streamRecoveryRows()
  const state = { missing: false, dataset: 'orca-1012-dev-v1', fail: false,
    connects: 0, releases: 0, activeTransactions: 0, beforeConnect: null as (() => Promise<void>) | null }
  const sql: string[] = []
  const pool = { async connect() {
    assert.equal(this, pool); state.connects++
    await state.beforeConnect?.()
    return { async query(statement: string, values: readonly unknown[] = []) {
      sql.push(statement)
      if (state.fail) { throw Object.assign(new Error('Synthetic PG failure'), { code: '08006' }) }
      let result: unknown[] = []
      if (statement.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')) { state.activeTransactions++ }
      else if (statement === 'COMMIT' || statement === 'ROLLBACK') { state.activeTransactions-- }
      else if (statement.includes('FROM durable_runtime.dataset_metadata')) { result = [{ dataset_name: state.dataset }] }
      else if (statement.includes('FROM durable_runtime.catalog_workspace_metadata')) { result = [rows.workspace] }
      else if (statement.includes('FROM durable_runtime.workspace_aliases')) { result = [] }
      else if (statement.includes('FROM durable_runtime.workspaces WHERE id=')) {
        result = [{ id: rows.workspace.workspace_id, dataset_name: state.dataset }]
      } else if (statement.includes('FROM durable_runtime.catalog_tab_metadata')) {
        result = !state.missing && values[0] === rows.tab.public_tab_id ? [rows.tab] : []
      } else { throw new Error('Unexpected recovery fixture SQL') }
      return { rows: structuredClone(result), command: statement === 'COMMIT' ? 'COMMIT' : 'SELECT', rowCount: result.length }
    }, release() { state.releases++ } }
  }, query() { throw new Error('Recovery must use the captured connect receiver') } }
  return { pool: pool as unknown as Pool, state, sql, ...rows }
}

/** Existing actual registry/process with explicit synthetic native/CDP driver; never real Chrome. */
export function streamRecoveryNative(worktreePublicId: string) {
  const session = new CompositionNativeSession(), tabs = new ExternalChromiumTabRegistry(session, async () => {})
  const process = new ExternalChromiumBrowserProcess('unused', { executablePath: 'unused', provider: 'chromium' }, 'unused')
  Reflect.set(process, 'session', session); Reflect.set(process, 'tabs', tabs); Reflect.set(process, 'available', true)
  const selection: unknown[] = []
  const host = { resolveWorktreeSelector: async (id: string) => ({ id: id.replace(/^id:/, '') }),
    markHeadlessBrowserSessionTabActive: (...args: unknown[]) => { selection.push(args) },
    notifyHeadlessBrowserSessionTabsChanged() {} } as unknown as RuntimeBrowserCommandHost
  const owner = fixtureRuntime(), commands = process.createCommands(host)
  Object.defineProperty(owner.runtime, 'browserTabCreate', { configurable: true, value: commands.browserTabCreate })
  Object.defineProperty(owner.runtime, 'browserTabShow', { configurable: true, value: commands.browserTabShow })
  const authority = createOpsBrowserSessionAuthority({ datasetName: 'orca-1012-dev-v1', namespaceId: 'stream-recovery', workspaceIds: [] })
  let issues = 0
  const issuer = { origin: streamOrigin, issuePageSession(input: Parameters<typeof authority.issuePageSession>[0]) {
    assert.equal(this, issuer); issues++; return authority.issuePageSession(input)
  } }
  return { ...owner, session, tabs, commands, host, authority, issuer, selection, issues: () => issues,
    config: (pool: Pool) => ({ ...fixtureConfig(pool), workspacePublicIds: [worktreePublicId], browserOpsAuth: issuer }),
    stop: async () => { await process.stop(); authority.close() } }
}
