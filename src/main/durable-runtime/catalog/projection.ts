import type { Pool } from 'pg'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts.ts'
import type { RuntimeWorktreeRecord, RuntimeWorktreeListResult, RuntimeWorktreePsConditionalResult, RuntimeWorktreePsSummary } from '../../../shared/runtime-worktree-contracts.ts'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree.ts'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types.ts'
import type { CatalogHeadRow } from '../db/rows.ts'
import type { DurableTransaction } from '../db/connection.ts'
import type { PreparedCatalogCall } from './request.ts'
import { readCatalogSnapshot, withCatalogReadSnapshot, resolveCatalogWorkspace, type CatalogWorkspace, type CatalogSnapshot } from './read.ts'
import { loadCatalogTabs } from './metadata.ts'
import { parseCatalogWorkspace, parseCatalogTab } from './payload.ts'
import { catalogSnapshotId, catalogSnapshotVersion } from './revision.ts'
import { captureCatalogJson } from './immutable.ts'
import { CatalogError } from './errors.ts'

function head(snapshot: CatalogSnapshot, scope: string): CatalogHeadRow {
  const found = snapshot.heads.find(row => row.scope === scope)
  if (!found) throw new CatalogError('CATALOG_HEAD_MISSING')
  return found
}

export function projectCatalogWorktree(workspace: CatalogWorkspace): RuntimeWorktreeRecord {
  const stored = parseCatalogWorkspace(workspace)
  if (workspace.kind !== 'FOLDER_WORKSPACE') return stored as RuntimeWorktreeRecord
  const folder = folderWorkspaceToWorktree(stored as FolderWorkspace)
  return { ...folder, parentWorktreeId: null, childWorktreeIds: [], lineage: null,
    git: { path: folder.path, head: folder.head, branch: folder.branch, isBare: folder.isBare,
      isMainWorktree: folder.isMainWorktree, ...(folder.isSparse === undefined ? {} : { isSparse: folder.isSparse }) } }
}

export function projectCatalogTabs(snapshot: CatalogSnapshot, workspace: CatalogWorkspace): RuntimeMobileSessionTabsResult {
  const publication = head(snapshot, `workspace:${workspace.workspace_id}`)
  const tabs = snapshot.tabs.filter(row => row.workspace_id === workspace.workspace_id && row.lifecycle === 'OPEN').map(parseCatalogTab)
  const active = tabs.filter(tab => tab.isActive)
  if (active.length > 1) throw new CatalogError('CATALOG_ACTIVE_TAB_AMBIGUOUS')
  // Group/layout are incumbent metadata only. Their absence is not a physical deletion event.
  const group = workspace.payload.activeGroupId
  if (group !== undefined && group !== null && typeof group !== 'string') throw new CatalogError('CATALOG_PAYLOAD')
  return { worktree: workspace.public_id, publicationEpoch: publication.publication_epoch,
    snapshotVersion: catalogSnapshotVersion(publication.revision), activeGroupId: typeof group === 'string' ? group : null,
    activeTabId: active[0]?.id ?? null, activeTabType: active[0]?.type ?? null, tabs }
}

export async function readWorkspaceTabsInTransaction(tx: DurableTransaction, workspace: CatalogWorkspace): Promise<RuntimeMobileSessionTabsResult> {
  const heads = (await tx.query<CatalogHeadRow>('SELECT * FROM durable_runtime.catalog_heads WHERE scope=$1',
    [`workspace:${workspace.workspace_id}`])).rows
  return projectCatalogTabs({ heads, workspaces: [workspace], tabs: await loadCatalogTabs(tx, workspace.workspace_id),
    repositories: [], projectGroups: [], ui: null }, workspace)
}

function limit(input: number | undefined): number {
  if (input === undefined) return Number.MAX_SAFE_INTEGER
  if (!Number.isSafeInteger(input) || input < 0) throw new CatalogError('CATALOG_LIMIT')
  return input
}

export function projectCatalogList(snapshot: CatalogSnapshot, call: PreparedCatalogCall<'worktree.list'>): RuntimeWorktreeListResult {
  let rows = snapshot.workspaces
  if (call.params.repo !== undefined) {
    const selector = call.params.repo.startsWith('id:') ? call.params.repo.slice(3) : call.params.repo
    const repos = snapshot.repositories.filter(repo => repo.id === selector || repo.path === selector || repo.displayName === selector)
    if (repos.length !== 1) throw new CatalogError(repos.length ? 'CATALOG_REPO_AMBIGUOUS' : 'CATALOG_REPO_NOT_FOUND')
    rows = rows.filter(row => row.repo_id === repos[0].id)
  }
  const maximum = limit(call.params.limit)
  return { worktrees: rows.slice(0, maximum).map(projectCatalogWorktree), totalCount: rows.length, truncated: rows.length > maximum }
}

