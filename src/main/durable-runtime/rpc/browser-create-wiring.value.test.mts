import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { DurableCatalogReadAdapter } from './public.ts'
import { buildRegistry, isStreamingMethod } from '../../runtime/rpc/core.ts'
import { BROWSER_CORE_METHODS } from '../../runtime/rpc/methods/browser-core.ts'
import { BrowserTabCreateParams } from '../../runtime/rpc/methods/browser-tab-create-schema.ts'
import { fixtureConfig, fixtureContext, fixtureRuntime } from './fixture-support.mts'

// Source only. The public/registry proposal requires Root ownership transfer first.
if (process.env.ORCA_PUBLIC_BROWSER_WIRING_APPROVED !== 'root-wiring-reviewed') {
  throw new Error('Root Browser wiring review required')
}

await test('실제 Browser bind는 원 schema와 opt-out 선언을 보존하고 거절·disposed 전에 효과를 만들지 않습니다', async t => {
  let connects = 0, queries = 0, nativeCalls = 0
  const pool = {
    connect() { assert.equal(this, pool); connects++; throw new Error('Unexpected wiring PG checkout') },
    query() { assert.equal(this, pool); queries++; throw new Error('Unexpected wiring PG query') }
  } as unknown as Pool
  const owner = fixtureRuntime()
  Object.defineProperty(owner.runtime, 'browserTabCreate', { value() {
    nativeCalls++; throw new Error('Unexpected wiring native Browser command')
  } })
  const original = BROWSER_CORE_METHODS
  const originalCreate = original.find(method => method.name === 'browser.tabCreate')!
  const originalHandler = originalCreate.handler
  const adapter = new DurableCatalogReadAdapter({ ...fixtureConfig(pool), workspacePublicIds: ['synthetic-browser-wiring-value'] })
  t.after(() => adapter.dispose())
  const bound = adapter.bind(original)
  assert.equal(bound.length, original.length)
  for (let i = 0; i < original.length; i++) {
    assert.equal(bound[i].name, original[i].name)
    assert.equal(bound[i].params, original[i].params)
    assert.equal('stream' in bound[i], 'stream' in original[i])
    if (original[i].name === 'browser.tabCreate') { assert.notEqual(bound[i].handler, original[i].handler) }
    else { assert.equal(bound[i], original[i]) }
  }
  assert.equal(originalCreate.params, BrowserTabCreateParams)
  assert.equal(originalCreate.handler, originalHandler)
  const optOut = buildRegistry(original).get('browser.tabCreate')!
  assert.equal(optOut, originalCreate)
  assert.equal(optOut.params, BrowserTabCreateParams)
  assert.equal(optOut.handler, originalHandler)
  assert.throws(() => adapter.bind([{ name: 'browser.tabCreate', params: BrowserTabCreateParams,
    stream: true, handler: async () => {} }]), { code: 'CATALOG_METHOD_KIND_MISMATCH' })

  const method = buildRegistry(bound).get('browser.tabCreate')!
  if (isStreamingMethod(method)) { assert.fail('Browser create must remain unary') }
  const valid = { worktree: 'id:synthetic-browser-wiring-value', page: 'synthetic-wiring-value-page', url: 'about:blank' }
  for (const fingerprint of [undefined, 'synthetic-invalid-fingerprint']) {
    await assert.rejects(async () => method.handler(valid, fixtureContext(owner.runtime,
      { authenticatedCallerFingerprint: fingerprint })), { code: 'CATALOG_AUTHENTICATED_CALLER_REQUIRED' })
  }
  for (const params of [{}, { ...valid, profileId: 'non-default' }, { ...valid, url: 'javascript:alert(1)' },
    { ...valid, activate: 'true' }, { ...valid, principalId: 'synthetic-forged-principal' },
    { ...valid, placement: { kind: 'client', browserHostClientId: 'synthetic-client-host' } }]) {
    await assert.rejects(async () => method.handler(params, fixtureContext(owner.runtime)))
  }
  assert.equal(connects, 0); assert.equal(queries, 0); assert.equal(nativeCalls, 0)
  adapter.dispose()
  await assert.rejects(async () => method.handler(valid, fixtureContext(owner.runtime)), { code: 'CATALOG_ADAPTER_DISPOSED' })
  await assert.rejects(adapter.createBrowser(valid, fixtureContext(owner.runtime)), { code: 'CATALOG_ADAPTER_DISPOSED' })
  assert.equal(connects, 0); assert.equal(queries, 0); assert.equal(nativeCalls, 0)
  assert.equal(Object.isFrozen(pool), false)
  assert.deepEqual(owner.unexpected, [])
})
