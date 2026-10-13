import type { Pool } from 'pg'
import type {
  CatalogHeadRow, CatalogProjectGroupRow, CatalogRepositoryRow,
  CatalogWorkspaceMetadataRow, CatalogTabMetadataRow, CatalogUiStateRow
} from '../db/rows.ts'
import { DurableTransaction, safeDatabaseError } from '../db/connection.ts'
import type { WorkspaceId } from '../../../shared/durable-runtime/identity.ts'
import type { Repo } from '../../../shared/repo-types.ts'
import type { ProjectGroup } from '../../../shared/project-group-types.ts'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types.ts'
import type { RuntimeWorktreeRecord } from '../../../shared/runtime-worktree-contracts.ts'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path.ts'
import { worktreeIdsEqual } from '../../../shared/worktree/id.ts'
import { branchSelectorMatches } from '../../runtime/runtime-worktree-path-identity.ts'
import { captureCatalogAuthority, type CatalogAuthority } from './authority.ts'
import { captureCatalogJson } from './immutable.ts'
import { catalogSnapshotVersion } from './revision.ts'
import { CatalogError } from './errors.ts'
import { parseCatalogRepo, parseCatalogGroup, parseCatalogWorkspace, parseCatalogTab } from './payload.ts'

export type CatalogWorkspace = CatalogWorkspaceMetadataRow & {
  public_id: string; name: string; workspace_revision: string
  provisioning_state: string; deleted_at: Date | null
}
export type CatalogTab = CatalogTabMetadataRow & {
  workspace_id: WorkspaceId; session_id: string | null; kind: string
  terminal_handle: string | null; lifecycle: 'OPEN' | 'CLOSED'; tab_revision: string
}
export type CatalogSnapshot = {
  readonly heads: readonly CatalogHeadRow[]
  readonly repositories: readonly Repo[]
  readonly projectGroups: readonly ProjectGroup[]
  readonly workspaces: readonly CatalogWorkspace[]
  readonly tabs: readonly CatalogTab[]
  readonly ui: CatalogUiStateRow | null
}

export async function withCatalogReadSnapshot<T>(pool: Pool, body: (tx: DurableTransaction) => Promise<T>): Promise<T> {
  const client = await pool.connect().catch(error => { throw safeDatabaseError(error) })
  const tx = new DurableTransaction(client)
  let destroy = false
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const result = await body(tx)
    await tx.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { destroy = true }
    throw error instanceof CatalogError ? error : safeDatabaseError(error)
  } finally {
    tx.close()
    client.release(destroy)
  }
}

export function catalogWorkspaceAllowed(authority: CatalogAuthority, row: CatalogWorkspace): boolean {
  return authority.workspacePublicIds.includes(row.public_id) ||
    (row.repo_id !== null && authority.repositoryIds.includes(row.repo_id)) ||
    (row.project_group_id !== null && authority.projectGroupIds.includes(row.project_group_id))
}

export async function loadCatalogWorkspaces(tx: DurableTransaction): Promise<CatalogWorkspace[]> {
  const result = await tx.query<CatalogWorkspace>(`SELECT m.*,w.public_id,w.name,
    w.revision AS workspace_revision,w.provisioning_state,w.deleted_at
    FROM durable_runtime.catalog_workspace_metadata m JOIN durable_runtime.workspaces w ON w.id=m.workspace_id
    ORDER BY w.public_id`)
  return result.rows
}

