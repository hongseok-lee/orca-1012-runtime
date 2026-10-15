import type { Pool } from 'pg'
import { DurableTransaction } from '../db/connection.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../../../shared/execution-host.ts'
import { resolveCatalogWorkspace } from '../catalog/read.ts'
import { parseCatalogRepo, parseCatalogWorkspace } from '../catalog/payload.ts'
import { projectCatalogWorktree } from '../catalog/projection.ts'
import type { CatalogAuthority } from '../catalog/authority.ts'
import type { CatalogRepositoryRow } from '../db/rows.ts'
import type { PreparedStructuredWire } from '../structured/wire.ts'
import type { StructuredWorkspaceExpectation } from '../structured/durable-types.ts'
import { CatalogReadError, type CapturedCatalogReadConfig } from './config.ts'

/** Actual Catalog authorization, including replay. Tombstones/fence/Unit are not auth filters. */
export async function resolveCatalogStructuredCancel(
  config: CapturedCatalogReadConfig, pool: Pool, wire: PreparedStructuredWire,
  authority: CatalogAuthority
): Promise<StructuredWorkspaceExpectation> {
  if (wire.target.kind !== 'SESSION') { throw new CatalogReadError('STRUCTURED_SESSION_SCOPE_REQUIRED') }
  const publicSessionId = wire.target.publicSessionId
  const client = await pool.connect(), tx = new DurableTransaction(client)
  let destroy = false
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const dataset = await tx.query<{ dataset_name: string }>('SELECT dataset_name FROM durable_runtime.dataset_metadata')
    if (dataset.rows.length !== 1 || dataset.rows[0].dataset_name !== config.datasetName) {
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
    if (found.rows.length !== 1 || row.public_session_id !== publicSessionId ||
        row.workspace_id !== row.actual_workspace_id || row.agent_dataset !== config.datasetName ||
        row.workspace_dataset !== config.datasetName || row.actual_provider !== row.provider ||
        (row.provider !== 'claude' && row.provider !== 'codex') || row.execution_host_id !== config.hostId) {
      throw new CatalogReadError('STRUCTURED_CANCEL_TARGET_SCOPE')
    }
    logicalId('session', row.session_id)
    const workspace = await resolveCatalogWorkspace(tx, `id:${row.public_id}`, authority)
    if (workspace.workspace_id !== row.workspace_id || workspace.public_id !== row.public_id) {
      throw new CatalogReadError('STRUCTURED_CANCEL_TARGET_SCOPE')
    }
    const payload = parseCatalogWorkspace(workspace)
    if (payload.id !== workspace.public_id || ('repoId' in payload && payload.repoId !== workspace.repo_id) ||
        ('projectGroupId' in payload && payload.projectGroupId !== workspace.project_group_id)) {
      throw new CatalogReadError('STRUCTURED_CANCEL_TARGET_SCOPE')
    }
    let repository: ReturnType<typeof parseCatalogRepo> | undefined
    if (workspace.repo_id !== null) {
      const storedRepository = (await tx.query<CatalogRepositoryRow>(
        'SELECT * FROM durable_runtime.catalog_repositories WHERE id=$1', [workspace.repo_id])).rows[0]
      if (!storedRepository) { throw new CatalogReadError('CATALOG_REPOSITORY_UNAVAILABLE') }
      repository = parseCatalogRepo(storedRepository)
      if (getRepoExecutionHostId(repository) !== config.hostId) { throw new CatalogReadError('CATALOG_REGISTRATION_HOST_MISMATCH') }
    }
    if (getWorktreeExecutionHostId(projectCatalogWorktree(workspace), repository) !== config.hostId) {
      throw new CatalogReadError('CATALOG_REGISTRATION_HOST_MISMATCH')
    }
    const expected: StructuredWorkspaceExpectation = Object.freeze({ workspaceId: logicalId('workspace', row.workspace_id),
      workspacePublicId: row.public_id, provider: row.provider, executionHostId: row.execution_host_id })
    config.assertCurrentHost()
    await tx.query('COMMIT')
    return expected
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { destroy = true }
    throw error
  } finally { tx.close(); client.release(destroy) }
}
