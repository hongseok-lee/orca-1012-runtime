import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../db/connection.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import { resolveCatalogWorkspace, type CatalogTab } from '../catalog/read.ts'
import { parseCatalogTab, parseCatalogWorkspace, parseCatalogRepo } from '../catalog/payload.ts'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../../../shared/execution-host.ts'
import { projectCatalogWorktree } from '../catalog/projection.ts'
import type { CatalogRepositoryRow } from '../db/rows.ts'
import { captureCatalogReadContext } from './context.ts'
import { CatalogReadError, type CapturedCatalogReadConfig } from './config.ts'
import { capturedJson } from '../structured/durable-common.ts'
import { TerminalDraftStoreError } from '../terminal/durable-contracts.ts'

/** Shared authenticated logical target for input and subscription. Null means
 * genuinely unowned; incomplete managed metadata must never fall back to a PTY.
 * Lifecycle is returned rather than rejected so original input receipts remain
 * readable after close. New mutations/subscriptions enforce their own lifecycle. */
export async function resolveCatalogTerminalTarget(
  tx: DurableTransaction, config: CapturedCatalogReadConfig, context: RpcContext,
  terminal: string, assertCurrent: () => void
) {
  const owned = await tx.query('SELECT id FROM durable_runtime.tabs WHERE terminal_handle=$1', [terminal])
  if (owned.rows.length === 0) { return null }
  const found = await tx.query<CatalogTab & {public_id: string; provider: string | null; session_fence: string; dataset_name: string; agent_dataset: string | null}>(
    `SELECT m.*,t.workspace_id,t.session_id,t.kind,t.terminal_handle,t.lifecycle,t.revision AS tab_revision,
     w.public_id,w.dataset_name,s.session_fence,g.provider,g.dataset_name AS agent_dataset FROM durable_runtime.tabs t
     JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id
     LEFT JOIN durable_runtime.sessions s ON s.id=t.session_id LEFT JOIN durable_runtime.agents g ON g.id=s.agent_id
     JOIN durable_runtime.workspaces w ON w.id=t.workspace_id WHERE t.terminal_handle=$1`, [terminal])
  if (found.rows.length !== 1) { throw new TerminalDraftStoreError('TERMINAL_MANAGED_TARGET_INCOMPLETE') }
  assertCurrent()
  const row = found.rows[0]
  const call = (() => {
    try { return captureCatalogReadContext(config, context) }
    catch (error) {
      // Preserve known admission failures through the durable transaction
      // wrapper; unknown failures still follow its sanitized DB error path.
      if (error instanceof CatalogReadError) { throw new TerminalDraftStoreError(error.code) }
      throw error
    }
  })()
  const dataset = await tx.query<{dataset_name: string}>('SELECT dataset_name FROM durable_runtime.dataset_metadata')
  if (dataset.rows.length !== 1 || dataset.rows[0].dataset_name !== config.datasetName || row.dataset_name !== config.datasetName || row.agent_dataset !== config.datasetName || !row.session_id) {
    throw new TerminalDraftStoreError('CATALOG_DATASET_MISMATCH')
  }
  const workspace = await resolveCatalogWorkspace(tx, `id:${row.public_id}`, call.authority)
  if (workspace.workspace_id !== row.workspace_id) { throw new TerminalDraftStoreError('TERMINAL_WORKSPACE_SCOPE') }
  parseCatalogWorkspace(workspace)
  let repository: ReturnType<typeof parseCatalogRepo> | undefined
  if (workspace.repo_id !== null) {
    const stored = (await tx.query<CatalogRepositoryRow>('SELECT * FROM durable_runtime.catalog_repositories WHERE id=$1', [workspace.repo_id])).rows[0]
    if (!stored) { throw new TerminalDraftStoreError('CATALOG_REPOSITORY_UNAVAILABLE') }
    repository = parseCatalogRepo(stored)
    if (getRepoExecutionHostId(repository) !== config.hostId) { throw new TerminalDraftStoreError('CATALOG_REGISTRATION_HOST_MISMATCH') }
  }
  if (getWorktreeExecutionHostId(projectCatalogWorktree(workspace), repository) !== config.hostId) { throw new TerminalDraftStoreError('CATALOG_REGISTRATION_HOST_MISMATCH') }
  const tab = parseCatalogTab(row)
  // Provider identity does not select input semantics. Missing viewMode
  // has the client's normal Terminal meaning, never an implicit Chat send.
  const chat = tab.type === 'terminal' && tab.viewMode === 'chat' &&
    (row.provider === 'claude' || row.provider === 'codex')
  return Object.freeze({sessionId: logicalId('session', row.session_id), sessionFence: counter('session-fence', row.session_fence), chat,
    lifecycle: row.lifecycle,
    targetPin: Object.freeze({tabId: row.tab_id, tabRevision: row.tab_revision, bindingRevision: row.binding_revision,
      provider: row.provider, payload: capturedJson(row.payload)})})
}