/** One resolver for aliases and every supported legacy selector; errors propagate. */
export async function resolveCatalogWorkspace(
  tx: DurableTransaction, selector: string, authority: CatalogAuthority
): Promise<CatalogWorkspace> {
  if (typeof selector !== 'string' || !selector) throw new CatalogError('CATALOG_SELECTOR')
  const rows = (await loadCatalogWorkspaces(tx)).filter(row => catalogWorkspaceAllowed(authority, row))
  if (selector === 'active') {
    const ui = (await tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM durable_runtime.catalog_ui_state WHERE scope='host'")).rows[0]
    const active = ui?.payload.lastActiveWorktreeId
    if (typeof active !== 'string' || !active) throw new CatalogError('selector_not_found')
    selector = `id:${active}`
  }
  const aliasKey = selector.startsWith('id:') ? selector.slice(3) : selector
  const aliases = await tx.query<{ workspace_id: WorkspaceId }>(
    'SELECT workspace_id FROM durable_runtime.workspace_aliases WHERE alias=$1 OR alias=$2',
    [aliasKey, selector]
  )
  const aliasIds = new Set(aliases.rows.map(row => row.workspace_id))
  const pathEqual = (left: string, right: string): boolean =>
    normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
  const matches = rows.filter(row => {
    const payload = parseCatalogWorkspace(row)
    const branch = 'branch' in payload ? payload.branch : ''
    const displayName = 'displayName' in payload ? payload.displayName : payload.name
    if (selector.startsWith('id:')) return worktreeIdsEqual(row.public_id, aliasKey) || aliasIds.has(row.workspace_id)
    if (selector.startsWith('identity:')) return 'identity' in payload && payload.identity?.key === selector.slice(9)
    if (selector.startsWith('path:')) return pathEqual(row.reserved_path, selector.slice(5))
    if (selector.startsWith('branch:')) return branchSelectorMatches(branch, selector.slice(7))
    if (selector.startsWith('name:')) return displayName === selector.slice(5)
    if (selector.startsWith('issue:')) return 'linkedIssue' in payload && String(payload.linkedIssue) === selector.slice(6)
    return worktreeIdsEqual(row.public_id, selector) || aliasIds.has(row.workspace_id) || pathEqual(row.reserved_path, selector) || branchSelectorMatches(branch, selector)
  })
  if (matches.length > 1) throw new CatalogError('selector_ambiguous')
  if (!matches.length) throw new CatalogError('selector_not_found')
  // Tombstones are returned internally so old receipts can replay before current lifecycle checks.
  return matches[0]
}

/** Read-only PG path: no Git/FS/SSH/SQLite/PTY/provider/wake access. */
export async function readCatalogSnapshot(pool: Pool, inputAuthority: CatalogAuthority): Promise<CatalogSnapshot> {
  const authority = captureCatalogAuthority(inputAuthority)
  return withCatalogReadSnapshot(pool, async tx => {
    const heads = (await tx.query<CatalogHeadRow>('SELECT * FROM durable_runtime.catalog_heads ORDER BY scope')).rows
    if (!heads.some(head => head.scope === 'catalog')) throw new CatalogError('CATALOG_HEAD_MISSING')
    for (const head of heads) catalogSnapshotVersion(head.revision)
    const groups = (await tx.query<CatalogProjectGroupRow>(
      'SELECT * FROM durable_runtime.catalog_project_groups WHERE deleted_at IS NULL ORDER BY id'
    )).rows.filter(row => authority.projectGroupIds.includes(row.id)).map(parseCatalogGroup)
    const repos = (await tx.query<CatalogRepositoryRow>(
      'SELECT * FROM durable_runtime.catalog_repositories WHERE deleted_at IS NULL ORDER BY id'
    )).rows.filter(row => authority.repositoryIds.includes(row.id)).map(parseCatalogRepo)
    const workspaces = (await loadCatalogWorkspaces(tx)).filter(row =>
      row.deleted_at === null && catalogWorkspaceAllowed(authority, row))
    for (const workspace of workspaces) parseCatalogWorkspace(workspace)
    const tabs = (await tx.query<CatalogTab>(`SELECT m.*,t.workspace_id,t.session_id,t.kind,
      t.terminal_handle,t.lifecycle,t.revision AS tab_revision
      FROM durable_runtime.catalog_tab_metadata m JOIN durable_runtime.tabs t ON t.id=m.tab_id ORDER BY t.ui_order,t.id`
    )).rows.filter(row => workspaces.some(workspace => workspace.workspace_id === row.workspace_id))
    for (const tab of tabs) parseCatalogTab(tab)
    const ui = (await tx.query<CatalogUiStateRow>(
      "SELECT * FROM durable_runtime.catalog_ui_state WHERE scope='host'"
    )).rows[0] ?? null
    // Copy JSON payloads before releasing the read transaction; pg Date values remain private row data.
    const cloneWorkspace = workspaces.map(row => Object.freeze({ ...row,
      payload: captureCatalogJson(row.payload) as Record<string, unknown>,
      create_request: captureCatalogJson(row.create_request) as Record<string, unknown>
    }))
    const cloneTabs = tabs.map(row => Object.freeze({ ...row,
      payload: captureCatalogJson(row.payload) as Record<string, unknown>,
      launch_request: captureCatalogJson(row.launch_request) as Record<string, unknown>
    }))
    const visibleHeads = heads.filter(row => row.scope === 'catalog' || row.scope === 'ui:host' ||
      workspaces.some(workspace => row.scope === `workspace:${workspace.workspace_id}`))
    return Object.freeze({ heads: Object.freeze(visibleHeads.map(row => Object.freeze({ ...row }))),
      repositories: Object.freeze(repos), projectGroups: Object.freeze(groups),
      workspaces: Object.freeze(cloneWorkspace), tabs: Object.freeze(cloneTabs),
      ui: ui ? Object.freeze({ ...ui, payload: captureCatalogJson(ui.payload) as Record<string, unknown> }) : null })
  })
}
