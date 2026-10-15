import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpsBrowserSessionAuthority } from '../durable-runtime/ops/browser-session-auth.ts'
import { createBrowserOpsAuthAttempt } from '../runtime/browser-ops-auth-capability.ts'
import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import { ExternalChromiumBrowserProcess } from './external-chromium-browser-process'
import { ExternalChromiumTabRegistry } from './external-chromium-tab-registry'
import { CompositionNativeSession } from './ops-browser-composition-fixtures.ts'
import { deferred } from '../durable-runtime/rpc/fixture-support.mts'

const origin = 'https://ops.example.test:8443', fingerprint = 'a'.repeat(64)
function fixture() {
  const session = new CompositionNativeSession(), tabs = new ExternalChromiumTabRegistry(session, async () => {})
  const process = new ExternalChromiumBrowserProcess('unused', { executablePath: 'unused', provider: 'chromium' }, 'unused')
  Reflect.set(process, 'session', session); Reflect.set(process, 'tabs', tabs); Reflect.set(process, 'available', true)
  const host = { resolveWorktreeSelector: async (id: string) => ({ id: id.replace(/^id:/, '') }),
    notifyHeadlessBrowserSessionTabsChanged() {} } as unknown as RuntimeBrowserCommandHost
  const authority = createOpsBrowserSessionAuthority({ datasetName: 'synthetic-composition', namespaceId: 'fixture', workspaceIds: [] })
  let issues = 0
  let stopping: Promise<void> | null = null
  const issuer = { origin, issuePageSession(input: Parameters<typeof authority.issuePageSession>[0]) {
    issues++; return authority.issuePageSession(input)
  } }
  const attempt = (browserPageId: string, caller = fingerprint) => createBrowserOpsAuthAttempt(issuer,
    { browserPageId, worktreePublicId: 'synthetic-worktree', authenticatedCallerFingerprint: caller })
  return { session, tabs, process, host, authority, attempt, issues: () => issues, commands: process.createCommands(host),
    stop: () => { stopping ??= process.stop().finally(() => authority.close()); return stopping } }
}

