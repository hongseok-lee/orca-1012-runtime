import type { Pool } from 'pg'
import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import type { RuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import type { OrcadBrowserProvider } from './orcad-browser-provider'
import type { CapturedCatalogReadConfig, DurableCatalogReadConfig } from '../durable-runtime/rpc/config.ts'
import { captureDurableCatalogReadConfig } from '../durable-runtime/rpc/config.ts'
import type { CatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import { captureCatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import { resolveCatalogWorkspace, withCatalogReadSnapshot } from '../durable-runtime/catalog/read.ts'
import { parseCatalogRepo } from '../durable-runtime/catalog/payload.ts'
import { projectCatalogWorktree } from '../durable-runtime/catalog/projection.ts'
import type { CatalogRepositoryRow } from '../durable-runtime/db/rows.ts'
import { CatalogError } from '../durable-runtime/catalog/errors.ts'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../../shared/execution-host.ts'
import { createOrcadCatalogBrowserPublication } from './orcad-catalog-browser-publication.ts'

type BrowserWorkspace = Awaited<ReturnType<RuntimeBrowserCommandHost['resolveWorktreeSelector']>>

/** Startup registration only: never accepts a request principal, token or authority. */
function captureBrowserWorkspaceResolver(config: CapturedCatalogReadConfig): (selector: string) => Promise<BrowserWorkspace> {
  const datasetName = config.datasetName
  const hostId = config.hostId
  const assertCurrentHost = config.assertCurrentHost.bind(config)
  const ownerPool = config.pool
  const connect = ownerPool.connect.bind(ownerPool)
  // The read helper only borrows connect. Its receiver is captured before any await;
  // neither this facade nor a browser subscriber owns Pool.end.
  const pool = new Proxy(ownerPool, {
    get(target, property) {
      return property === 'connect' ? connect : Reflect.get(target, property, target)
    }
  }) satisfies Pool
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Captured server registration only, matching the existing private Ops scope pattern; not a user authority issuer.
  const authority = captureCatalogAuthority({ principalId: 'orcad-browser-startup-registration',
    repositoryIds: config.repositoryIds, projectGroupIds: config.projectGroupIds,
    workspacePublicIds: config.workspacePublicIds } as CatalogAuthority)
  assertCurrentHost()

  return async (selector) => {
    assertCurrentHost()
    const result = await withCatalogReadSnapshot(pool, async tx => {
      const datasets = (await tx.query<{ dataset_name: string }>(
        'SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows
      if (datasets.length !== 1 || datasets[0].dataset_name !== datasetName) {
        throw new CatalogError('CATALOG_BROWSER_DATASET_MISMATCH')
      }
      const workspace = await resolveCatalogWorkspace(tx, selector, authority)
      if (workspace.deleted_at !== null) { throw new CatalogError('CATALOG_WORKSPACE_DELETED') }
      const actual = (await tx.query<{ id: string; dataset_name: string }>(
        'SELECT id,dataset_name FROM durable_runtime.workspaces WHERE id=$1', [workspace.workspace_id])).rows
      if (actual.length !== 1 || actual[0].id !== workspace.workspace_id || actual[0].dataset_name !== datasetName) {
        throw new CatalogError('CATALOG_BROWSER_WORKSPACE_DATASET_MISMATCH')
      }
      let repository: ReturnType<typeof parseCatalogRepo> | undefined
      if (workspace.repo_id !== null) {
        const rows = (await tx.query<CatalogRepositoryRow>(
          'SELECT * FROM durable_runtime.catalog_repositories WHERE id=$1 AND deleted_at IS NULL',
          [workspace.repo_id])).rows
        if (rows.length !== 1 || rows[0].id !== workspace.repo_id) {
          throw new CatalogError('CATALOG_BROWSER_REPOSITORY_UNAVAILABLE')
        }
        repository = parseCatalogRepo(rows[0])
        if (getRepoExecutionHostId(repository) !== hostId) {
          throw new CatalogError('CATALOG_REGISTRATION_HOST_MISMATCH')
        }
      } else if (workspace.kind !== 'FOLDER_WORKSPACE') {
        throw new CatalogError('CATALOG_BROWSER_REPOSITORY_UNAVAILABLE')
      }
      const projected = projectCatalogWorktree(workspace)
      if (projected.id !== workspace.public_id || projected.path !== workspace.reserved_path ||
          (workspace.repo_id !== null && projected.repoId !== workspace.repo_id)) {
        throw new CatalogError('CATALOG_BROWSER_WORKSPACE_SHAPE')
      }
      const actualHost = getWorktreeExecutionHostId(projected, repository)
      if (actualHost !== hostId) { throw new CatalogError('CATALOG_REGISTRATION_HOST_MISMATCH') }
      // PENDING is a valid logical Workspace. No readiness, wake or activity mutation.
      return { id: workspace.public_id, hostId,
        ...(workspace.repo_id === null ? {} : { repoId: workspace.repo_id }) }
    })
    assertCurrentHost()
    return result
  }
}

/** Install both Workspace resolvers and publication guard from one startup capture. */
export function createOrcadCatalogBrowserFactory(
  provider: OrcadBrowserProvider | null,
  input?: DurableCatalogReadConfig
): RuntimeBrowserCommandsFactory | null {
  if (!provider || provider.kind !== 'chromium' || !input) { return provider?.factory ?? null }
  const factory = provider.factory.bind(provider)
  const config = captureDurableCatalogReadConfig(input)
  const resolve = captureBrowserWorkspaceResolver(config)
  const withBrowserTabPublication = createOrcadCatalogBrowserPublication(config)
  return (host) => {
    // A separate inherited carrier also supports nonconfigurable methods on an
    // immutable owner. Every read still uses the original host receiver.
    const carrier: RuntimeBrowserCommandHost = Object.create(host)
    return factory(new Proxy(carrier, {
      get(_target, property) {
        if (property === 'resolveWorktreeSelector' || property === 'resolveBrowserWorkspace') { return resolve }
        if (property === 'withBrowserTabPublication') { return withBrowserTabPublication }
        const value = Reflect.get(host, property, host)
        return typeof value === 'function' ? value.bind(host) : value
      }
    }))
  }
}
