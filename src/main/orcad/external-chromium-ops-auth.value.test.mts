import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExternalCdpEvent } from './external-chromium-cdp-connection'
import { createExternalChromiumOpsAuth } from './external-chromium-ops-auth'

// Only synthetic fixture strings are used. This fixture opens no browser/transport.
const ORIGIN = 'https://ops.example.test:8443'
const SYNTHETIC_BEARER = 'SYNTHETIC_FIXTURE_ONLY'
type Call = { method: string; params: Record<string, unknown>; sessionId?: string; transportIdentity?: number }
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
class FakeCdp {
  generation = 'owned-generation'
  transport = 7
  frame = { id: 'main-frame', loaderId: 'loader-1', url: `${ORIGIN}/ops/` }
  readonly calls: Call[] = []
  readonly attachments: { targetId: string; generation: string }[] = []
  readonly cancelled: { sessionId: string; transportIdentity?: number }[] = []
  readonly events = new Set<(event: ExternalCdpEvent) => void>()
  readonly failures = new Set<() => void>()
  readonly generations = new Set<() => void>()
  private readonly waiting = new Map<string, ((call: Call) => void)[]>()
  attachGate: ReturnType<typeof gate> | null = null
  treeGate: ReturnType<typeof gate> | null = null
  failCommand: string | null = null
  ignoreAttachAssertion = false
  async attach(targetId: string, generation: string, assertActive: () => void = () => {}): Promise<string> {
    assertActive()
    this.attachments.push({ targetId, generation })
    if (this.attachGate) { await this.attachGate.promise }
    if (!this.ignoreAttachAssertion) { assertActive() }
    return 'owned-auth-session'
  }
  async command(method: string, params: Record<string, unknown> = {}, sessionId?: string, transportIdentity?: number): Promise<unknown> {
    const call = { method, params: structuredClone(params), sessionId, transportIdentity }
    this.calls.push(call)
    const waiter = this.waiting.get(method)?.shift()
    waiter?.(call)
    if (method === this.failCommand) { throw new Error(`synthetic-command-error-${SYNTHETIC_BEARER}`) }
    if (method === 'Page.getFrameTree') {
      const frame = { ...this.frame }, pending = this.treeGate
      this.treeGate = null
      if (pending) { await pending.promise }
      return { frameTree: { frame } }
    }
    return {}
  }
  ownsTransport(identity: number, generation: string): boolean {
    return identity === this.transport && generation === this.generation
  }
  cancelSession(sessionId: string, transportIdentity?: number): void { this.cancelled.push({ sessionId, transportIdentity }) }
  onEvent(listener: (event: ExternalCdpEvent) => void): () => void {
    this.events.add(listener)
    return () => { this.events.delete(listener) }
  }
  onFailure(listener: () => void): () => void {
    this.failures.add(listener)
    return () => { this.failures.delete(listener) }
  }
  onGenerationChanged(listener: () => void): () => void {
    this.generations.add(listener)
    return () => { this.generations.delete(listener) }
  }
  emit(method: string, params: Record<string, unknown>, sessionId = 'owned-auth-session'): void {
    for (const listener of [...this.events]) { listener({ method, params, sessionId }) }
  }
  next(method: string): Promise<Call> {
    return new Promise(resolve => {
      const list = this.waiting.get(method) ?? []
      list.push(resolve); this.waiting.set(method, list)
    })
  }
  navigate(url: string, loaderId = 'loader-2'): void {
    this.frame = { ...this.frame, url, loaderId }
    this.emit('Page.frameNavigated', { frame: { ...this.frame } })
  }
}
function input(connection: FakeCdp) {
  const counts = { read: 0, dispose: 0 }
  return { connection, counts, opsOrigin: ORIGIN,
    page: { publicPageId: 'public-page', targetId: 'owned-target', browserGeneration: 'owned-generation', transportIdentity: 7 },
    readBearer(): string | null { this.counts.read++; return SYNTHETIC_BEARER },
    disposeBearer() { this.counts.dispose++ }
  }
}
function params(requestId: string, change: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId, frameId: 'main-frame', resourceType: 'Fetch',
    request: { url: `${ORIGIN}/ops/v1/runtime-units`, headers: { Accept: 'application/json' }, postData: 'synthetic body' }, ...change }
}
async function pause(cdp: FakeCdp, requestId: string, change: Record<string, unknown> = {}): Promise<Call> {
  const continued = cdp.next('Fetch.continueRequest')
  cdp.emit('Fetch.requestPaused', params(requestId, change))
  return continued
}
function unchanged(call: Call, requestId: string): void {
  assert.deepEqual(call, { method: 'Fetch.continueRequest', params: { requestId },
    sessionId: 'owned-auth-session', transportIdentity: 7 })
}