test('actual Browser process/registry compose page sessions before navigation with owned cleanup', { timeout: 10000 }, async t => {
  await t.test('queue snapshots the private caller; exact target auth is installed before destination open', async t => {
    const f = fixture(); t.after(f.stop)
    const attempt = f.attempt('synthetic-page'), capability = { ...attempt.capability }
    const caller = { pairedDeviceId: 'synthetic-device', clientKind: 'mobile' as const, opsAuth: capability }
    const params = { page: 'synthetic-page', worktree: 'synthetic-worktree', url: `${origin}/ops/`, activate: false }
    const marker = deferred<void>(); f.session.markerGate = marker
    f.session.beforeNavigate = url => {
      if (url === `${origin}/ops/`) {
        assert.ok(f.session.cdp.calls.some(call => call.method === 'Fetch.enable'))
        assert.equal(f.session.cdp.sessions.size, 1)
      }
    }
    const creating = f.commands.browserTabCreate(params, caller)
    await f.session.markerEntered.promise
    assert.equal(f.issues(), 0)
    capability.browserPageId = 'mutated'; capability.origin = 'https://foreign.example.test'
    capability.openPageSession = () => { throw new Error('Replacement capability consulted') }
    caller.opsAuth = { ...f.attempt('other-page').capability }
    params.url = 'https://foreign.example.test/'; params.page = 'mutated'; marker.resolve()
    assert.deepEqual(await creating, { browserPageId: 'synthetic-page' })
    assert.equal(f.issues(), 1)
    const pageSession = f.authority.findPageSession({ browserPageId: 'synthetic-page', worktreePublicId: 'synthetic-worktree' })
    assert.equal(pageSession?.authenticatedCallerFingerprint, fingerprint)
    assert.ok(f.session.cdp.calls.some(call => call.method === 'Fetch.enable'))
    const destination = f.session.nativeCalls.find(command => command[0] === 'open' && command[1] === `${origin}/ops/`)
    assert.ok(destination)
    const rootTarget = f.session.cdp.targets.get('target-agent-1'); assert.equal(rootTarget?.url, `${origin}/ops/`)
    // The fake native driver's destination open must see a live attached Fetch session.
    assert.equal(f.session.cdp.sessions.size, 1)
    const [sessionId] = f.session.cdp.sessions.keys()
    assert.ok(sessionId)
    f.session.cdp.emit('Fetch.requestPaused', { requestId: 'composed-request', frameId: rootTarget?.id,
      resourceType: 'Fetch', request: { url: `${origin}/ops/v1/runtime-units`, headers: { Accept: 'application/json' } } }, sessionId)
    await f.session.cdp.continued.promise
    const headers = f.session.cdp.calls.find(call => call.method === 'Fetch.continueRequest')?.params.headers
    assert.ok(Array.isArray(headers))
    const auth = headers.find(header => header.name === 'Authorization')
    assert.ok(auth && typeof auth.value === 'string')
    assert.equal(f.authority.authenticateBearer(auth.value.slice('Bearer '.length))?.principalId, `pairing-sha256:${fingerprint}`)
    const replay = f.attempt('synthetic-page')
    await f.commands.browserTabCreate({ page: 'synthetic-page', worktree: 'synthetic-worktree', activate: false }, { opsAuth: replay.capability })
    await replay.disposeCreated()
    assert.equal(f.issues(), 1); assert.equal(f.session.cdp.calls.filter(call => call.method === 'Fetch.enable').length, 1)
    assert.equal(f.authority.findPageSession({ browserPageId: 'synthetic-page', worktreePublicId: 'synthetic-worktree' }), pageSession)
    const otherPrincipal = f.attempt('synthetic-page', 'b'.repeat(64))
    await assert.rejects(f.commands.browserTabCreate({ page: 'synthetic-page', worktree: 'synthetic-worktree' }, { opsAuth: otherPrincipal.capability }))
    assert.equal(f.issues(), 1)
    await attempt.disposeCreated()
    assert.equal(f.authority.findPageSession({ browserPageId: 'synthetic-page', worktreePublicId: 'synthetic-worktree' }), null)
  })
  await t.test('identity mismatch never issues; native navigation/publication failures revoke only the new owner', async t => {
    const f = fixture(); t.after(f.stop)
    await assert.rejects(f.commands.browserTabCreate({ page: 'wrong-page', worktree: 'synthetic-worktree' }, { opsAuth: f.attempt('expected-page').capability }))
    assert.equal(f.issues(), 0)
    f.session.failNavigate = true
    await assert.rejects(f.commands.browserTabCreate({ page: 'navigation-failure', worktree: 'synthetic-worktree', url: `${origin}/ops/` },
      { opsAuth: f.attempt('navigation-failure').capability }))
    assert.equal(f.authority.findPageSession({ browserPageId: 'navigation-failure', worktreePublicId: 'synthetic-worktree' }), null)
    f.session.failNavigate = false
    const rejectingHost = { ...f.host, withBrowserTabPublication: async () => { throw new Error('Synthetic publication rejection') } }
    await assert.rejects(f.process.createCommands(rejectingHost).browserTabCreate({ page: 'publication-failure', worktree: 'synthetic-worktree', activate: false },
      { opsAuth: f.attempt('publication-failure').capability }))
    assert.equal(f.authority.findPageSession({ browserPageId: 'publication-failure', worktreePublicId: 'synthetic-worktree' }), null)
  })
  await t.test('clear/stop during attach revoke the pending unpublished session and late attach is closed', async () => {
    for (const boundary of ['clear', 'stop'] as const) {
      const f = fixture(), gate = deferred<void>(); f.session.cdp.attachGate = gate
      const creating = f.commands.browserTabCreate({ page: 'pending-page', worktree: 'synthetic-worktree', activate: false },
        { opsAuth: f.attempt('pending-page').capability })
      await f.session.cdp.attachEntered.promise
      assert.equal(f.issues(), 1)
      let stopping: Promise<void> | undefined
      if (boundary === 'clear') { f.tabs.clear() } else { stopping = f.stop() }
      assert.equal(f.authority.findPageSession({ browserPageId: 'pending-page', worktreePublicId: 'synthetic-worktree' }), null)
      gate.resolve(); await assert.rejects(creating); await stopping
      assert.equal(f.session.cdp.sessions.size, 0)
      await f.stop()
    }
  })
  await t.test('close failure and target destruction revoke their exact page without touching another page', async t => {
    const f = fixture(); t.after(f.stop)
    for (const page of ['page-one', 'page-two']) {
      await f.commands.browserTabCreate({ page, worktree: 'synthetic-worktree', activate: false }, { opsAuth: f.attempt(page).capability })
    }
    f.session.failClose = true
    await assert.rejects(f.commands.browserTabClose({ page: 'page-one', worktree: 'synthetic-worktree' }))
    assert.equal(f.authority.findPageSession({ browserPageId: 'page-one', worktreePublicId: 'synthetic-worktree' }), null)
    assert.ok(f.authority.findPageSession({ browserPageId: 'page-two', worktreePublicId: 'synthetic-worktree' }))
    f.session.cdp.emit('Target.targetDestroyed', { targetId: 'target-agent-2' })
    assert.equal(f.authority.findPageSession({ browserPageId: 'page-two', worktreePublicId: 'synthetic-worktree' }), null)
    f.session.failClose = false
  })
})
