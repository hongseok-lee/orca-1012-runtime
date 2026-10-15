import assert from 'node:assert/strict'
import test from 'node:test'
import { DurableCatalogReadAdapter } from './public.ts'
import { buildRegistry, isStreamingMethod, type RpcContext } from '../../runtime/rpc/core.ts'
import { BROWSER_SCREENCAST_METHODS } from '../../runtime/rpc/methods/browser-screencast.ts'
import { Screencast } from '../../../shared/rpc-contract/browser-params.ts'
import { fixtureContext, deferred, syntheticFingerprint } from './fixture-support.mts'
import { streamRecoveryReadPool, streamRecoveryNative, streamPage, streamWorkspace, streamOrigin } from './browser-stream-recovery-fixtures.ts'

if (process.env.ORCA_BROWSER_STREAM_RECOVERY_APPROVED !== 'root-source-reviewed') {
  throw new Error('Root stream recovery source review required')
}

test('인증된 Browser stream은 기존 native 조회를 보존하고 부재만 같은 PG page로 복구합니다', { timeout: 10000 }, async t => {
  function fixture() {
    const db = streamRecoveryReadPool(), native = streamRecoveryNative(streamWorkspace)
    const config = native.config(db.pool), adapter = new DurableCatalogReadAdapter(config)
    const calls: { params: unknown; options: unknown }[] = []
    Object.defineProperty(native.runtime, 'browserScreencast', { configurable: true, value: async function (
      this: typeof native.runtime, params: Parameters<typeof native.runtime.browserScreencast>[0],
      options: Parameters<typeof native.runtime.browserScreencast>[1]
    ) {
      assert.equal(this, native.runtime)
      calls.push({ params: { ...params }, options })
      options.emit({ type: 'end', subscriptionId: `synthetic-stream-recovery:${params.page}` })
    } })
    const original = BROWSER_SCREENCAST_METHODS.find(method => method.name === 'browser.screencast')!
    const methods = adapter.bind(BROWSER_SCREENCAST_METHODS)
    const method = buildRegistry(methods).get('browser.screencast')!
    if (!isStreamingMethod(method)) { assert.fail('Screencast must remain streaming') }
    const frames: unknown[] = []
    const emit = (frame: unknown) => { frames.push(frame) }
    t.after(async () => { adapter.dispose(); await native.stop() })
    return { db, native, config, adapter, calls, frames, emit, method, original, methods,
      params: { worktree: `id:${streamWorkspace}`, page: streamPage, format: 'png', mobile: true,
        viewportWidth: 390, viewportHeight: 616, deviceScaleFactor: 2, quality: 80 } }
  }
  await t.test('PG OPEN/native 부재는 stored URL과 현재 caller 인증을 먼저 준비하고 원 stream을 1회 호출합니다', async () => {
    const f = fixture()
    f.native.session.beforeNavigate = () => {
      assert.equal(f.db.state.activeTransactions, 0)
      assert.equal(f.native.issues(), 1)
      assert.ok(f.native.session.cdp.calls.some(call => call.method === 'Fetch.enable'))
    }
    await f.method.handler(f.params, fixtureContext(f.native.runtime), f.emit)
    assert.equal(f.calls.length, 1); assert.equal(f.frames.length, 1)
    assert.deepEqual(f.calls[0].params, Screencast.parse(f.params))
    assert.equal(f.native.issues(), 1); assert.equal(f.native.selection.length, 0)
    assert.equal(f.native.session.nativeCalls.filter(call => call[0] === 'tab' && call[1] === 'new').length, 1)
    assert.ok(f.native.session.nativeCalls.some(call => call[0] === 'open' && call[1] === `${streamOrigin}/ops/`))
    assert.equal(f.native.authority.findPageSession({ browserPageId: streamPage, worktreePublicId: streamWorkspace })?.authenticatedCallerFingerprint,
      syntheticFingerprint)
    assert.equal(f.db.state.connects, f.db.state.releases)
    assert.ok(f.db.sql.every(sql => !/INSERT|UPDATE|DELETE|FOR SHARE|FOR UPDATE/.test(sql)))
    assert.equal(Object.isFrozen(f.db.pool), false)
  })
  await t.test('다른 인증 caller의 살아 있는 page 조회는 create/issuer/ensure/nav 없이 원 stream으로 갑니다', async () => {
    const f = fixture()
    await f.method.handler(f.params, fixtureContext(f.native.runtime), f.emit)
    const session = f.native.authority.findPageSession({ browserPageId: streamPage, worktreePublicId: streamWorkspace })
    const calls = structuredClone(f.native.session.nativeCalls), cdpCalls = f.native.session.cdp.calls.length
    Object.defineProperty(f.native.runtime, 'browserTabCreate', { configurable: true, value() {
      assert.fail('Live page must not create/ensure or rebind the first caller')
    } })
    await f.method.handler(f.params, fixtureContext(f.native.runtime, { authenticatedCallerFingerprint: 'b'.repeat(64) }), f.emit)
    assert.equal(f.calls.length, 2); assert.equal(f.native.issues(), 1)
    assert.deepEqual(f.native.session.nativeCalls, calls)
    assert.equal(f.native.session.cdp.calls.slice(cdpCalls).filter(call => call.method === 'Fetch.enable').length, 0)
    assert.equal(f.native.authority.findPageSession({ browserPageId: streamPage, worktreePublicId: streamWorkspace }), session)
  })
  await t.test('PG missing/closed/scope/dataset/실패는 native와 stream에 진입하지 않습니다', async () => {
    for (const scenario of ['missing', 'closed', 'scope', 'dataset', 'pg', 'unauthenticated'] as const) {
      const f = fixture()
      if (scenario === 'missing') { f.db.state.missing = true }
      if (scenario === 'closed') { f.db.tab.lifecycle = 'CLOSED' }
      if (scenario === 'scope') { f.db.workspace.public_id = 'folder:outside' }
      if (scenario === 'dataset') { f.db.state.dataset = 'outside-dataset' }
      if (scenario === 'pg') { f.db.state.fail = true }
      const context = fixtureContext(f.native.runtime,
        scenario === 'unauthenticated' ? { authenticatedCallerFingerprint: undefined } : {})
      await assert.rejects(f.method.handler(f.params, context, f.emit))
      assert.equal(f.calls.length, 0); assert.equal(f.frames.length, 0); assert.equal(f.native.issues(), 0)
      assert.deepEqual(f.native.session.nativeCalls, [])
    }
  })
  await t.test('첫 await 뒤 params/context/runtime/config 변경은 원 stream과 native receiver를 바꾸지 않습니다', async () => {
    const f = fixture(), entered = deferred<void>(), gate = deferred<void>()
    let held = false, fingerprintReads = 0
    f.db.state.beforeConnect = async () => { if (!held) { held = true; entered.resolve(); await gate.promise } }
    const controller = new AbortController(), sendBinary = () => true
    const context = Object.defineProperty(fixtureContext(f.native.runtime, { signal: controller.signal, sendBinary }),
      'authenticatedCallerFingerprint', { get() { fingerprintReads++; return syntheticFingerprint }, configurable: true })
    const originalParams = Screencast.parse(f.params), originalRuntime = f.native.runtime
    const pending = f.method.handler(f.params, context, f.emit)
    await entered.promise
    f.params.page = 'mutated'; f.params.worktree = 'outside'; f.params.quality = 1
    f.params.viewportHeight = 1; f.params.deviceScaleFactor = 1; f.params.mobile = false
    context.runtime = {} as RpcContext['runtime']; context.connectionId = 'mutated'; context.clientId = 'mutated'
    context.pairedDeviceId = 'mutated'; context.clientKind = 'runtime'; context.sendBinary = () => false
    context.signal = new AbortController().signal
    Object.defineProperty(originalRuntime, 'browserTabShow', { configurable: true, value() { assert.fail('Late show method read') } })
    Object.defineProperty(originalRuntime, 'browserTabCreate', { configurable: true, value() { assert.fail('Late create method read') } })
    Object.defineProperty(originalRuntime, 'browserScreencast', { configurable: true, value() { assert.fail('Late stream method read') } })
    Object.defineProperty(f.db.pool, 'connect', { value() { assert.fail('Late pool method read') }, configurable: true })
    f.config.browserOpsAuth.issuePageSession = () => { assert.fail('Late issuer method read') }
    gate.resolve(); await pending
    assert.equal(fingerprintReads, 1); assert.deepEqual(f.calls[0].params, originalParams)
    const options = f.calls[0].options as Parameters<typeof originalRuntime.browserScreencast>[1]
    assert.equal(options.connectionId, 'synthetic-connection'); assert.equal(options.pairedDeviceId, 'synthetic-device')
    assert.equal(options.clientKind, 'mobile'); assert.equal(options.signal, controller.signal)
    assert.equal(options.sendBinary, sendBinary); assert.equal(options.emit, f.emit)
    assert.equal(f.native.issues(), 1)
  })
  await t.test('abort/dispose/native 실패/close race는 이번 auth만 정리하고 frame을 반환하지 않습니다', async () => {
    for (const boundary of ['abort-before', 'dispose-before', 'abort-native', 'dispose-native', 'close', 'native-failure', 'wrong-id'] as const) {
      const f = fixture(), controller = new AbortController()
      const context = fixtureContext(f.native.runtime, { signal: controller.signal })
      if (boundary === 'abort-before' || boundary === 'dispose-before') {
        const entered = deferred<void>(), release = deferred<void>(); let held = false
        f.db.state.beforeConnect = async () => { if (!held) { held = true; entered.resolve(); await release.promise } }
        const pending = f.method.handler(f.params, context, f.emit); await entered.promise
        if (boundary === 'abort-before') { controller.abort() } else { f.adapter.dispose() }
        release.resolve(); await assert.rejects(pending)
        assert.deepEqual(f.native.session.nativeCalls, [])
      } else {
        if (boundary === 'native-failure') { f.native.session.failNavigate = true }
        f.native.session.beforeNavigate = () => {
          if (boundary === 'abort-native') { controller.abort() }
          if (boundary === 'dispose-native') { f.adapter.dispose() }
          if (boundary === 'close') { f.db.tab.lifecycle = 'CLOSED' }
        }
        if (boundary === 'wrong-id') {
          const create = f.native.commands.browserTabCreate.bind(f.native.commands)
          Object.defineProperty(f.native.runtime, 'browserTabCreate', { configurable: true, value: async (...args: Parameters<typeof create>) => {
            await create(...args); return { browserPageId: 'synthetic-wrong-page' }
          } })
        }
        await assert.rejects(f.method.handler(f.params, context, f.emit))
      }
      assert.equal(f.calls.length, 0); assert.equal(f.frames.length, 0)
      assert.equal(f.native.authority.findPageSession({ browserPageId: streamPage, worktreePublicId: streamWorkspace }), null)
      assert.equal(f.native.session.nativeCalls.filter(call => call[0] === 'tab' && call[1] === 'close').length, 0)
    }
  })
  await t.test('generic show 오류/잘못된 identity는 missing으로 바꾸지 않고 stream을 시작하지 않습니다', async () => {
    for (const failure of ['external_cdp_error', 'browser_ops_auth_unavailable', '08006', 'wrong-page', 'wrong-worktree']) {
      const f = fixture()
      Object.defineProperty(f.native.runtime, 'browserTabShow', { configurable: true, value: async function () {
        assert.equal(this, f.native.runtime)
        if (failure.startsWith('wrong-')) {
          return { tab: { browserPageId: failure === 'wrong-page' ? 'wrong' : streamPage,
            worktreeId: failure === 'wrong-worktree' ? 'wrong' : streamWorkspace } }
        }
        throw Object.assign(new Error('Synthetic show error'), { code: failure })
      } })
      await assert.rejects(f.method.handler(f.params, fixtureContext(f.native.runtime), f.emit),
        { code: failure.startsWith('wrong-') ? 'CATALOG_BROWSER_NATIVE_PAGE_MISMATCH' : failure })
      assert.equal(f.native.issues(), 0); assert.deepEqual(f.native.session.nativeCalls, [])
      assert.equal(f.frames.length, 0)
    }
  })
  await t.test('기존 auth는 post-read 거절이나 정상 stream 종료 때문에 폐기하지 않습니다', async () => {
    const f = fixture()
    await f.method.handler(f.params, fixtureContext(f.native.runtime), f.emit)
    const session = f.native.authority.findPageSession({ browserPageId: streamPage, worktreePublicId: streamWorkspace })
    const show = f.native.commands.browserTabShow.bind(f.native.commands)
    Object.defineProperty(f.native.runtime, 'browserTabShow', { configurable: true, value: async (...args: Parameters<typeof show>) => {
      const result = await show(...args); f.db.tab.lifecycle = 'CLOSED'; return result
    } })
    await assert.rejects(f.method.handler(f.params, fixtureContext(f.native.runtime), f.emit),
      { code: 'CATALOG_BROWSER_CLOSED_DURING_STREAM_PREPARATION_CLEANUP_UNVERIFIED' })
    assert.equal(f.calls.length, 1); assert.equal(f.native.issues(), 1)
    assert.equal(f.native.authority.findPageSession({ browserPageId: streamPage, worktreePublicId: streamWorkspace }), session)
  })
  await t.test('browser_tab_closed만 같은 ID의 새 native에 진입하고 중복 구독은 기존 queue로 직렬화합니다', async () => {
    const f = fixture()
    await Promise.all([f.method.handler(f.params, fixtureContext(f.native.runtime), f.emit),
      f.method.handler(f.params, fixtureContext(f.native.runtime), f.emit)])
    assert.equal(f.calls.length, 2); assert.equal(f.native.issues(), 1)
    assert.equal(f.native.session.nativeCalls.filter(call => call[0] === 'tab' && call[1] === 'new').length, 1)
    f.native.session.cdp.targets.delete('target-agent-1')
    await f.method.handler(f.params, fixtureContext(f.native.runtime), f.emit)
    assert.equal(f.calls.length, 3); assert.equal(f.native.issues(), 2)
    assert.equal(f.native.session.nativeCalls.filter(call => call[0] === 'tab' && call[1] === 'new').length, 2)
    assert.equal(f.native.selection.length, 0)
  })
  await t.test('원 schema/metadata/unsubscribe와 미설정·빈 selector 경로를 보존합니다', async () => {
    const f = fixture(), original = f.original
    const bound = f.methods.find(method => method.name === 'browser.screencast')!
    assert.equal(bound.params, original.params); assert.equal(bound.name, original.name)
    assert.equal('stream' in bound && bound.stream, true)
    assert.equal(f.methods.find(method => method.name.endsWith('.unsubscribe')), BROWSER_SCREENCAST_METHODS[1])
    const optOut = buildRegistry(BROWSER_SCREENCAST_METHODS).get(original.name)!
    assert.equal(optOut.handler, original.handler)
    assert.throws(() => f.adapter.bind([{ name: 'browser.screencast', params: original.params, handler() {} }]),
      { code: 'CATALOG_REGISTRY_KIND' })
    for (const params of [{}, { page: streamPage }, { worktree: streamWorkspace }, { worktree: '', page: streamPage },
      { worktree: streamWorkspace, page: '' }]) {
      await f.method.handler(params, fixtureContext(f.native.runtime, { authenticatedCallerFingerprint: undefined }), f.emit)
    }
    assert.equal(f.db.state.connects, 0); assert.deepEqual(f.native.session.nativeCalls, [])
    assert.equal(f.native.issues(), 0); assert.equal(f.calls.length, 5)
    const declaration = { ...original, fixtureMetadata: Object.freeze({ keep: true }) }
    const wrapped = f.adapter.bind([declaration])[0]
    assert.equal(Reflect.get(wrapped, 'fixtureMetadata'), declaration.fixtureMetadata)
  })
})
