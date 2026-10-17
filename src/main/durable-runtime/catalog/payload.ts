import type { Repo } from '../../../shared/repo-types.ts'
import type { ProjectGroup } from '../../../shared/project-group-types.ts'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types.ts'
import type { RuntimeWorktreeRecord } from '../../../shared/runtime-worktree-contracts.ts'
import type { RuntimeMobileSessionClientTab } from '../../../shared/runtime-mobile-session-tab-contracts.ts'
import { isRuntimeTerminalNativeChatSession } from '../../../shared/runtime-mobile-session-tab-contracts.ts'
import type { CatalogRepositoryRow, CatalogProjectGroupRow, CatalogWorkspaceMetadataRow } from '../db/rows.ts'
import type { CatalogTab } from './read.ts'
import { captureCatalogJson } from './immutable.ts'
import { CatalogError } from './errors.ts'

function text(payload: Record<string, unknown>, key: string, nullable = false): void {
  const value = payload[key]
  if (nullable && value === null) {return}
  if (typeof value !== 'string') {throw new CatalogError('CATALOG_PAYLOAD')}
}
function number(payload: Record<string, unknown>, key: string): void {
  if (typeof payload[key] !== 'number' || !Number.isFinite(payload[key])) {throw new CatalogError('CATALOG_PAYLOAD')}
}
function boolean(payload: Record<string, unknown>, key: string): void {
  if (typeof payload[key] !== 'boolean') {throw new CatalogError('CATALOG_PAYLOAD')}
}
function object(value: unknown): Record<string, unknown> {
  const copy = captureCatalogJson(value)
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) {throw new CatalogError('CATALOG_PAYLOAD')}
  return copy as Record<string, unknown>
}

