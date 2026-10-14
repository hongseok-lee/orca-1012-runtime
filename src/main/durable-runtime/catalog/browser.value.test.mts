import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { BrowserTabCreateParams } from '../../../shared/rpc-contract/browser-tab-create-params.ts'
import { CatalogCompatibilityFacade } from './facade.ts'
import { catalogWireSchemas } from './wire.ts'
import { prepareCatalogCall, type CatalogCallContext, type PreparedCatalogCall } from './request.ts'
import type { CatalogAuthority } from './authority.ts'
import { captureCatalogBrowserLaunch, reserveCatalogBrowserTab, type PreparedCatalogBrowserLaunch } from './browser.ts'

test('Browser uses incumbent schema, separate IDs and detached credential-free capture', async () => {
  // Synthetic authority only; this fixture does not authenticate or issue authority.
  const authority = { principalId: 'synthetic-browser-principal', repositoryIds: [],
    projectGroupIds: [], workspacePublicIds: ['synthetic-workspace'] } as unknown as CatalogAuthority
  const context: CatalogCallContext = { authority, capabilities: [] }
  const params = { worktree: 'id:synthetic-workspace', page: 'public-page::not-a-uuid',
    url: 'localhost:3000', activate: true, navigation: 'caller' as const,
    placement: { kind: 'client' as const, browserHostClientId: 'synthetic-browser-host' } }
  const launch = { tabId: logicalId('tab', randomUUID()), browserPageId: params.page,
    bearer: 'synthetic-must-not-be-retained', rpcContext: { marker: 'synthetic-context' } }
  assert.equal(catalogWireSchemas['browser.tabCreate'], BrowserTabCreateParams)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let observedCall: PreparedCatalogCall<'browser.tabCreate'> | undefined
  let observedLaunch: PreparedCatalogBrowserLaunch | undefined
  const facade = new CatalogCompatibilityFacade({ 'browser.tabCreate': async call => {
    const captured = captureCatalogBrowserLaunch(launch)
    await gate
    observedCall = call; observedLaunch = captured
    return { browserPageId: captured.browserPageId }
  } })
  const pending = facade.invoke('browser.tabCreate', params, context)
  params.url = 'https://changed.example/'; params.placement.browserHostClientId = 'changed'
  launch.browserPageId = 'changed'; launch.tabId = logicalId('tab', randomUUID())
  ;(authority.workspacePublicIds as string[]).push('unexpected')
  release()
  assert.deepEqual(await pending, { browserPageId: 'public-page::not-a-uuid' })
  assert.equal(observedCall?.params.url, 'localhost:3000')
  assert.equal(observedCall?.params.placement?.kind, 'client')
  assert.deepEqual(observedCall?.context.authority.workspacePublicIds, ['synthetic-workspace'])
  assert.notEqual(observedLaunch?.tabId, observedLaunch?.browserPageId)
  assert.deepEqual(Object.keys(observedLaunch ?? {}).sort(), ['browserPageId', 'tabId'])
  assert.ok(Object.isFrozen(observedLaunch))
  assert.ok(!JSON.stringify(observedLaunch).includes('synthetic-must-not-be-retained'))
  const next = prepareCatalogCall('browser.tabCreate', { worktree: 'id:synthetic-workspace', page: 'public-page::not-a-uuid' }, context)
  assert.ok(next.legacyRetryLimit)
  assert.notEqual(next.operationKey, observedCall?.operationKey)
  assert.notEqual(next.operationKey, next.params.page)
  let checkouts = 0
  const neverPool = { connect: async () => { checkouts++; throw new Error('Unexpected DB checkout') } } as unknown as Pool
  const validLaunch = { tabId: logicalId('tab', randomUUID()), browserPageId: 'public-page::not-a-uuid' }
  await assert.rejects(reserveCatalogBrowserTab(neverPool, next, { ...validLaunch, browserPageId: 'mismatch' }), /CATALOG_BROWSER_PAGE_ID/)
  await assert.rejects(reserveCatalogBrowserTab(neverPool, prepareCatalogCall('browser.tabCreate', {
    worktree: 'id:synthetic-workspace', url: 'javascript:alert(1)' }, context), validLaunch), /CATALOG_BROWSER_URL/)
  await assert.rejects(reserveCatalogBrowserTab(neverPool, prepareCatalogCall('browser.tabCreate', {
    worktree: 'id:synthetic-workspace', bearer: 'synthetic-private' }, context), validLaunch), /CATALOG_BROWSER_REQUEST/)
  await assert.rejects(reserveCatalogBrowserTab(neverPool, prepareCatalogCall('browser.tabCreate', {
    worktree: 'id:synthetic-workspace', placement: { kind: 'server', rpcContext: { bearer: 'synthetic-private' } }
  }, context), validLaunch), /CATALOG_BROWSER_REQUEST/)
  await assert.rejects(reserveCatalogBrowserTab(neverPool, prepareCatalogCall('browser.tabCreate', {}, context), validLaunch), /CATALOG_WORKSPACE_SELECTOR_REQUIRED/)
  assert.throws(() => captureCatalogBrowserLaunch({ ...validLaunch, browserPageId: '' }), /CATALOG_BROWSER_PAGE_ID/)
  assert.equal(checkouts, 0)
})
