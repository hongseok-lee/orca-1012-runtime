import assert from 'node:assert/strict'
import test from 'node:test'
import { ExternalChromiumPointer } from './external-chromium-pointer'
import { ExternalChromiumBrowserProcess } from './external-chromium-browser-process'
import { ExternalChromiumBrowserSession } from './external-chromium-browser-session'
import { ExternalChromiumCdpConnection } from './external-chromium-cdp-connection'
import { ExternalChromiumTabRegistry } from './external-chromium-tab-registry'
import type { ExternalChromiumPageRecord } from './external-chromium-tab-projection'
import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'

type Call = { method: string; params: Record<string, unknown>; sessionId?: string; transport?: number }
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function page(id = 'page-a', target = 'target-a', generation = 'generation-a'): ExternalChromiumPageRecord {
  return { publicPageId: id, agentPageId: `native-${id}`, targetId: target,
    browserGeneration: generation, worktreeId: 'owned-worktree' }
}
class FakeCdp {
  transportIdentity = 7
  generation = 'generation-a'
  readonly attachments: { targetId: string; generation: string }[] = []
  readonly calls: Call[] = []
  readonly cancelled: { sessionId: string; transport?: number }[] = []
  attachGate: ReturnType<typeof gate> | null = null
  failWheel = false
  ownsTransport(identity: number, generation: string): boolean {
    return identity === this.transportIdentity && generation === this.generation
  }
  async attach(targetId: string, generation: string, assertActive: () => void = () => {}): Promise<string> {
    assertActive()
    this.attachments.push({ targetId, generation })
    if (this.attachGate) { await this.attachGate.promise }
    assertActive()
    return `owned-session-${targetId}`
  }
  async command(method: string, params: Record<string, unknown> = {}, sessionId?: string, transport?: number): Promise<unknown> {
    this.calls.push({ method, params: structuredClone(params), sessionId, transport })
    if (method === 'Input.dispatchMouseEvent' && this.failWheel) { throw new Error('Synthetic lost response') }
    return {}
  }
  cancelSession(sessionId: string, transport?: number): void { this.cancelled.push({ sessionId, transport }) }
  wheels(): Call[] { return this.calls.filter(call => call.method === 'Input.dispatchMouseEvent') }
}

