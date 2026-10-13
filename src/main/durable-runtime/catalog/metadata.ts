import type { Pool } from 'pg'
import type { JsonValue, MutationOutcome } from '../db/atomic.ts'
import { runDurableMutation } from '../db/atomic.ts'
import type { CatalogTab } from './read.ts'
import { capturePreparedCatalogCall, lockCatalogWorkspaceMetadata, mutateCatalogWorkspace, publishCatalogMutation } from './mutation.ts'
import { catalogReceiptIdentity, type PreparedCatalogCall, type ResolvedCatalogScope } from './request.ts'
import { captureCatalogJson } from './immutable.ts'
import { parseCatalogTab, parseCatalogWorkspace } from './payload.ts'
import { parseCatalogUi, catalogSharedUi } from './ui.ts'
import { lockCatalogMetadata } from './heads.ts'
import { CatalogError } from './errors.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { readWorkspaceTabsInTransaction } from './projection.ts'

export async function loadCatalogTabs(tx: DurableTransaction, workspaceId: string): Promise<CatalogTab[]> {
  return (await tx.query<CatalogTab>(`SELECT m.*,t.workspace_id,t.session_id,t.kind,t.terminal_handle,
    t.lifecycle,t.revision AS tab_revision FROM durable_runtime.catalog_tab_metadata m
    JOIN durable_runtime.tabs t ON t.id=m.tab_id WHERE t.workspace_id=$1 ORDER BY t.ui_order,t.id`, [workspaceId])).rows
}

export function resolveCatalogTab(rows: readonly CatalogTab[], selector: { tabId?: string; leafId?: string; terminal?: string }): CatalogTab {
  const matches = rows.filter(row => {
    const payload = parseCatalogTab(row)
    if (selector.terminal !== undefined) {return row.terminal_handle === selector.terminal}
    return (row.public_tab_id === selector.tabId || (payload.type === 'terminal' && payload.parentTabId === selector.tabId)) &&
      (selector.leafId === undefined || (payload.type === 'terminal' && payload.leafId === selector.leafId))
  })
  if (matches.length !== 1) {throw new CatalogError(matches.length ? 'CATALOG_TAB_AMBIGUOUS' : 'CATALOG_TAB_NOT_FOUND')}
  return matches[0]
}

