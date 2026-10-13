import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectCatalogPs } from './projection.ts'
import { prepareCatalogCall } from './request.ts'
import type { CatalogAuthority } from './authority.ts'
import type { CatalogSnapshot } from './read.ts'
import { hostScopeCensusIsComplete } from '../../../shared/runtime-listing-host-scope.ts'

// Written only. Counts in this legacy DTO are placeholders with no covered hosts.
test('fresh PG reservation stays visible with an unverified physical census and query-specific snapshot', () => {
  const git = { path: '/synthetic/reserved', head: '', branch: 'synthetic', isBare: false, isMainWorktree: false }
  const payload = { ...git, id: 'synthetic-repo::/synthetic/reserved', repoId: 'synthetic-repo',
    hostId: 'runtime:synthetic-runtime', displayName: 'user label', comment: '', linkedIssue: null, linkedPR: null,
    linkedLinearIssue: null, isArchived: false, isUnread: false, isPinned: true, sortOrder: 4, lastActivityAt: 0,
    parentWorktreeId: null, childWorktreeIds: [], lineage: null, git }
  const snapshot = { heads: [{ scope: 'catalog', publication_epoch: 'synthetic-epoch', revision: '1' }],
    repositories: [{ id: 'synthetic-repo', displayName: 'repo' }], projectGroups: [], ui: null, tabs: [],
    workspaces: [{ workspace_id: 'synthetic-workspace', public_id: payload.id, kind: 'GIT', repo_id: 'synthetic-repo',
      project_group_id: null, payload, provisioning_state: 'PENDING' }] } as unknown as CatalogSnapshot
  const context = { authority: { principalId: 'synthetic-principal', repositoryIds: ['synthetic-repo'],
    projectGroupIds: [], workspacePublicIds: [] } as unknown as CatalogAuthority, capabilities: [] }
  const result = projectCatalogPs(snapshot, prepareCatalogCall('worktree.ps', {}, context))
  assert.ok(!('unchanged' in result))
  if ('unchanged' in result) return
  assert.equal(result.totalCount, 1)
  assert.equal(result.worktrees[0].worktreeId, payload.id)
  assert.equal(result.worktrees[0].displayName, 'user label')
  assert.equal(result.worktrees[0].isPinned, true)
  assert.equal(hostScopeCensusIsComplete(result.hostScope), false)
  assert.deepEqual(result.hostScope, { hostIds: [], omittedHostIds: ['runtime:synthetic-runtime'] })
  assert.deepEqual(projectCatalogPs(snapshot, prepareCatalogCall('worktree.ps', { afterSnapshotId: result.snapshotId }, context)),
    { unchanged: true, snapshotId: result.snapshotId })
  const filtered = projectCatalogPs(snapshot, prepareCatalogCall('worktree.ps', { limit: 0, afterSnapshotId: result.snapshotId }, context))
  assert.ok(!('unchanged' in filtered))
})
