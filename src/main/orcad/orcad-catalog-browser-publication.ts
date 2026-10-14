import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import type { CapturedCatalogReadConfig } from '../durable-runtime/rpc/config.ts'
import { CatalogReadError } from '../durable-runtime/rpc/config.ts'
import type { CatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import { captureCatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import { resolveCatalogWorkspace, type CatalogTab } from '../durable-runtime/catalog/read.ts'
import { parseCatalogRepo, parseCatalogTab } from '../durable-runtime/catalog/payload.ts'
import { projectCatalogWorktree } from '../durable-runtime/catalog/projection.ts'
import type { CatalogRepositoryRow } from '../durable-runtime/db/rows.ts'
import { DurableTransaction, DurableDatabaseError, safeDatabaseError } from '../durable-runtime/db/connection.ts'
import { CatalogError } from '../durable-runtime/catalog/errors.ts'
import { BrowserError } from '../browser/browser-error'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../../shared/execution-host'

/** Private startup scope only. The returned hook is installed by the host owner later. */
export function createOrcadCatalogBrowserPublication(
  input: CapturedCatalogReadConfig
): NonNullable<RuntimeBrowserCommandHost['withBrowserTabPublication']> {
  const ownerPool = input.pool
  const connect = ownerPool.connect.bind(ownerPool)
  const assertCurrentHost = input.assertCurrentHost.bind(input)
  const datasetName = input.datasetName, hostId = input.hostId
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Private captured server startup registration, matching the host resolver; never a request authority issuer.
  const authority = captureCatalogAuthority({ principalId: 'orcad-browser-publication-startup-registration',
    repositoryIds: input.repositoryIds, projectGroupIds: input.projectGroupIds,
    workspacePublicIds: input.workspacePublicIds } as CatalogAuthority)
  assertCurrentHost()
  return async (worktreeId, browserPageId, publish) => {
    assertCurrentHost()
    if (!worktreeId || !browserPageId || typeof publish !== 'function') { throw new CatalogError('CATALOG_BROWSER_PUBLICATION_INPUT') }
    const client = await connect().catch(error => { throw safeDatabaseError(error) })
    const tx = new DurableTransaction(client)
    let destroy = false
    try {
      await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const datasets = (await tx.query<{ dataset_name: string }>(
        'SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows
      if (datasets.length !== 1 || datasets[0].dataset_name !== datasetName) { throw new CatalogError('CATALOG_BROWSER_DATASET_MISMATCH') }
      const resolved = await resolveCatalogWorkspace(tx, `id:${worktreeId}`, authority)
      // This exact order conflicts with close/remove's Workspace FOR UPDATE then Tab UPDATE.
      const locked = (await tx.query<{ id: string; public_id: string; dataset_name: string; deleted_at: Date | null }>(
        'SELECT id,public_id,dataset_name,deleted_at FROM durable_runtime.workspaces WHERE id=$1 FOR SHARE',
        [resolved.workspace_id])).rows
      if (locked.length !== 1 || locked[0].public_id !== worktreeId || locked[0].dataset_name !== datasetName) {
        throw new CatalogError('CATALOG_BROWSER_WORKSPACE_DATASET_MISMATCH')
      }
      const workspace = await resolveCatalogWorkspace(tx, `id:${worktreeId}`, authority)
      if (workspace.workspace_id !== locked[0].id) { throw new CatalogError('CATALOG_BROWSER_IDENTITY_CHANGED') }
      if (locked[0].deleted_at !== null || workspace.deleted_at !== null) { throw new CatalogError('CATALOG_WORKSPACE_DELETED') }
      const tabs = (await tx.query<CatalogTab>(`SELECT m.*,t.workspace_id,t.session_id,t.kind,t.terminal_handle,
        t.lifecycle,t.revision AS tab_revision FROM durable_runtime.catalog_tab_metadata m
        JOIN durable_runtime.tabs t ON t.id=m.tab_id WHERE m.public_tab_id=$1 FOR SHARE OF t`, [browserPageId])).rows
      if (tabs.length !== 1 || tabs[0].workspace_id !== workspace.workspace_id || tabs[0].kind !== 'browser') {
        throw new CatalogError('CATALOG_BROWSER_PAGE_CONFLICT')
      }
      const tab = parseCatalogTab(tabs[0])
      if (tab.type !== 'browser' || tab.id !== browserPageId || tab.browserPageId !== browserPageId ||
          tab.browserWorkspaceId !== browserPageId) { throw new CatalogError('CATALOG_BROWSER_PAGE_CONFLICT') }
      if (tabs[0].lifecycle !== 'OPEN') { throw new CatalogError('CATALOG_BROWSER_PAGE_CLOSED') }
      let repository: ReturnType<typeof parseCatalogRepo> | undefined
      if (workspace.repo_id !== null) {
        const rows = (await tx.query<CatalogRepositoryRow>(
          'SELECT * FROM durable_runtime.catalog_repositories WHERE id=$1 AND deleted_at IS NULL', [workspace.repo_id])).rows
        if (rows.length !== 1) { throw new CatalogError('CATALOG_BROWSER_REPOSITORY_UNAVAILABLE') }
        repository = parseCatalogRepo(rows[0])
        if (getRepoExecutionHostId(repository) !== hostId) { throw new CatalogError('CATALOG_REGISTRATION_HOST_MISMATCH') }
      } else if (workspace.kind !== 'FOLDER_WORKSPACE') { throw new CatalogError('CATALOG_BROWSER_REPOSITORY_UNAVAILABLE') }
      const projected = projectCatalogWorktree(workspace)
      if (projected.id !== worktreeId || projected.path !== workspace.reserved_path ||
          (workspace.repo_id !== null && projected.repoId !== workspace.repo_id)) { throw new CatalogError('CATALOG_BROWSER_WORKSPACE_SHAPE') }
      if (getWorktreeExecutionHostId(projected, repository) !== hostId) { throw new CatalogError('CATALOG_REGISTRATION_HOST_MISMATCH') }
      assertCurrentHost()
      // Locks remain held through this fixed registry callback. All native/CDP IO is already over.
      publish()
      if ((await tx.query('COMMIT')).command !== 'COMMIT') { throw new DurableDatabaseError('TX_NOT_COMMITTED') }
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { destroy = true }
      throw error instanceof CatalogError || error instanceof CatalogReadError || error instanceof BrowserError
        ? error : safeDatabaseError(error)
    } finally { tx.close(); client.release(destroy) }
  }
}