/** User fields only; path/name identity, Git/provider state and activity are not overwritten. */
export async function updateCatalogWorkspace(pool: Pool, input: PreparedCatalogCall<'worktree.set'>): Promise<MutationOutcome> {
  const call = capturePreparedCatalogCall(input)
  const patch = captureCatalogJson(Object.fromEntries(Object.entries(call.params).filter(([key]) => key !== 'worktree')))
  const allowed = new Set(['displayName', 'comment', 'linkedIssue', 'linkedPR', 'linkedLinearIssue',
    'linkedLinearIssueWorkspaceId', 'linkedLinearIssueOrganizationUrlKey', 'linkedGitLabMR', 'linkedGitLabIssue',
    'linkedBitbucketPR', 'linkedAzureDevOpsPR', 'linkedGiteaPR', 'linkedWorkItem', 'linkedTaskSourceContext',
    'isArchived', 'isUnread', 'isPinned', 'sortOrder', 'manualOrder', 'workspaceStatus', 'diffComments', 'mobileDiffReview'])
  if (Object.keys(patch as object).some(key => !allowed.has(key))) {throw new CatalogError('CATALOG_SET_FIELD_UNAVAILABLE')}
  return mutateCatalogWorkspace(pool, call, call.params.worktree, async (tx, workspace, membership) => {
    await lockCatalogWorkspaceMetadata(tx, membership)
    const current = (await tx.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM durable_runtime.catalog_workspace_metadata WHERE workspace_id=$1', [workspace.workspace_id])).rows[0]
    const payload = captureCatalogJson({ ...current.payload, ...patch as object }) as Record<string, unknown>
    const worktree = parseCatalogWorkspace({ ...workspace, payload })
    if (workspace.kind === 'FOLDER_WORKSPACE') {throw new CatalogError('CATALOG_GIT_WORKSPACE_REQUIRED')}
    await tx.query('UPDATE durable_runtime.catalog_workspace_metadata SET payload=$2,updated_at=clock_timestamp() WHERE workspace_id=$1',
      [workspace.workspace_id, JSON.stringify(payload)])
    await tx.query('UPDATE durable_runtime.workspaces SET revision=revision+1 WHERE id=$1', [workspace.workspace_id])
    const response = captureCatalogJson({ worktree })
    await publishCatalogMutation(tx, call, workspace.workspace_id, 'CATALOG_WORKSPACE_UPDATED', response)
    return response
  })
}

export async function updateCatalogUi(pool: Pool, input: PreparedCatalogCall<'ui.set'>): Promise<MutationOutcome> {
  const call = capturePreparedCatalogCall(input)
  const patch = catalogSharedUi(call.params)
  return runDurableMutation(pool, { ...catalogReceiptIdentity(call, 'ui:host' as ResolvedCatalogScope), locks: {} }, async tx => {
    await lockCatalogMetadata(tx, ['ui:host'])
    const row = (await tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM durable_runtime.catalog_ui_state WHERE scope='host' FOR UPDATE")).rows[0]
    if (!row) {throw new CatalogError('CATALOG_UI_NOT_INITIALIZED')}
    const ui = parseCatalogUi({ ...row.payload, ...patch })
    await tx.query("UPDATE durable_runtime.catalog_ui_state SET payload=$1,revision=revision+1 WHERE scope='host'", [JSON.stringify(ui)])
    const response = captureCatalogJson({ ui })
    await publishCatalogMutation(tx, call, null, 'CATALOG_UI_UPDATED', response, ['ui:host'])
    return response
  })
}

export async function selectCatalogTab(
  pool: Pool, input: PreparedCatalogCall<'session.tabs.activate'> | PreparedCatalogCall<'terminal.focus'>,
  workspaceSelector?: string
): Promise<MutationOutcome> {
  const call = capturePreparedCatalogCall(input)
  const selector = call.method === 'session.tabs.activate' ? (call.params as PreparedCatalogCall<'session.tabs.activate'>['params']).worktree : workspaceSelector
  if (!selector) {throw new CatalogError('CATALOG_WORKSPACE_SELECTOR_REQUIRED')}
  return mutateCatalogWorkspace(pool, call, selector, async (tx, workspace, membership) => {
    await lockCatalogWorkspaceMetadata(tx, membership)
    const tabs = await loadCatalogTabs(tx, workspace.workspace_id)
    const selected = resolveCatalogTab(tabs, call.params)
    if (selected.lifecycle !== 'OPEN') {throw new CatalogError('CATALOG_TAB_CLOSED')}
    if ('expectedIncarnationId' in call.params && call.params.expectedIncarnationId !== undefined &&
      selected.payload.incarnationId !== call.params.expectedIncarnationId) {throw new CatalogError('CATALOG_STALE_TERMINAL')}
    for (const tab of tabs.filter(row => row.lifecycle === 'OPEN')) {
      const payload = { ...tab.payload, isActive: tab.tab_id === selected.tab_id }
      await tx.query('UPDATE durable_runtime.catalog_tab_metadata SET payload=$2,updated_at=clock_timestamp() WHERE tab_id=$1',
        [tab.tab_id, JSON.stringify(payload)])
    }
    await publishCatalogMutation(tx, call, workspace.workspace_id, 'CATALOG_TAB_SELECTED', { tabId: selected.public_tab_id })
    if (call.method === 'terminal.focus') {
      const terminal = parseCatalogTab(selected)
      if (terminal.type !== 'terminal') {throw new CatalogError('CATALOG_TERMINAL_REQUIRED')}
      return { focus: { handle: selected.terminal_handle!, tabId: terminal.parentTabId, worktreeId: workspace.public_id } }
    }
    // The adapter reads its response inside this same transaction via the shared projector.
    return captureCatalogJson(await readWorkspaceTabsInTransaction(tx, workspace))
  })
}

/** Upper adapter resolves a stable handle to this workspace; no live PTY lookup. */
export async function renameCatalogTerminal(
  pool: Pool, input: PreparedCatalogCall<'terminal.rename'>, workspaceSelector: string
): Promise<MutationOutcome> {
  const call = capturePreparedCatalogCall(input)
  const selector = workspaceSelector
  return mutateCatalogWorkspace(pool, call, selector, async (tx, workspace, membership) => {
    await lockCatalogWorkspaceMetadata(tx, membership)
    const tab = resolveCatalogTab(await loadCatalogTabs(tx, workspace.workspace_id), call.params)
    if (tab.lifecycle !== 'OPEN') {throw new CatalogError('CATALOG_TAB_CLOSED')}
    if (call.params.expectedIncarnationId !== undefined && tab.payload.incarnationId !== call.params.expectedIncarnationId) {throw new CatalogError('CATALOG_STALE_TERMINAL')}
    const title = call.params.title
    const payload = captureCatalogJson({ ...tab.payload, title: title ?? '' })
    await tx.query('UPDATE durable_runtime.catalog_tab_metadata SET payload=$2,updated_at=clock_timestamp() WHERE tab_id=$1',
      [tab.tab_id, JSON.stringify(payload)])
    const publicTab = parseCatalogTab(tab)
    if (publicTab.type !== 'terminal') {throw new CatalogError('CATALOG_TERMINAL_REQUIRED')}
    const response: JsonValue = { rename: { handle: call.params.terminal, tabId: publicTab.parentTabId, title } }
    await publishCatalogMutation(tx, call, workspace.workspace_id, 'CATALOG_TERMINAL_RENAMED', response)
    return response
  })
}

export async function activateCatalogWorkspace(pool: Pool, input: PreparedCatalogCall<'worktree.activate'>): Promise<MutationOutcome> {
  const call = capturePreparedCatalogCall(input)
  return mutateCatalogWorkspace(pool, call, call.params.worktree, async (tx, workspace, membership) => {
    await lockCatalogWorkspaceMetadata(tx, membership, ['ui:host'])
    const row = (await tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM durable_runtime.catalog_ui_state WHERE scope='host' FOR UPDATE")).rows[0]
    if (!row) {throw new CatalogError('CATALOG_UI_NOT_INITIALIZED')}
    const worktree = parseCatalogWorkspace(workspace)
    const repoId = 'repoId' in worktree ? worktree.repoId : `folder-workspace:${worktree.projectGroupId}`
    const ui = parseCatalogUi({ ...row.payload, lastActiveRepoId: repoId, lastActiveWorktreeId: workspace.public_id })
    await tx.query("UPDATE durable_runtime.catalog_ui_state SET payload=$1,revision=revision+1 WHERE scope='host'", [JSON.stringify(ui)])
    const response: JsonValue = { repoId, worktreeId: workspace.public_id, activated: true, sleepingAgentWake: 'not-applicable' }
    await publishCatalogMutation(tx, call, workspace.workspace_id, 'CATALOG_WORKSPACE_SELECTED', response, ['ui:host'])
    return response
  })
}
