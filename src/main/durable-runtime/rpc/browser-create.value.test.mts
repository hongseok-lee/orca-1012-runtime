import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createCatalogBrowserCreateRpc } from './browser-create.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { deferred, fixtureConfig, fixtureContext, fixtureRuntime } from './fixture-support.mts'

if (process.env.ORCA_PUBLIC_BROWSER_VALUE_APPROVED !== 'root-source-reviewed') {
  throw new Error('Root Browser create value allocation required')
}

await test('공개 Browser factory는 첫 await 전에 요청과 caller를 capture하고 미지원 요청을 IO 전에 거절합니다', async () => {
  let checkouts = 0, nativeCalls = 0, hostChecks = 0, createReads = 0
  const gate = deferred<never>()
  const pool = { connect() {
    assert.equal(this, pool)
    checkouts++
    return gate.promise
  } } as unknown as Pool
  const captured = captureDurableCatalogReadConfig({ ...fixtureConfig(pool), workspacePublicIds: ['synthetic-browser-value'] })
  const config = { ...captured, assertCurrentHost() { assert.equal(this, config); hostChecks++ } }
  const owner = fixtureRuntime()
  Object.defineProperty(owner.runtime, 'browserTabCreate', { configurable: true, get() {
    createReads++
    return async function (this: typeof owner.runtime) { assert.equal(this, owner.runtime); nativeCalls++; return { browserPageId: 'synthetic-value-page' } }
  } })
  const handler = createCatalogBrowserCreateRpc(config)
  const context = fixtureContext(owner.runtime)
  const valid = { worktree: 'id:synthetic-browser-value', page: 'synthetic-value-page', url: 'about:blank' }
  for (const params of [
    {}, { ...valid, worktree: '' }, { ...valid, url: 'javascript:alert(1)' },
    { ...valid, profileId: 'non-default' },
    { ...valid, placement: { kind: 'client', browserHostClientId: 'synthetic-browser-client' } },
    { ...valid, placement: { kind: 'server', authToken: 'synthetic-rejected-field' } },
    { ...valid, principalId: 'synthetic-forged-principal' }, { ...valid, activate: 'true' }
  ]) { await assert.rejects(handler(params, context)) }
  for (const fingerprint of [undefined, 'synthetic-forged']) {
    await assert.rejects(handler(valid, { ...context, authenticatedCallerFingerprint: fingerprint }), /CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
  }
  assert.equal(checkouts, 0)
  assert.equal(nativeCalls, 0)
  assert.equal(createReads, 0)
  const mutable = { ...valid, activate: true, navigation: 'caller' as const }
  const pending = handler(mutable, context)
  assert.equal(checkouts, 1)
  assert.equal(createReads, 1)
  // Suspend at the actual first checkout; replacements must not be consulted.
  mutable.url = 'javascript:changed-after-await'
  mutable.worktree = 'outside'
  context.authenticatedCallerFingerprint = 'changed-after-await'
  context.clientCapabilities = []
  context.pairedDeviceId = 'changed-after-await'
  context.clientKind = 'runtime'
  context.runtime = fixtureRuntime().runtime
  Object.defineProperty(owner.runtime, 'browserTabCreate', { configurable: true, value() { throw new Error('Replacement create consulted') } })
  Object.defineProperty(pool, 'connect', { value() { throw new Error('Replacement Pool connect consulted') } })
  config.assertCurrentHost = () => { throw new Error('Replacement host assertion consulted') }
  gate.reject(Object.assign(new Error('Synthetic first checkout boundary'), { code: 'Z0001' }))
  await assert.rejects(pending, /Z0001/)
  assert.ok(hostChecks >= 2)
  assert.equal(checkouts, 1)
  assert.equal(nativeCalls, 0)
  assert.equal(Object.isFrozen(pool), false)
})
