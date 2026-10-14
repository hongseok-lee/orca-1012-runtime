import test from 'node:test'
import assert from 'node:assert/strict'
import { CatalogCompatibilityFacade } from './facade.ts'
import { prepareCatalogCall, catalogReceiptIdentity, type CatalogCallContext, type ResolvedCatalogScope } from './request.ts'
import type { CatalogAuthority } from './authority.ts'
import { captureCatalogInstant, captureCatalogJson } from './immutable.ts'
import { catalogSnapshotId, catalogSnapshotVersion } from './revision.ts'

// Test fixture only, not a production authority issuer or authentication result.
function context(): CatalogCallContext {
  return {
    authority: {
      principalId: 'catalog-test-principal', repositoryIds: ['repo-test'],
      projectGroupIds: [], workspacePublicIds: ['repo-test::/test/dataset']
    } as unknown as CatalogAuthority,
    capabilities: []
  }
}

test('first-await boundary detaches nested payload, authority and capabilities', async () => {
  const caller = context()
  const params = {
    worktree: 'id:repo-test::/test/dataset', clientMutationId: 'mutation-1',
    env: { CATALOG_TEST_MARKER: 'before' }, launchToken: 'opaque-launch-marker'
  }
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let observed: ReturnType<typeof prepareCatalogCall<'session.tabs.createTerminal'>> | undefined
  const facade = new CatalogCompatibilityFacade({
    'session.tabs.createTerminal': async request => {
      await gate
      observed = request
      throw new Error('test-boundary-inspected')
    }
  })
  const pending = facade.invoke('session.tabs.createTerminal', params, caller)
  params.env.CATALOG_TEST_MARKER = 'after'
  params.launchToken = 'changed-launch-marker'
  ;(caller.authority.repositoryIds as string[]).push('unexpected-repo')
  release()
  await assert.rejects(pending, /test-boundary-inspected/)
  assert.equal(observed?.params.env?.CATALOG_TEST_MARKER, 'before')
  assert.equal(observed?.params.launchToken, 'opaque-launch-marker')
  assert.deepEqual(observed?.context.authority.repositoryIds, ['repo-test'])
  assert.ok(Object.isFrozen(observed?.params.env))
})

test('original payload hashes are stable and launchToken is not a mutation key', () => {
  const common = { worktree: 'id:repo-test::/test/dataset', clientMutationId: 'request-1' }
  const first = prepareCatalogCall('session.tabs.createTerminal', { ...common, launchToken: 'launch-1' }, context())
  const retry = prepareCatalogCall('session.tabs.createTerminal', { launchToken: 'launch-1', ...common }, context())
  const changed = prepareCatalogCall('session.tabs.createTerminal', { ...common, launchToken: 'launch-2' }, context())
  const scope = 'workspace:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' as ResolvedCatalogScope
  assert.deepEqual(catalogReceiptIdentity(first, scope), catalogReceiptIdentity(retry, scope))
  assert.equal(first.operationKey, 'request-1')
  assert.notEqual(changed.payloadHash, first.payloadHash)
  const legacyA = prepareCatalogCall('session.tabs.createTerminal', { worktree: common.worktree, launchToken: 'same-launch' }, context())
  const legacyB = prepareCatalogCall('session.tabs.createTerminal', { worktree: common.worktree, launchToken: 'same-launch' }, context())
  assert.ok(legacyA.legacyRetryLimit)
  assert.notEqual(legacyA.operationKey, legacyB.operationKey)
})

test('shared schema rejects agent prompt without agent before entry invocation', () => {
  let calls = 0
  const facade = new CatalogCompatibilityFacade({
    'session.tabs.createTerminal': async () => { calls++; throw new Error('unexpected') }
  })
  assert.throws(() => facade.invoke('session.tabs.createTerminal', {
    worktree: 'id:repo-test::/test/dataset', agentPrompt: 'test prompt'
  }, context()), /CATALOG_PARAMS/)
  assert.equal(calls, 0)
})

test('ui storage request excludes pairing-local fields', () => {
  const request = prepareCatalogCall('ui.set', { sidebarWidth: 320, manualRepoOrder: ['private-client-choice'] }, context())
  assert.equal(request.params.sidebarWidth, 320)
  assert.ok(!Object.hasOwn(request.params, 'manualRepoOrder'))
  assert.ok(!JSON.stringify(request.original).includes('private-client-choice'))
})

test('missing Catalog entry does not fabricate empty data or successful close', () => {
  const facade = new CatalogCompatibilityFacade({})
  assert.throws(() => facade.invoke('repo.list', null, context()), /CATALOG_ENTRY_UNAVAILABLE/)
  assert.throws(() => facade.invoke('session.tabs.close', {
    worktree: 'id:repo-test::/test/dataset', tabId: 'tab-1', reason: 'user'
  }, context()), /CATALOG_ENTRY_UNAVAILABLE/)
})

test('query identity includes epoch, revision, limits and capability projection', () => {
  const head = { publicationEpoch: 'epoch-1', revision: '3' }
  const id = catalogSnapshotId({ ...head, queryProjection: { limit: 1, capabilities: [] } })
  assert.notEqual(id, catalogSnapshotId({ ...head, queryProjection: { limit: 2, capabilities: [] } }))
  assert.notEqual(id, catalogSnapshotId({ ...head, queryProjection: { limit: 1, capabilities: ['projection-v2'] } }))
  assert.notEqual(id, catalogSnapshotId({ ...head, revision: '4', queryProjection: { limit: 1, capabilities: [] } }))
  assert.equal(catalogSnapshotVersion('9007199254740991'), Number.MAX_SAFE_INTEGER)
  assert.throws(() => catalogSnapshotVersion('9007199254740992'), /CATALOG_REVISION_OVERFLOW/)
})

test('Date capture uses detached time scalar; JSON getters are never executed', () => {
  const date = new Date('2026-10-13T00:00:00Z')
  const instant = captureCatalogInstant(date)
  date.setTime(0)
  assert.equal(instant, Date.parse('2026-10-13T00:00:00Z'))
  let getterCalls = 0
  const value = Object.defineProperty({}, 'dynamic', { enumerable: true, get() { getterCalls++; return 'mutable' } })
  assert.throws(() => captureCatalogJson(value), /CATALOG_JSON/)
  assert.equal(getterCalls, 0)
})