test('owned Ops request interception uses the real helper with a fake CDP transport', { timeout: 10000 }, async t => {
  await t.test('one exact main-frame API request gets one override; cleanup owns only its session', async t => {
    const cdp = new FakeCdp(), config = input(cdp)
    const handle = await createExternalChromiumOpsAuth(config)
    t.after(() => handle.dispose())
    assert.ok(Object.isFrozen(handle)); assert.ok(Object.isFrozen(handle.snapshot()))
    assert.deepEqual(handle.snapshot(), { phase: 'ready', documentEligible: true })
    assert.deepEqual(cdp.attachments, [{ targetId: 'owned-target', generation: 'owned-generation' }])
    assert.deepEqual(cdp.calls.slice(0, 3).map(call => call.method), ['Page.enable', 'Page.getFrameTree', 'Fetch.enable'])
    assert.deepEqual(cdp.calls[2].params, { patterns: [
      { resourceType: 'Fetch', requestStage: 'Request' }, { resourceType: 'XHR', requestStage: 'Request' }
    ], handleAuthRequests: false })
    const call = await pause(cdp, 'approved')
    assert.deepEqual(call.params, { requestId: 'approved', headers: [
      { name: 'Accept', value: 'application/json' }, { name: 'Authorization', value: `Bearer ${SYNTHETIC_BEARER}` }
    ] })
    assert.equal(call.sessionId, 'owned-auth-session'); assert.equal(call.transportIdentity, 7)
    assert.equal(config.counts.read, 1)
    assert.ok(!JSON.stringify(handle).includes(SYNTHETIC_BEARER))
    assert.ok(!JSON.stringify(handle.snapshot()).includes(SYNTHETIC_BEARER))
    const disposal = handle.dispose(); assert.equal(handle.dispose(), disposal); await disposal
    assert.equal(config.counts.dispose, 1)
    assert.deepEqual(cdp.cancelled, [{ sessionId: 'owned-auth-session', transportIdentity: 7 }])
    assert.deepEqual(cdp.calls.at(-2), { method: 'Fetch.disable', params: {}, sessionId: 'owned-auth-session', transportIdentity: 7 })
    assert.deepEqual(cdp.calls.at(-1), { method: 'Target.detachFromTarget', params: { sessionId: 'owned-auth-session' },
      sessionId: undefined, transportIdentity: 7 })
    assert.equal(cdp.events.size + cdp.failures.size + cdp.generations.size, 0)
    assert.deepEqual(handle.snapshot(), { phase: 'disposed', documentEligible: false })
  })
  await t.test('foreign origin/port/path, userinfo, iframe/worker, redirect and response stage continue untouched', async t => {
    const cdp = new FakeCdp(), config = input(cdp), handle = await createExternalChromiumOpsAuth(config)
    t.after(() => handle.dispose())
    const request = (url: string) => ({ url, headers: { Accept: 'application/json' } })
    const cases = [
      { request: request('https://foreign.example.test/ops/v1/events') },
      { request: request('https://ops.example.test/ops/v1/events') },
      { request: request(`${ORIGIN}/ops/v10/events`) },
      { request: request(`${ORIGIN}/ops/app.js`) },
      { request: request('https://user:synthetic@ops.example.test:8443/ops/v1/events') },
      { frameId: 'child-frame' }, { frameId: '' }, { resourceType: 'Document' },
      { redirectedRequestId: 'earlier-hop' }, { responseStatusCode: 302 }, { responseErrorReason: 'Failed' }
    ]
    for (const [index, change] of cases.entries()) {
      const id = `rejected-${index}`
      unchanged(await pause(cdp, id, change), id)
    }
    assert.equal(config.counts.read, 0)
    const before = cdp.calls.length
    cdp.emit('Fetch.requestPaused', params('other-page'), 'other-session')
    cdp.emit('Fetch.requestPaused', params('worker-target'), 'worker-session')
    cdp.emit('Target.targetDestroyed', { targetId: 'other-target' }, 'other-session')
    await Promise.resolve()
    assert.equal(cdp.calls.length, before); assert.equal(config.counts.dispose, 0)
  })
  await t.test('every casing of a preexisting Authorization header, including empty, is preserved', async t => {
    const cdp = new FakeCdp(), config = input(cdp), handle = await createExternalChromiumOpsAuth(config)
    t.after(() => handle.dispose())
    for (const [index, name] of ['Authorization', 'authorization', 'aUtHoRiZaTiOn'].entries()) {
      const id = `manual-${index}`
      unchanged(await pause(cdp, id, { request: { url: `${ORIGIN}/ops/v1/events`, headers: { [name]: index ? 'manual-fixture' : '' } } }), id)
    }
    assert.equal(config.counts.read, 0)
  })
  await t.test('about:blank stays inactive until an Ops document commits and deactivates on departure', async t => {
    const cdp = new FakeCdp(); cdp.frame.url = 'about:blank#synthetic-marker'
    const config = input(cdp), handle = await createExternalChromiumOpsAuth(config)
    t.after(() => handle.dispose())
    assert.equal(handle.snapshot().documentEligible, false)
    unchanged(await pause(cdp, 'marker'), 'marker')
    cdp.navigate(`${ORIGIN}/ops`)
    assert.equal(handle.snapshot().documentEligible, true)
    assert.ok('headers' in (await pause(cdp, 'after-commit', { resourceType: 'XHR' })).params)
    cdp.navigate('https://foreign.example.test/ops/', 'loader-3')
    unchanged(await pause(cdp, 'foreign-document'), 'foreign-document')
    cdp.navigate(`${ORIGIN}/other`, 'loader-4')
    unchanged(await pause(cdp, 'other-document-path'), 'other-document-path')
    assert.equal(config.counts.read, 1)
  })
  await t.test('same-document path changes and navigation start invalidate eligibility', async t => {
    const cdp = new FakeCdp(), handle = await createExternalChromiumOpsAuth(input(cdp))
    t.after(() => handle.dispose())
    cdp.frame.url = `${ORIGIN}/other`
    cdp.emit('Page.navigatedWithinDocument', { frameId: 'main-frame', url: cdp.frame.url })
    unchanged(await pause(cdp, 'same-document-away'), 'same-document-away')
    cdp.navigate(`${ORIGIN}/ops/`)
    cdp.emit('Page.frameStartedNavigating', { frameId: 'main-frame', loaderId: 'next-loader' })
    unchanged(await pause(cdp, 'during-navigation'), 'during-navigation')
    assert.equal(handle.snapshot().documentEligible, false)
  })
  await t.test('navigation during a frame observation cannot borrow the old document authority', async t => {
    const cdp = new FakeCdp(), config = input(cdp), handle = await createExternalChromiumOpsAuth(config)
    t.after(() => handle.dispose())
    const observation = gate(); cdp.treeGate = observation
    const reading = cdp.next('Page.getFrameTree'), continued = cdp.next('Fetch.continueRequest')
    cdp.emit('Fetch.requestPaused', params('navigation-race')); await reading
    cdp.navigate('https://foreign.example.test/', 'new-loader'); observation.release()
    unchanged(await continued, 'navigation-race'); assert.equal(config.counts.read, 0)
  })
  await t.test('an unobserved loader replacement fails closed before reading a bearer', async t => {
    const cdp = new FakeCdp(), config = input(cdp), handle = await createExternalChromiumOpsAuth(config)
    t.after(() => handle.dispose())
    cdp.frame.loaderId = 'unobserved-loader'
    unchanged(await pause(cdp, 'loader-race'), 'loader-race')
    assert.equal(config.counts.read, 0); assert.equal(handle.snapshot().documentEligible, false)
  })
  await t.test('a synchronous bearer read cannot race a navigation into adding a credential', async t => {
    const cdp = new FakeCdp(), config = input(cdp)
    config.readBearer = function () { this.counts.read++; cdp.navigate(`${ORIGIN}/other`); return SYNTHETIC_BEARER }
    const handle = await createExternalChromiumOpsAuth(config); t.after(() => handle.dispose())
    unchanged(await pause(cdp, 'bearer-navigation-race'), 'bearer-navigation-race')
    assert.equal(config.counts.read, 1)
  })
  await t.test('dispose releases a paused request once without waiting for an outstanding observation', async () => {
    const cdp = new FakeCdp(), config = input(cdp), handle = await createExternalChromiumOpsAuth(config)
    const observation = gate(); cdp.treeGate = observation
    const reading = cdp.next('Page.getFrameTree'), continued = cdp.next('Fetch.continueRequest')
    cdp.emit('Fetch.requestPaused', params('dispose-race')); await reading
    const disposal = handle.dispose()
    unchanged(await continued, 'dispose-race'); await disposal
    observation.release(); await Promise.resolve(); await Promise.resolve()
    assert.equal(cdp.calls.filter(call => call.method === 'Fetch.continueRequest').length, 1)
    assert.equal(config.counts.read, 0); assert.equal(config.counts.dispose, 1)
  })
  await t.test('transport/generation changes release the bearer and never clean up a replacement transport', async () => {
    for (const boundary of ['transport', 'generation'] as const) {
      const cdp = new FakeCdp(), config = input(cdp), handle = await createExternalChromiumOpsAuth(config)
      const before = cdp.calls.length
      if (boundary === 'transport') {
        cdp.transport++; for (const listener of [...cdp.failures]) { listener() }
      } else {
        cdp.generation = 'replacement'; for (const listener of [...cdp.generations]) { listener() }
      }
      await handle.dispose()
      assert.equal(cdp.calls.length, before); assert.equal(cdp.cancelled.length, 0)
      assert.equal(config.counts.dispose, 1); assert.equal(cdp.events.size, 0)
      assert.deepEqual(handle.snapshot(), { phase: 'failed', documentEligible: false })
    }
  })
  await t.test('target destruction disposes only the owned session and bearer', async () => {
    const cdp = new FakeCdp(), config = input(cdp), handle = await createExternalChromiumOpsAuth(config)
    cdp.emit('Target.targetDestroyed', { targetId: 'owned-target' }, '')
    await handle.dispose()
    assert.equal(config.counts.dispose, 1)
    assert.ok(cdp.calls.every(call => call.sessionId === undefined || call.sessionId === 'owned-auth-session'))
    assert.deepEqual(cdp.calls.at(-1)?.params, { sessionId: 'owned-auth-session' })
  })
  await t.test('input values and method receivers are captured before the first await', async t => {
    const cdp = new FakeCdp(), config = input(cdp), attaching = gate(); cdp.attachGate = attaching
    const pending = createExternalChromiumOpsAuth(config)
    config.opsOrigin = 'https://replacement.example.test'
    config.page.targetId = 'replacement-target'; config.page.publicPageId = 'replacement-page'
    config.page.transportIdentity = 999; config.page.browserGeneration = 'replacement'
    config.readBearer = () => 'REPLACED_FIXTURE'; config.disposeBearer = () => { throw new Error('replacement disposal must not run') }
    cdp.command = async () => { throw new Error('replacement method must not run') }
    cdp.ownsTransport = () => false
    attaching.release()
    const handle = await pending; t.after(() => handle.dispose())
    const call = await pause(cdp, 'captured')
    assert.deepEqual(call.params.headers, [{ name: 'Accept', value: 'application/json' },
      { name: 'Authorization', value: `Bearer ${SYNTHETIC_BEARER}` }])
    assert.equal(call.transportIdentity, 7); assert.equal(cdp.attachments[0].targetId, 'owned-target')
    await handle.dispose(); assert.equal(config.counts.dispose, 1)
  })
  await t.test('installation/continue errors are stable, secret-free and never retried', async () => {
    const cdp = new FakeCdp(), config = input(cdp); cdp.failCommand = 'Fetch.enable'
    await assert.rejects(createExternalChromiumOpsAuth(config), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, 'The owned browser operations authentication is unavailable.')
      assert.equal('code' in error && error.code, 'browser_ops_auth_unavailable')
      assert.ok(!JSON.stringify(error).includes(SYNTHETIC_BEARER)); return true
    })
    assert.equal(config.counts.dispose, 1); assert.equal(cdp.events.size, 0)
    assert.equal(cdp.calls.filter(call => call.method === 'Fetch.enable').length, 1)
    const other = new FakeCdp(), otherConfig = input(other), handle = await createExternalChromiumOpsAuth(otherConfig)
    other.failCommand = 'Fetch.continueRequest'
    await pause(other, 'no-retry')
    await Promise.resolve(); await Promise.resolve(); await handle.dispose()
    assert.equal(other.calls.filter(call => call.method === 'Fetch.continueRequest').length, 1)
    assert.equal(otherConfig.counts.dispose, 1)
  })
  await t.test('invalid origin and missing/invalid bearer cannot create automatic authority', async t => {
    for (const origin of [`${ORIGIN}/`, `${ORIGIN}/path`, `${ORIGIN}?q=1`, `${ORIGIN}#fragment`,
      'https://user:synthetic@ops.example.test:8443', 'file:///ops']) {
      const cdp = new FakeCdp(), config = input(cdp); config.opsOrigin = origin
      await assert.rejects(createExternalChromiumOpsAuth(config), { code: 'browser_ops_auth_unavailable' })
      assert.equal(cdp.calls.length, 0); assert.equal(config.counts.dispose, 1)
    }
    for (const bearer of [null, '', 'synthetic\r\nInjected: fixture']) {
      const cdp = new FakeCdp(), config = input(cdp); config.readBearer = () => bearer
      const handle = await createExternalChromiumOpsAuth(config); t.after(() => handle.dispose())
      unchanged(await pause(cdp, 'invalid-bearer'), 'invalid-bearer')
    }
  })
  await t.test('a late attach after target failure is detached without enabling Fetch or leaking owner errors', async () => {
    const cdp = new FakeCdp(), config = input(cdp), attaching = gate()
    cdp.attachGate = attaching; cdp.ignoreAttachAssertion = true
    const pending = createExternalChromiumOpsAuth(config)
    cdp.emit('Target.targetDestroyed', { targetId: 'owned-target' }, '')
    attaching.release()
    await assert.rejects(pending, { code: 'browser_ops_auth_unavailable' })
    assert.equal(config.counts.dispose, 1)
    assert.deepEqual(cdp.calls.map(call => call.method), ['Target.detachFromTarget'])
    assert.equal(cdp.events.size + cdp.failures.size + cdp.generations.size, 0)
  })
})
