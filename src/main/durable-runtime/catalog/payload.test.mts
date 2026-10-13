import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureCatalogJson } from './immutable.ts'
import { parseCatalogTab, parseCatalogWorkspace } from './payload.ts'
import type { CatalogTab } from './read.ts'

// New compatibility boundary cases, written only; no provider/runtime evidence.
const row = (payload: Record<string, unknown>): CatalogTab => ({ public_tab_id: payload.id,
  payload, kind: payload.type, terminal_handle: 'synthetic-handle' } as unknown as CatalogTab)

test('default Tab DTO kinds preserve their incumbent fields and native provider ID is required', () => {
  const terminal = { id: 'synthetic-terminal', type: 'terminal', title: 'shell', isActive: false,
    parentTabId: 'synthetic-parent', leafId: 'synthetic-leaf', status: 'pending-handle', terminal: null }
  assert.deepEqual(parseCatalogTab(row(terminal)), captureCatalogJson(terminal))
  const file = { id: 'synthetic-file', type: 'file', title: 'file', isActive: false, filePath: '/synthetic/file',
    relativePath: 'file', language: 'text', isDirty: false, mode: 'edit' }
  assert.deepEqual(parseCatalogTab(row(file)), captureCatalogJson(file))
  const markdown = { ...file, id: 'synthetic-markdown', type: 'markdown', language: 'markdown', mode: 'markdown-preview',
    sourceFileId: 'synthetic-file', sourceFilePath: '/synthetic/file', sourceRelativePath: 'file', documentVersion: 'synthetic-version' }
  assert.deepEqual(parseCatalogTab(row(markdown)), captureCatalogJson(markdown))
  const browser = { id: 'synthetic-browser', type: 'browser', title: 'browser', isActive: false,
    browserWorkspaceId: 'synthetic-browser-workspace', browserPageId: null, url: 'about:blank',
    loading: false, canGoBack: false, canGoForward: false }
  assert.deepEqual(parseCatalogTab(row(browser)), captureCatalogJson(browser))
  const native = { id: 'synthetic-native', type: 'agent-session', title: 'native', isActive: false,
    sessionId: 'synthetic-provider-session', agent: 'codex' }
  assert.deepEqual(parseCatalogTab(row(native)), captureCatalogJson(native))
  assert.throws(() => parseCatalogTab(row({ ...native, sessionId: '' })))
  assert.throws(() => parseCatalogTab(row({ ...native, agent: 'shell' })))
  assert.throws(() => parseCatalogTab(row({ ...terminal, status: 'ready', terminal: null })))
})

test('optional isSparse stays optional; required enriched Git fields are not invented', () => {
  const git = { path: '/synthetic/worktree', head: '', branch: '', isBare: false, isMainWorktree: false }
  const payload = { ...git, id: 'synthetic-repo::/synthetic/worktree', repoId: 'synthetic-repo', displayName: 'Label',
    comment: '', linkedIssue: null, linkedPR: null, linkedLinearIssue: null, sortOrder: 0, lastActivityAt: 0,
    isArchived: false, isUnread: false, isPinned: false, parentWorktreeId: null, childWorktreeIds: [], lineage: null, git }
  assert.deepEqual(parseCatalogWorkspace({ kind: 'GIT', payload }), captureCatalogJson(payload))
  assert.throws(() => parseCatalogWorkspace({ kind: 'GIT', payload: { ...payload, git: null } }))
})
