import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import type { CatalogSnapshot, CatalogWorkspace } from '../catalog/read.ts'
import { parseCatalogRepo } from '../catalog/payload.ts'
import { projectCatalogPs, projectCatalogWorktree } from '../catalog/projection.ts'
import { prepareCatalogCall } from '../catalog/request.ts'
import { captureCatalogReadContext } from './context.ts'
import { captureDurableCatalogReadConfig, CatalogReadError } from './config.ts'
import { validateCatalogSnapshot } from './read.ts'
import { fixtureConfig, fixtureContext, fixtureRuntime } from './fixture-support.mts'
import type { ExecutionHostId } from '../../../shared/execution-host.ts'

// Source only. Synthetic context is not evidence of actual device authentication.
if (process.env.ORCA_CATALOG_HOST_APPROVED !== 'root-source-reviewed') {
  throw new Error('Root source review is required before the first Catalog host value callback')
}
const noIo = { connect: () => { throw new Error('Unexpected PG access in the value fixture') } } as unknown as Pool
const datasetName = 'orca-1012-dev-v1'
const git = { path: '/synthetic/catalog-host/worktree', head: '', branch: 'synthetic', isBare: false, isMainWorktree: false }
const gitPayload = { ...git, id: 'synthetic-host-worktree', repoId: 'synthetic-host-repo', displayName: 'Synthetic host',
  comment: '', linkedIssue: null, linkedPR: null, linkedLinearIssue: null, isArchived: false, isUnread: false,
  isPinned: false, sortOrder: 0, lastActivityAt: 0, parentWorktreeId: null, childWorktreeIds: [], lineage: null, git }
function repo(fields: Record<string, unknown> = {}) {
  return parseCatalogRepo({ id: 'synthetic-host-repo', payload: { id: 'synthetic-host-repo', path: '/synthetic/catalog-host/repo',
    displayName: 'Synthetic repo', badgeColor: '#ffffff', addedAt: 1, ...fields } })
}
function workspace(payload: Record<string, unknown>, kind: CatalogWorkspace['kind'] = 'GIT'): CatalogWorkspace {
  return { workspace_id: '00000000-0000-4000-8000-000000000001', public_id: payload.id, kind,
    repo_id: kind === 'FOLDER_WORKSPACE' ? null : 'synthetic-host-repo', project_group_id: null,
    payload, create_request: {}, provisioning_state: 'RESERVED', deleted_at: null } as unknown as CatalogWorkspace
}
function snapshot(repository: ReturnType<typeof repo> | null, row: CatalogWorkspace): CatalogSnapshot {
  return { heads: [{ scope: 'catalog', dataset_name: datasetName, publication_epoch: 'synthetic-host-epoch', revision: '1' }],
    repositories: repository ? [repository] : [], workspaces: [row], projectGroups: [], tabs: [], ui: null } as unknown as CatalogSnapshot
}
function config(hostId: ExecutionHostId) {
  return captureDurableCatalogReadConfig({ ...fixtureConfig(noIo), hostId, readHostIdentity: () => hostId,
    repositoryIds: ['synthetic-host-repo'] })
}
function ps(input: CatalogSnapshot) {
  const { runtime } = fixtureRuntime()
  const context = captureCatalogReadContext(config('local'), fixtureContext(runtime))
  const result = projectCatalogPs(input, prepareCatalogCall('worktree.ps', {}, context))
  assert.ok(!('unchanged' in result))
  if ('unchanged' in result) { throw new Error('Unexpected conditional projection') }
  const hostScope = result.hostScope
  assert.ok(hostScope, 'Catalog ps must disclose its unverified host scope')
  assert.deepEqual(hostScope.hostIds, [])
  assert.equal(result.worktrees[0].hasAttachedPty, false)
  return { ...result, hostScope }
}
const mismatch = (error: unknown) => error instanceof CatalogReadError && error.code === 'CATALOG_REGISTRATION_HOST_MISMATCH'

test('Catalog host value1: canonical Repo/Worktree/Folder precedence and unverified ps', () => {
  const legacy = snapshot(repo({ connectionId: 'synthetic remote' }), workspace({ ...gitPayload }))
  assert.throws(() => validateCatalogSnapshot(config('local'), legacy), mismatch)
  validateCatalogSnapshot(config('ssh:synthetic%20remote'), legacy)
  assert.equal(ps(legacy).worktrees[0].hostId, 'ssh:synthetic%20remote')
  assert.deepEqual(ps(legacy).hostScope.omittedHostIds, ['ssh:synthetic%20remote'])

  const explicit = snapshot(repo({ connectionId: 'synthetic remote', executionHostId: 'local' }),
    workspace({ ...gitPayload, executionHostId: 'runtime:raw-workspace-field' }))
  validateCatalogSnapshot(config('local'), explicit)
  assert.equal(ps(explicit).worktrees[0].hostId, 'local')

  const worktree = snapshot(repo({ executionHostId: 'local' }),
    workspace({ ...gitPayload, hostId: 'runtime:worktree-owner', executionHostId: 'local' }))
  assert.throws(() => validateCatalogSnapshot(config('local'), worktree), mismatch)
  assert.equal(ps(worktree).worktrees[0].hostId, projectCatalogWorktree(worktree.workspaces[0]).hostId)
  assert.equal(ps(worktree).worktrees[0].hostId, 'runtime:worktree-owner')
  // Isolate Worktree precedence from the separate repo-host guard.
  validateCatalogSnapshot(config('runtime:worktree-owner'), { ...worktree, repositories: [] })

  const local = snapshot(repo(), workspace({ ...gitPayload }))
  validateCatalogSnapshot(config('local'), local)
  assert.ok(!Object.hasOwn(ps(local).worktrees[0], 'hostId'), 'preserve omitted local host metadata')

  for (const fields of [{ connectionId: 'folder remote' },
    { connectionId: 'folder remote', executionHostId: 'local' }] as const) {
    const folder = workspace({ id: 'synthetic-folder', projectGroupId: 'synthetic-group', name: 'Synthetic folder',
      folderPath: '/synthetic/catalog-host/folder', comment: '', createdAt: 1, updatedAt: 1, lastActivityAt: 0,
      sortOrder: 0, isArchived: false, isUnread: false, isPinned: false, ...fields }, 'FOLDER_WORKSPACE')
    const input = snapshot(null, folder), projected = projectCatalogWorktree(folder)
    const expected = 'executionHostId' in fields ? 'local' : 'ssh:folder%20remote'
    validateCatalogSnapshot(config(expected), input)
    if (expected !== 'local') { assert.throws(() => validateCatalogSnapshot(config('local'), input), mismatch) }
    assert.equal(projected.hostId, expected)
    assert.equal(ps(input).worktrees[0].hostId, expected)
    assert.deepEqual(ps(input).hostScope.omittedHostIds, [expected])
  }
  assert.throws(() => validateCatalogSnapshot(config('local'), { ...local,
    heads: local.heads.map(row => ({ ...row, dataset_name: 'synthetic-other-dataset' })) }),
  (error: unknown) => error instanceof CatalogReadError && error.code === 'CATALOG_DATASET_MISMATCH')
})
