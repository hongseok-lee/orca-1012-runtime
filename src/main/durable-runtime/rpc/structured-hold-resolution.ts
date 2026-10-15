import type { CatalogAuthority } from '../catalog/authority.ts'
import { resolveCatalogWorkspace } from '../catalog/read.ts'
import { parseCatalogRepo, parseCatalogWorkspace } from '../catalog/payload.ts'
import { projectCatalogWorktree } from '../catalog/projection.ts'
import type { CatalogRepositoryRow } from '../db/rows.ts'
import { DurableTransaction, safeDatabaseError } from '../db/connection.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../../../shared/execution-host.ts'
import { CatalogReadError, type CapturedCatalogReadConfig } from './config.ts'

/** Target authorization only: no history fold, lifecycle gate or native/compute access. */
export function createCatalogStructuredHoldResolver(config: CapturedCatalogReadConfig) {
  const owner = config.pool, connect = owner.connect.bind(owner)
  const assertCurrentHost = config.assertCurrentHost.bind(config)
  return async (publicSessionId: string, authority: CatalogAuthority): Promise<void> => {
    assertCurrentHost()
    const client = await connect().catch(error => { throw safeDatabaseError(error) })
    const tx = new DurableTransaction(client)
    let destroy = false, committed = false
    try {
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const dataset = (await tx.query<{ dataset_name: string }>('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows
      if (dataset.length !== 1 || dataset[0].dataset_name !== config.datasetName) {
        throw new CatalogReadError('CATALOG_DATASET_MISMATCH')
      }
      const found = await tx.query<{
        public_session_id: string; session_id: string; workspace_id: string; actual_workspace_id: string;
        public_id: string; provider: string; actual_provider: string; execution_host_id: string;
        agent_dataset: string; workspace_dataset: string
      }>(`SELECT a.public_session_id,a.session_id,a.workspace_id,a.provider,a.execution_host_id,
        s.workspace_id AS actual_workspace_id,w.public_id,g.provider AS actual_provider,
        g.dataset_name AS agent_dataset,w.dataset_name AS workspace_dataset
        FROM durable_runtime.structured_session_aliases a JOIN durable_runtime.sessions s ON s.id=a.session_id
        JOIN durable_runtime.workspaces w ON w.id=s.workspace_id JOIN durable_runtime.agents g ON g.id=s.agent_id
        WHERE a.public_session_id=$1`, [publicSessionId])
      const row = found.rows[0]
      if (found.rows.length !== 1 || row.public_session_id !== publicSessionId || row.workspace_id !== row.actual_workspace_id ||
          row.agent_dataset !== config.datasetName || row.workspace_dataset !== config.datasetName ||
          row.provider !== row.actual_provider || (row.provider !== 'claude' && row.provider !== 'codex') ||
          row.execution_host_id !== config.hostId) {
        throw new CatalogReadError('STRUCTURED_HOLD_ALIAS_SCOPE')
      }
      logicalId('session', row.session_id)
      logicalId('workspace', row.workspace_id)
      const workspace = await resolveCatalogWorkspace(tx, `id:${row.public_id}`, authority)
      if (workspace.deleted_at !== null || workspace.workspace_id !== row.workspace_id || workspace.public_id !== row.public_id) {
        throw new CatalogReadError('CATALOG_WORKSPACE_UNAVAILABLE')
      }
      const payload = parseCatalogWorkspace(workspace)
      if (payload.id !== row.public_id || ('repoId' in payload && payload.repoId !== workspace.repo_id) ||
          ('projectGroupId' in payload && payload.projectGroupId !== workspace.project_group_id)) {
        throw new CatalogReadError('STRUCTURED_HOLD_ALIAS_SCOPE')
      }
      let repository: ReturnType<typeof parseCatalogRepo> | undefined
      if (workspace.repo_id !== null) {
        const rows = (await tx.query<CatalogRepositoryRow>(
          'SELECT * FROM durable_runtime.catalog_repositories WHERE id=$1 AND deleted_at IS NULL', [workspace.repo_id])).rows
        if (rows.length !== 1) { throw new CatalogReadError('CATALOG_REPOSITORY_UNAVAILABLE') }
        repository = parseCatalogRepo(rows[0])
        if (getRepoExecutionHostId(repository) !== config.hostId) { throw new CatalogReadError('CATALOG_REGISTRATION_HOST_MISMATCH') }
      }
      if (getWorktreeExecutionHostId(projectCatalogWorktree(workspace), repository) !== config.hostId) {
        throw new CatalogReadError('CATALOG_REGISTRATION_HOST_MISMATCH')
      }
      assertCurrentHost()
      await tx.query('COMMIT')
      committed = true
      assertCurrentHost()
    } catch (error) {
      if (!committed) { try { await client.query('ROLLBACK') } catch { destroy = true } }
      throw error
    } finally { tx.close(); client.release(destroy) }
  }
}
