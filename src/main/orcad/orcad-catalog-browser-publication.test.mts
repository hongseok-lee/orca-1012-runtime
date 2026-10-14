import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RuntimeBrowserCommandHost, RuntimeBrowserCommands } from '../runtime/orca-runtime-browser'
import type { BrowserSessionTabSelectionOptions } from '../runtime/browser-tab-create-publication'
import { ExternalChromiumTabRegistry } from './external-chromium-tab-registry'
import { ExternalChromiumBrowserSession, type AgentBrowserTab } from './external-chromium-browser-session'
import { ExternalChromiumCdpConnection } from './external-chromium-cdp-connection'
import { deferred, fixtureConfig } from '../durable-runtime/rpc/fixture-support.mts'
import type { Pool } from 'pg'
import type { OrcadBrowserProvider } from './orcad-browser-provider'
import { createOrcadCatalogBrowserFactory } from './orcad-catalog-browser-host.ts'

if (process.env.ORCA_BROWSER_PUBLICATION_VALUE_APPROVED !== 'root-source-reviewed') {
  throw new Error('Root Browser publication value allocation required')
}

await test('실제 registry는 delayed native open 뒤 close 승리와 generation 교체를 publication 전에 거절합니다', async t => {
  const nativeTabs: AgentBrowserTab[] = [], nativeCalls: string[][] = []
  const marks: BrowserSessionTabSelectionOptions[] = [], notifications: string[] = [], stops: string[] = []
  let selected: string | undefined, generation = 'synthetic-generation', closed = false
  let guardCalls = 0, callbackCalls = 0
  const nativeEntered = deferred<void>(), nativeRelease = deferred<void>()
  const guardEntered = deferred<void>(), guardRelease = deferred<void>()
  let blockGuard = false
  const descriptor = Object.getOwnPropertyDescriptor(ExternalChromiumCdpConnection.prototype, 'generation')!
  Object.defineProperty(ExternalChromiumCdpConnection.prototype, 'generation', { ...descriptor, get: () => generation })
  t.after(() => Object.defineProperty(ExternalChromiumCdpConnection.prototype, 'generation', descriptor))
  t.mock.method(ExternalChromiumBrowserSession.prototype, 'connectCdp', async () => {})
  t.mock.method(ExternalChromiumBrowserSession.prototype, 'readTabs', async () => nativeTabs)
  t.mock.method(ExternalChromiumBrowserSession.prototype, 'selectPage', async (id: string) => { selected = id })
  t.mock.method(ExternalChromiumBrowserSession.prototype, 'run', async (args: string[]) => {
    nativeCalls.push([...args])
    if (args[0] === 'tab' && args[1] === 'new') {
      const tabId = `synthetic-native-${nativeTabs.length}`
      nativeTabs.push({ tabId, url: args[2], title: '', active: false })
      return { tabId }
    }
    assert.equal(args[0], 'open', 'no generation-blind native close')
    const tab = nativeTabs.find(row => row.tabId === selected)
    assert.ok(tab)
    tab.url = args[1]
    if (args[1] === 'https://close-first.example/') { nativeEntered.resolve(); await nativeRelease.promise }
    return {}
  })
  t.mock.method(ExternalChromiumCdpConnection.prototype, 'exactMarkerTarget', async (marker: string) => {
    const tab = nativeTabs.find(row => row.url === marker)
    assert.ok(tab)
    return `synthetic-target-${tab.tabId}`
  })
  t.mock.method(ExternalChromiumCdpConnection.prototype, 'hasTarget', async (target: string, epoch: string) =>
    epoch === generation && nativeTabs.some(row => target === `synthetic-target-${row.tabId}`))
  const session = new ExternalChromiumBrowserSession(
    'unused-fixture', { executablePath: 'unused-fixture', provider: 'chromium' }, 'unused-fixture'
  )
  const registry = new ExternalChromiumTabRegistry(session, async page => { stops.push(page) })
  const host = {
    resolveWorktreeSelector: async () => ({ id: 'synthetic-workspace' }),
    withBrowserTabPublication: async function (this: RuntimeBrowserCommandHost, worktreeId: string, page: string, publish: () => void) {
      assert.equal(this, host)
      assert.equal(worktreeId, 'synthetic-workspace')
      assert.ok(page)
      guardCalls++
      if (blockGuard) { blockGuard = false; guardEntered.resolve(); await guardRelease.promise }
      if (closed) { throw new Error('SYNTHETIC_PG_TAB_CLOSED') }
      publish()
      callbackCalls++
    },
    markHeadlessBrowserSessionTabActive: (_worktree: string | undefined, _page: string, options?: BrowserSessionTabSelectionOptions) => {
      assert.ok(options)
      marks.push(options)
    },
    notifyHeadlessBrowserSessionTabsChanged: (worktree: string) => { notifications.push(worktree) }
  } as RuntimeBrowserCommandHost
  const capturedHook = host.withBrowserTabPublication!
  const selection: BrowserSessionTabSelectionOptions = { focusesHost: false, targetGroupId: 'synthetic-group',
    caller: { clientNavigationId: 'synthetic-device', navigation: 'caller' } }
  const pending = registry.createTab(host, { worktree: 'synthetic-workspace', page: 'closed-first', url: 'https://close-first.example/' }, selection)
  await nativeEntered.promise
  assert.equal(guardCalls, 0, 'native open await must precede the publication guard')
  // Synthetic close completes before releasing the real registry's native await.
  // The PG fixture below separately uses actual closeCatalogTab, not this flag.
  closed = true
  host.withBrowserTabPublication = async () => { throw new Error('Replacement hook consulted') }
  nativeRelease.resolve()
  await assert.rejects(pending, /SYNTHETIC_PG_TAB_CLOSED/)
  assert.equal(guardCalls, 1)
  assert.equal(callbackCalls, 0)
  assert.deepEqual(await registry.listTabs(host, { worktree: 'synthetic-workspace' }), { tabs: [] })
  await assert.rejects(registry.currentTab(host, { worktree: 'synthetic-workspace' }), /No browser tab is active/)
  assert.deepEqual(marks, [])
  assert.deepEqual(notifications, [])
  assert.deepEqual(stops, [])
  host.withBrowserTabPublication = capturedHook
  closed = false
  assert.deepEqual(await registry.createTab(host, { worktree: 'synthetic-workspace', page: 'published-first', url: 'about:blank' }, selection),
    { browserPageId: 'published-first' })
  assert.deepEqual(marks, [selection])
  assert.deepEqual(notifications, ['synthetic-workspace'])
  const callsBeforeReuse = nativeCalls.length
  closed = true
  await assert.rejects(registry.createTab(host, { worktree: 'synthetic-workspace', page: 'published-first', url: 'https://replacement.example/' }, selection),
    /SYNTHETIC_PG_TAB_CLOSED/)
  assert.equal(nativeCalls.length, callsBeforeReuse)
  assert.equal(marks.length, 1)
  assert.equal(notifications.length, 1)
  closed = false
  blockGuard = true
  const changed = registry.createTab(host, { worktree: 'synthetic-workspace', page: 'changed-generation', url: 'about:blank' }, selection)
  await guardEntered.promise
  generation = 'replacement-generation'
  guardRelease.resolve()
  await assert.rejects(changed)
  assert.equal(marks.length, 1)
  assert.equal(notifications.length, 1)
  assert.equal(callbackCalls, 1)
  assert.ok(nativeCalls.every(args => args[0] !== 'tab' || args[1] !== 'close'))
  // Actual host factory installation, still inside this single written value callback.
  // Checkout intentionally fails before SQL; no PG or actual Browser is started.
  let checkouts = 0, hostReads = 0, oldHostReads = 0, oldPublicationCalls = 0
  const borrowed = { connect() {
    assert.equal(this, borrowed)
    checkouts++
    return Promise.reject(Object.assign(new Error('Synthetic host checkout'), { code: 'Z0002' }))
  } } as unknown as Pool
  const input = { ...fixtureConfig(borrowed), workspacePublicIds: ['synthetic-installed-workspace'],
    readHostIdentity() { assert.equal(this, input); hostReads++; return 'local' as const } }
  const baseHost = Object.freeze({
    resolveWorktreeSelector: async () => { oldHostReads++; throw new Error('Old Workspace resolver consulted') },
    resolveBrowserWorkspace: async () => { oldHostReads++; throw new Error('Old Browser resolver consulted') },
    withBrowserTabPublication: async () => { oldPublicationCalls++; throw new Error('Old publication hook consulted') },
    getAgentBrowserBridge() { assert.equal(this, baseHost); return null }
  }) as unknown as RuntimeBrowserCommandHost
  const commands = {} as RuntimeBrowserCommands
  let installed: RuntimeBrowserCommandHost | undefined
  const provider: OrcadBrowserProvider = { kind: 'chromium', isAvailable: () => true, stop: async () => {},
    factory(host) { assert.equal(this, provider); installed = host; return commands } }
  const factory = createOrcadCatalogBrowserFactory(provider, input)!
  assert.equal(factory(baseHost), commands)
  assert.ok(installed)
  assert.equal(installed.resolveWorktreeSelector, installed.resolveBrowserWorkspace)
  assert.equal(installed.getAgentBrowserBridge(), null)
  const withPublication = installed.withBrowserTabPublication!
  assert.equal(typeof withPublication, 'function')
  input.datasetName = 'changed-after-capture'
  input.hostId = 'ssh:changed-after-capture'
  input.workspacePublicIds[0] = 'changed-after-capture'
  input.readHostIdentity = () => { throw new Error('Replacement host reader consulted') }
  Object.defineProperty(borrowed, 'connect', { value() { throw new Error('Replacement connect consulted') } })
  await assert.rejects(installed.resolveWorktreeSelector('synthetic-installed-workspace'), /Z0002/)
  await assert.rejects(installed.resolveBrowserWorkspace('synthetic-installed-workspace'), /Z0002/)
  await assert.rejects(withPublication('synthetic-installed-workspace', 'synthetic-installed-page', () => {
    assert.fail('Failed checkout published')
  }), /Z0002/)
  assert.equal(checkouts, 3)
  assert.ok(hostReads >= 3)
  assert.equal(oldHostReads, 0)
  assert.equal(oldPublicationCalls, 0)
  assert.equal(Object.isFrozen(borrowed), false)
  assert.equal(createOrcadCatalogBrowserFactory(provider), provider.factory)
  assert.equal(createOrcadCatalogBrowserFactory(null, input), null)
})