// Synthetic CDP/CLI boundaries only: this fixture starts no browser or transport.
test('external pointer wheel ownership', async t => {
  await t.test('keeps coordinates per exact page and preserves target, delta and result shape', async () => {
    const cdp = new FakeCdp(), pointer = new ExternalChromiumPointer(cdp)
    const a = page(), b = page('page-b', 'target-b')
    await pointer.move(a, { x: 81, y: 223 }, async () => ({ moved: true }))
    assert.deepEqual(await pointer.wheel(b, { dy: 44 }), { scrolled: true, deltaX: 0, deltaY: 44 })
    await pointer.move(b, { x: 170, y: 309 }, async () => ({ moved: true }))
    await pointer.wheel(a, { dx: -13, dy: 71 })
    await pointer.wheel(b, { dx: 4, dy: -52 })
    assert.deepEqual(cdp.attachments, [
      { targetId: 'target-b', generation: 'generation-a' },
      { targetId: 'target-a', generation: 'generation-a' },
      { targetId: 'target-b', generation: 'generation-a' }
    ])
    assert.deepEqual(cdp.wheels().map(call => call.params), [
      { type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY: 44 },
      { type: 'mouseWheel', x: 81, y: 223, deltaX: -13, deltaY: 71 },
      { type: 'mouseWheel', x: 170, y: 309, deltaX: 4, deltaY: -52 }
    ])
    assert.deepEqual(cdp.wheels().map(call => call.sessionId), [
      'owned-session-target-b', 'owned-session-target-a', 'owned-session-target-b'
    ])
    assert.ok(cdp.wheels().every(call => call.transport === 7))
    assert.deepEqual(cdp.calls.filter(call => call.method === 'Target.detachFromTarget').map(call => call.params),
      cdp.wheels().map(call => ({ sessionId: call.sessionId })))
  })
  await t.test('a failed or nonfinite move does not replace the last successful point', async () => {
    const cdp = new FakeCdp(), pointer = new ExternalChromiumPointer(cdp), a = page()
    await pointer.move(a, { x: 91, y: 211 }, async () => ({ moved: true }))
    await assert.rejects(pointer.move(a, { x: 4, y: 5 }, async () => { throw new Error('Synthetic move failure') }))
    let invalidMoves = 0
    await assert.rejects(pointer.move(a, { x: Infinity, y: 5 }, async () => { invalidMoves++; return {} }),
      { code: 'invalid_argument' })
    assert.equal(invalidMoves, 0)
    await pointer.wheel(a, { dy: 60 })
    assert.deepEqual(cdp.wheels()[0].params, { type: 'mouseWheel', x: 91, y: 211, deltaX: 0, deltaY: 60 })
  })
  await t.test('replacement target, generation and transport cannot inherit a point', async () => {
    const cdp = new FakeCdp(), pointer = new ExternalChromiumPointer(cdp), a = page()
    await pointer.move(a, { x: 91, y: 211 }, async () => ({}))
    const replacement = page('page-a', 'target-new')
    await pointer.wheel(replacement, { dy: 1 })
    await pointer.move(replacement, { x: 92, y: 212 }, async () => ({}))
    cdp.generation = 'generation-new'
    const fresh = page('page-a', 'target-new', 'generation-new')
    await pointer.wheel(fresh, { dy: 2 })
    await pointer.move(fresh, { x: 93, y: 213 }, async () => ({}))
    cdp.transportIdentity++
    await pointer.wheel(fresh, { dy: 3 })
    assert.ok(cdp.wheels().every(call => call.params.x === 0 && call.params.y === 0))
  })
  await t.test('retirement or clear during CLI move cannot resurrect old state', async () => {
    for (const boundary of ['retire', 'clear'] as const) {
      const cdp = new FakeCdp(), pointer = new ExternalChromiumPointer(cdp), a = page(), held = gate()
      const move = pointer.move(a, { x: 51, y: 181 }, () => held.promise)
      if (boundary === 'retire') { pointer.forgetPage(a.publicPageId) } else { pointer.clear() }
      held.release()
      await assert.rejects(move, { code: 'browser_screencast_unavailable' })
      await pointer.wheel(a, { dy: 20 })
      assert.equal(cdp.wheels()[0].params.x, 0)
      assert.equal(cdp.wheels()[0].params.y, 0)
    }
  })
  await t.test('attach cancellation and transport replacement never dispatch to a stale session', async () => {
    for (const boundary of ['retire', 'transport'] as const) {
      const cdp = new FakeCdp(), pointer = new ExternalChromiumPointer(cdp), a = page(), held = gate()
      cdp.attachGate = held
      const wheel = pointer.wheel(a, { dy: 50 })
      if (boundary === 'retire') { pointer.forgetPage(a.publicPageId) } else { cdp.transportIdentity++ }
      held.release()
      await assert.rejects(wheel, { code: 'browser_screencast_unavailable' })
      assert.equal(cdp.wheels().length, 0)
      assert.equal(cdp.calls.length, 0)
    }
  })
  await t.test('lost wheel response sends exactly once and detaches only the owned session', async () => {
    const cdp = new FakeCdp(), pointer = new ExternalChromiumPointer(cdp)
    cdp.failWheel = true
    await assert.rejects(pointer.wheel(page(), { dx: 3, dy: 40 }), { code: 'browser_screencast_unavailable' })
    assert.equal(cdp.wheels().length, 1)
    assert.deepEqual(cdp.calls.at(-1), { method: 'Target.detachFromTarget',
      params: { sessionId: 'owned-session-target-a' }, sessionId: undefined, transport: 7 })
    assert.deepEqual(cdp.cancelled, [{ sessionId: 'owned-session-target-a', transport: 7 }])
  })
})

