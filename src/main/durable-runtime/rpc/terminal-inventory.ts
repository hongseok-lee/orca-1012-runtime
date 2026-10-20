import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { RuntimeTerminalListResult, RuntimeTerminalSummary } from '../../../shared/runtime-terminal-contracts.ts'
import { TerminalListParams } from '../../../shared/rpc-contract/terminal-unary-params.ts'
import { readCatalogSnapshot } from '../catalog/read.ts'
import { projectCatalogTabs, projectCatalogWorktree } from '../catalog/projection.ts'
import { buildRuntimeTerminalVisualLayouts } from '../../runtime/runtime-terminal-visual-layout.ts'
import { captureReadInvocation, resolveReadWorkspace, validateCatalogSnapshot } from './read.ts'
import { CatalogReadError, type CapturedCatalogReadConfig } from './config.ts'
import { capturedJson } from '../structured/durable-common.ts'

/** Logical inventory comes from the same authorized Catalog as tabs and streams.
 * connected/writable are mobile compatibility projections, not Pod liveness or
 * a raw write grant. Actual writes still require the current execution/floor. */
export function createCatalogTerminalInventory(config: CapturedCatalogReadConfig) {
  return async (original: unknown, context: RpcContext): Promise<RuntimeTerminalListResult> => {
    const params = TerminalListParams.parse(capturedJson(original ?? {}))
    const maximum = params.limit ?? 1000
    if (!Number.isInteger(maximum) || maximum < 1) { throw new CatalogReadError('invalid_limit') }
    const invocation = captureReadInvocation(config, params, context)
    const canonical = params.worktree ? await resolveReadWorkspace(config, invocation, params.worktree) : null
    const snapshot = await readCatalogSnapshot(config.pool, invocation.context.authority)
    validateCatalogSnapshot(config, snapshot)
    if (context.signal?.aborted) { throw new CatalogReadError('TERMINAL_SUBSCRIPTION_ABORTED') }
    const workspaces = snapshot.workspaces.filter(row => !canonical || row.workspace_id === canonical.workspace_id)
    if (canonical && !workspaces.length) { throw new CatalogReadError('CATALOG_WORKSPACE_UNAVAILABLE') }
    const worktrees = new Map(workspaces.map(row => [row.public_id, projectCatalogWorktree(row)]))
    const snapshots = workspaces.map(row => projectCatalogTabs(snapshot, row))
    const handles = params.handles ? new Set(params.handles) : null
    const summaries: RuntimeTerminalSummary[] = []
    for (const row of snapshot.tabs) {
      if (row.lifecycle !== 'OPEN' || !row.terminal_handle) { continue }
      const workspace = workspaces.find(candidate => candidate.workspace_id === row.workspace_id)
      if (!workspace || handles && !handles.has(row.terminal_handle)) { continue }
      const tab = snapshots.find(candidate => candidate.worktree === workspace.public_id)?.tabs.find(candidate => candidate.id === row.public_tab_id)
      if (!tab || tab.type !== 'terminal') { continue }
      const worktree = worktrees.get(workspace.public_id)!
      summaries.push({ handle: row.terminal_handle, ptyId: null, incarnationId: null,
        worktreeId: workspace.public_id, worktreePath: worktree.path, branch: worktree.branch,
        tabId: tab.parentTabId, leafId: tab.leafId, title: tab.title,
        connected: params.requireFreshPtyLiveness !== true, writable: params.requireFreshPtyLiveness !== true,
        lastOutputAt: null, preview: '', executionHostId: config.hostId,
        ...(tab.launchAgent ? {agentIdentity: tab.launchAgent} : {}) })
    }
    const terminals = summaries.slice(0, maximum)
    const titles = new Map(terminals.map(row => [row.tabId, row.title]))
    return { terminals, totalCount: summaries.length, truncated: summaries.length > maximum,
      ...(params.includeVisualLayouts === false ? {} : { visualLayouts: buildRuntimeTerminalVisualLayouts({
        terminals, snapshots, worktreesById: worktrees, getTabTitle: id => titles.get(id) ?? null }) }),
      // No physical census was performed. In particular, a fresh-liveness request
      // must not convert the logical connected projection into execution proof.
      hostScope: { hostIds: [], omittedHostIds: [config.hostId] } }
  }
}
