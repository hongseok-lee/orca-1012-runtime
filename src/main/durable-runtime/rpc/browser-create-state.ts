import type { CapturedCatalogReadConfig } from './config.ts'
import type { PreparedCatalogCall } from '../catalog/request.ts'
import type { CatalogRepositoryRow } from '../db/rows.ts'
import type { CatalogTab, CatalogWorkspace } from '../catalog/read.ts'
import { resolveCatalogWorkspace, withCatalogReadSnapshot } from '../catalog/read.ts'
import { parseCatalogRepo, parseCatalogTab } from '../catalog/payload.ts'
import { projectCatalogWorktree } from '../catalog/projection.ts'
import { CatalogError } from '../catalog/errors.ts'
import { BrowserTabCreateParams } from '../../../shared/rpc-contract/browser-tab-create-params.ts'
import { normalizeBrowserNavigationUrl } from '../../../shared/browser-url.ts'
import { BrowserError } from '../../browser/browser-error.ts'

export function validateCatalogBrowserRequest(input: unknown) {
  const parsed = BrowserTabCreateParams.strict().safeParse(input)
  if (!parsed.success) { throw new CatalogError('CATALOG_PARAMS') }
  const params = parsed.data
  if (!params.worktree) { throw new CatalogError('CATALOG_WORKSPACE_SELECTOR_REQUIRED') }
  if (params.placement?.kind === 'client') {
    throw new BrowserError('browser_command_unavailable', 'Client-hosted browser placement is not supported.')
  }
  if (input !== null && typeof input === 'object' && 'placement' in input &&
      input.placement !== undefined && input.placement !== null && typeof input.placement === 'object' &&
      Object.keys(input.placement).some(key => key !== 'kind')) {
    throw new CatalogError('CATALOG_PARAMS')
  }
  if (params.profileId !== undefined && params.profileId !== 'default') {
    throw new BrowserError('browser_profile_unavailable', 'Only the default browser profile is available.')
  }
  if (!normalizeBrowserNavigationUrl(params.url ?? 'about:blank')) {
    throw new BrowserError('invalid_argument', 'Unsupported browser URL.')
  }
  return params
}

/** Authenticated resolver/PG data, including tombstones; never a request authority cast. */
export async function readCatalogBrowserState(
  config: CapturedCatalogReadConfig, call: PreparedCatalogCall<'browser.tabCreate'>,
  selector: string, page?: string
): Promise<{ workspace: CatalogWorkspace; tab?: CatalogTab }> {
  config.assertCurrentHost()
  const state = await withCatalogReadSnapshot(config.pool, async tx => {
    const datasets = (await tx.query<{ dataset_name: string }>(
      'SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows
    if (datasets.length !== 1 || datasets[0].dataset_name !== config.datasetName) {
      throw new CatalogError('CATALOG_BROWSER_DATASET_MISMATCH')
    }
    const workspace = await resolveCatalogWorkspace(tx, selector, call.context.authority)
    const actual = (await tx.query<{ id: string; dataset_name: string }>(
      'SELECT id,dataset_name FROM durable_runtime.workspaces WHERE id=$1', [workspace.workspace_id])).rows
    if (actual.length !== 1 || actual[0].id !== workspace.workspace_id || actual[0].dataset_name !== config.datasetName) {
      throw new CatalogError('CATALOG_BROWSER_WORKSPACE_DATASET_MISMATCH')
    }
    let repository: ReturnType<typeof parseCatalogRepo> | undefined
    if (workspace.repo_id !== null) {
      // Keep tombstones resolvable until the reservation core has checked its receipt.
      const rows = (await tx.query<CatalogRepositoryRow>(
        'SELECT * FROM durable_runtime.catalog_repositories WHERE id=$1', [workspace.repo_id])).rows
      if (rows.length !== 1 || rows[0].id !== workspace.repo_id) {
        throw new CatalogError('CATALOG_BROWSER_REPOSITORY_UNAVAILABLE')
      }
      repository = parseCatalogRepo(rows[0])
      if ((repository.executionHostId ?? 'local') !== config.hostId) {
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
    const actualHost = workspace.payload.hostId ?? workspace.payload.executionHostId ??
      repository?.executionHostId ?? 'local'
    if (actualHost !== config.hostId) { throw new CatalogError('CATALOG_REGISTRATION_HOST_MISMATCH') }
    if (page === undefined) { return { workspace } }
    const rows = (await tx.query<CatalogTab>(`SELECT m.*,t.workspace_id,t.session_id,t.kind,t.terminal_handle,
      t.lifecycle,t.revision AS tab_revision FROM durable_runtime.catalog_tab_metadata m
      JOIN durable_runtime.tabs t ON t.id=m.tab_id WHERE m.public_tab_id=$1`, [page])).rows
    if (rows.length !== 1 || rows[0].workspace_id !== workspace.workspace_id || rows[0].kind !== 'browser') {
      throw new CatalogError('CATALOG_BROWSER_PAGE_CONFLICT')
    }
    const tab = rows[0]
    const parsed = parseCatalogTab(tab)
    if (parsed.type !== 'browser' || parsed.id !== page || parsed.browserPageId !== page ||
        parsed.browserWorkspaceId !== page || tab.public_tab_id !== page) {
      throw new CatalogError('CATALOG_BROWSER_PAGE_CONFLICT')
    }
    return { workspace, tab }
  })
  config.assertCurrentHost()
  return state
}

/** Materialize the retained launch, not a later create's replacement URL/profile. */
export function catalogBrowserMaterialization(workspace: CatalogWorkspace, tab: CatalogTab) {
  const launch = tab.launch_request
  if (launch.method !== 'browser.tabCreate' || typeof launch.paramsSupplied !== 'boolean') {
    throw new CatalogError('CATALOG_BROWSER_LAUNCH_REQUEST')
  }
  const stored = validateCatalogBrowserRequest(launch.params)
  const url = normalizeBrowserNavigationUrl(stored.url ?? 'about:blank')
  if (!url || tab.payload.browserProfileId !== stored.profileId) {
    throw new CatalogError('CATALOG_BROWSER_LAUNCH_REQUEST')
  }
  if (stored.page !== undefined && stored.page !== tab.public_tab_id) {
    throw new CatalogError('CATALOG_BROWSER_PAGE_CONFLICT')
  }
  return { worktree: `id:${workspace.public_id}`, page: tab.public_tab_id, url,
    ...(stored.profileId === undefined ? {} : { profileId: stored.profileId }) }
}