test('process captures queued inputs and never falls back to CLI wheel', async t => {
  const a = page(), cdp = new FakeCdp(), held = gate(), entered = gate()
  const cli: string[][] = []
  const resolved: Record<string, unknown>[] = []
  t.mock.method(ExternalChromiumBrowserSession.prototype, 'start', async () => 'native-page-a')
  t.mock.method(ExternalChromiumBrowserSession.prototype, 'stop', async () => {})
  t.mock.method(ExternalChromiumTabRegistry.prototype, 'resolveTargetPage', async (_host: RuntimeBrowserCommandHost, params: Record<string, unknown>) => {
    resolved.push({ ...params })
    return a
  })
  t.mock.getter(ExternalChromiumCdpConnection.prototype, 'transportIdentity', () => cdp.transportIdentity)
  t.mock.method(ExternalChromiumCdpConnection.prototype, 'ownsTransport',
    (identity: number, generation: string) => cdp.ownsTransport(identity, generation))
  t.mock.method(ExternalChromiumCdpConnection.prototype, 'attach',
    (target: string, generation: string, active?: () => void) => cdp.attach(target, generation, active))
  t.mock.method(ExternalChromiumCdpConnection.prototype, 'command',
    (method: string, params?: Record<string, unknown>, sessionId?: string, transport?: number) =>
      cdp.command(method, params, sessionId, transport))
  t.mock.method(ExternalChromiumCdpConnection.prototype, 'cancelSession',
    (sessionId: string, transport?: number) => cdp.cancelSession(sessionId, transport))
  t.mock.method(ExternalChromiumBrowserSession.prototype, 'run', async (command: readonly string[]) => {
    cli.push([...command])
    if (cli.length === 1) { entered.release(); await held.promise }
    return { moved: true }
  })
  const process = new ExternalChromiumBrowserProcess('unused', { executablePath: 'unused', provider: 'chromium' }, 'unused')
  await process.start()
  t.after(() => process.stop())
  const commands = process.createCommands({
    getAgentBrowserBridge: () => null,
    resolveWorktreeSelector: async selector => ({ id: selector }),
    resolveBrowserWorkspace: async selector => ({ id: selector }),
    resolveBrowserNetworkExecutionHost: () => { throw new Error('Unused synthetic host') },
    getBrowserHostLeaseRegistry: () => { throw new Error('Unused synthetic host') },
    getRuntimeBrowserPageRegistry: () => { throw new Error('Unused synthetic host') },
    getAuthoritativeWindow: () => { throw new Error('Unused synthetic host') },
    getAvailableAuthoritativeWindow: () => null,
    getOffscreenBrowserBackend: () => null
  })
  const first = commands.browserMouseMove({ page: 'page-a', x: 1, y: 2 })
  await entered.promise
  const move = { worktree: 'owned-worktree', page: 'page-a', x: 101, y: 301 }
  const wheel = { worktree: 'owned-worktree', page: 'page-a', dx: -4, dy: 61 }
  const second = commands.browserMouseMove(move), third = commands.browserMouseWheel(wheel)
  move.worktree = 'changed'; move.page = 'changed'; move.x = 999; move.y = 888
  wheel.worktree = 'changed'; wheel.page = 'changed'; wheel.dx = 99; wheel.dy = 88
  held.release()
  await first; await second
  assert.deepEqual(await third, { scrolled: true, deltaX: -4, deltaY: 61 })
  assert.deepEqual(cli, [['mouse', 'move', '1', '2'], ['mouse', 'move', '101', '301']])
  assert.deepEqual(resolved.map(params => params.page), ['page-a', 'page-a', 'page-a'])
  assert.deepEqual(resolved.slice(1).map(params => params.worktree), ['owned-worktree', 'owned-worktree'])
  assert.deepEqual(cdp.wheels()[0].params, { type: 'mouseWheel', x: 101, y: 301, deltaX: -4, deltaY: 61 })
  cdp.failWheel = true
  await assert.rejects(commands.browserMouseWheel({ page: 'page-a', dy: 10 }),
    { code: 'browser_screencast_unavailable' })
  assert.equal(cdp.wheels().length, 2)
  assert.equal(cli.length, 2)
})