export function parseCatalogRepo(row: Pick<CatalogRepositoryRow, 'id' | 'payload'>): Repo {
  const value = object(row.payload)
  for (const key of ['id', 'path', 'displayName', 'badgeColor']) {text(value, key)}
  number(value, 'addedAt')
  if (value.id !== row.id || !value.id || !value.path ||
      (value.kind !== undefined && !['git', 'folder'].includes(String(value.kind)))) {throw new CatalogError('CATALOG_PAYLOAD')}
  return value as unknown as Repo
}
export function parseCatalogGroup(row: Pick<CatalogProjectGroupRow, 'id' | 'payload'>): ProjectGroup {
  const value = object(row.payload)
  for (const key of ['id', 'name', 'createdFrom']) {text(value, key)}
  for (const key of ['parentPath', 'parentGroupId', 'color']) {text(value, key, true)}
  for (const key of ['tabOrder', 'createdAt', 'updatedAt']) {number(value, key)}
  boolean(value, 'isCollapsed')
  if (value.id !== row.id || !['manual', 'folder-scan', 'migration'].includes(String(value.createdFrom))) {throw new CatalogError('CATALOG_PAYLOAD')}
  return value as unknown as ProjectGroup
}
export function parseCatalogWorkspace(row: Pick<CatalogWorkspaceMetadataRow, 'kind' | 'payload'>): RuntimeWorktreeRecord | FolderWorkspace {
  const value = object(row.payload)
  if (row.kind === 'FOLDER_WORKSPACE') {
    for (const key of ['id', 'projectGroupId', 'name', 'folderPath', 'comment']) {text(value, key)}
    for (const key of ['createdAt', 'updatedAt', 'lastActivityAt', 'sortOrder']) {number(value, key)}
  } else {
    for (const key of ['id', 'repoId', 'path', 'head', 'branch', 'displayName', 'comment']) {text(value, key)}
    for (const key of ['isBare', 'isMainWorktree']) {boolean(value, key)}
    if (value.isSparse !== undefined) {boolean(value, 'isSparse')}
    for (const key of ['sortOrder', 'lastActivityAt']) {number(value, key)}
    for (const key of ['linkedIssue', 'linkedPR']) {
      if (value[key] !== null) {number(value, key)}
    }
    text(value, 'linkedLinearIssue', true)
    text(value, 'parentWorktreeId', true)
    if (!Array.isArray(value.childWorktreeIds) || value.childWorktreeIds.some(id => typeof id !== 'string') ||
      (value.lineage !== null && (typeof value.lineage !== 'object' || Array.isArray(value.lineage)))) {throw new CatalogError('CATALOG_PAYLOAD')}
    const git = object(value.git)
    for (const key of ['path', 'head', 'branch']) {text(git, key)}
    for (const key of ['isBare', 'isMainWorktree']) {boolean(git, key)}
    if (git.isSparse !== undefined) {boolean(git, 'isSparse')}
  }
  for (const key of ['isArchived', 'isUnread', 'isPinned']) {boolean(value, key)}
  if (value.manualOrder !== undefined) {number(value, 'manualOrder')}
  return value as unknown as RuntimeWorktreeRecord | FolderWorkspace
}
export function parseCatalogTab(row: CatalogTab): RuntimeMobileSessionClientTab {
  const value = object(row.payload)
  text(value, 'id'); text(value, 'title'); boolean(value, 'isActive')
  if (value.id !== row.public_tab_id) {throw new CatalogError('CATALOG_PAYLOAD')}
  if (value.type !== row.kind) {throw new CatalogError('CATALOG_TAB_KIND')}
  if (value.isPinned !== undefined) {boolean(value, 'isPinned')}
  if (value.color !== undefined) {text(value, 'color', true)}
  if (value.type === 'terminal') {
    if (Object.hasOwn(value, 'nativeChatSession')) {throw new CatalogError('CATALOG_NATIVE_SESSION_STORED_PAYLOAD')}
    text(value, 'parentTabId'); text(value, 'leafId')
    if (value.status === 'pending-handle') {
      if (value.terminal !== null) {throw new CatalogError('CATALOG_PAYLOAD')}
    } else if (value.status === 'ready') {
      if (value.terminal !== row.terminal_handle || !value.terminal) {throw new CatalogError('CATALOG_PAYLOAD')}
    } else {throw new CatalogError('CATALOG_PAYLOAD')}
    if (value.viewMode !== undefined && !['terminal', 'chat'].includes(String(value.viewMode))) {throw new CatalogError('CATALOG_PAYLOAD')}
    if (row.terminal_native_chat_session !== undefined) {
      if (!isRuntimeTerminalNativeChatSession(row.terminal_native_chat_session)) {throw new CatalogError('CATALOG_NATIVE_SESSION_REFERENCE')}
      return { ...value, nativeChatSession: row.terminal_native_chat_session } as unknown as RuntimeMobileSessionClientTab
    }
  } else if (value.type === 'agent-session') {
    text(value, 'sessionId')
    if (!value.sessionId || !['claude', 'codex'].includes(String(value.agent))) {throw new CatalogError('CATALOG_PAYLOAD')}
  } else if (value.type === 'file' || value.type === 'markdown') {
    for (const key of ['filePath', 'relativePath', 'language']) {text(value, key)}
    boolean(value, 'isDirty')
    if (value.type === 'markdown') {
      for (const key of ['sourceFileId', 'sourceFilePath', 'sourceRelativePath', 'documentVersion']) {text(value, key)}
      if (value.language !== 'markdown' || !['edit', 'markdown-preview'].includes(String(value.mode))) {throw new CatalogError('CATALOG_PAYLOAD')}
    }
  } else if (value.type === 'browser') {
    for (const key of ['browserWorkspaceId', 'url']) {text(value, key)}
    text(value, 'browserPageId', true)
    for (const key of ['loading', 'canGoBack', 'canGoForward']) {boolean(value, key)}
  } else {throw new CatalogError('CATALOG_PAYLOAD')}
  return value as unknown as RuntimeMobileSessionClientTab
}