/** Physical PS facts are accepted only from validated stored binding observations. */
export function projectCatalogPs(snapshot: CatalogSnapshot, call: PreparedCatalogCall<'worktree.ps'>): RuntimeWorktreePsConditionalResult {
  const publication = head(snapshot, 'catalog')
  const maximum = limit(call.params.limit)
  const snapshotId = catalogSnapshotId(publication.publication_epoch, publication.revision,
    { params: { limit: maximum, supportsWorktreeVisibilitySourceDefaults: call.params.supportsWorktreeVisibilitySourceDefaults === true },
      capabilities: [...call.context.capabilities].sort(),
      scope: { repositories: [...call.context.authority.repositoryIds].sort(), groups: [...call.context.authority.projectGroupIds].sort(),
        workspaces: [...call.context.authority.workspacePublicIds].sort() } })
  const worktrees = snapshot.workspaces.slice(0, maximum).map(workspace => {
    const raw = workspace.payload.ps
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CatalogError('CATALOG_PHYSICAL_PROJECTION_UNVERIFIABLE')
    const projection = captureCatalogJson(raw) as Record<string, unknown>
    const stored = projectCatalogWorktree(workspace)
    if (projection.worktreeId !== workspace.public_id || projection.repoId !== stored.repoId ||
      typeof projection.liveTerminalCount !== 'number' || !Number.isSafeInteger(projection.liveTerminalCount) || projection.liveTerminalCount < 0 ||
      typeof projection.hasAttachedPty !== 'boolean' || !Array.isArray(projection.agents)) throw new CatalogError('CATALOG_PAYLOAD')
    for (const key of ['repo', 'path', 'branch', 'displayName', 'workspaceStatus', 'comment', 'preview']) {
      if (typeof projection[key] !== 'string') throw new CatalogError('CATALOG_PAYLOAD')
    }
    for (const key of ['isArchived', 'isMainWorktree', 'hasHostSidebarActivity', 'isPinned', 'isActive', 'unread']) {
      if (typeof projection[key] !== 'boolean') throw new CatalogError('CATALOG_PAYLOAD')
    }
    if (typeof projection.sortOrder !== 'number' || !Number.isFinite(projection.sortOrder) ||
      (projection.lastOutputAt !== null && (typeof projection.lastOutputAt !== 'number' || !Number.isFinite(projection.lastOutputAt))) ||
      (projection.parentWorktreeId !== null && typeof projection.parentWorktreeId !== 'string') ||
      !Array.isArray(projection.childWorktreeIds) || projection.childWorktreeIds.some(id => typeof id !== 'string') ||
      !['active', 'working', 'permission', 'done', 'inactive'].includes(String(projection.status))) throw new CatalogError('CATALOG_PAYLOAD')
    return { ...projection, path: stored.path, branch: stored.branch, displayName: stored.displayName,
      isPinned: stored.isPinned, isArchived: stored.isArchived, unread: stored.isUnread,
      sortOrder: stored.sortOrder, comment: stored.comment } as RuntimeWorktreePsSummary
  })
  if (call.params.afterSnapshotId === snapshotId) return { unchanged: true, snapshotId }
  return { worktrees, totalCount: snapshot.workspaces.length, truncated: snapshot.workspaces.length > maximum, snapshotId }
}

/** One RR snapshot for head/payload; callbacks do not touch a runtime or filesystem. */
export async function readCatalogWorkspaceTabs(pool: Pool, call: PreparedCatalogCall<'session.tabs.list'>): Promise<RuntimeMobileSessionTabsResult> {
  return withCatalogReadSnapshot(pool, async tx => {
    const workspace = await resolveCatalogWorkspace(tx, call.params.worktree, call.context.authority)
    if (workspace.deleted_at !== null) throw new CatalogError('CATALOG_WORKSPACE_DELETED')
    return readWorkspaceTabsInTransaction(tx, workspace)
  })
}

export async function readAllCatalogTabs(pool: Pool, call: PreparedCatalogCall<'session.tabs.listAll'>): Promise<{ snapshots: RuntimeMobileSessionTabsResult[]; authoritative: true }> {
  const snapshot = await readCatalogSnapshot(pool, call.context.authority)
  return { snapshots: snapshot.workspaces.map(workspace => projectCatalogTabs(snapshot, workspace)), authoritative: true }
}
