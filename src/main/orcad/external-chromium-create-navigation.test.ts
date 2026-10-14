import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type { BrowserSessionTabSelectionOptions } from '../runtime/browser-tab-create-publication'
import type { RuntimeBrowserCommandHost, RuntimeBrowserCommands } from '../runtime/orca-runtime-browser'
import { ExternalChromiumBrowserProcess } from './external-chromium-browser-process'
import { ExternalChromiumBrowserSession, type AgentBrowserTab } from './external-chromium-browser-session'
import { ExternalChromiumCdpConnection } from './external-chromium-cdp-connection'

// One value callback, with synthetic native values. No Chromium, RPC transport or PG is started.
test('external create captures caller navigation before enqueue and preserves selection boundaries', async t => {
  const nativeCalls: string[][] = []
  const nativeTabs: AgentBrowserTab[] = []
  const selections: {
    worktreeId: string | undefined
    pageId: string
    options: BrowserSessionTabSelectionOptions | undefined
  }[] = []
  const notifications: string[] = []
  let generation = 'fixture-generation'
  let selectedAgentPageId: string | undefined
  const generationDescriptor = Object.getOwnPropertyDescriptor(
    ExternalChromiumCdpConnection.prototype, 'generation'
  )!
  Object.defineProperty(ExternalChromiumCdpConnection.prototype, 'generation', {
    ...generationDescriptor, get: () => generation
  })
  t.after(() => Object.defineProperty(
    ExternalChromiumCdpConnection.prototype, 'generation', generationDescriptor
  ))
  t.mock.method(ExternalChromiumBrowserSession.prototype, 'start', async () => 'fixture-startup')
  t.mock.method(ExternalChromiumBrowserSession.prototype, 'connectCdp', async () => {})
  t.mock.method(ExternalChromiumBrowserSession.prototype, 'readTabs', async () => nativeTabs)
  t.mock.method(ExternalChromiumBrowserSession.prototype, 'selectPage', async (id: string) => {
    nativeCalls.push(['select', id])
    selectedAgentPageId = id
    for (const tab of nativeTabs) {tab.active = tab.tabId === id}
  })
  t.mock.method(ExternalChromiumBrowserSession.prototype, 'run', async (args: string[]) => {
    nativeCalls.push([...args])
    if (args[0] === 'tab' && args[1] === 'new') {
      const id = `fixture-agent-${nativeTabs.length}`
      nativeTabs.push({ tabId: id, url: args[2], title: '', active: false })
      return { tabId: id }
    }
    if (args[0] === 'open') {
      const tab = nativeTabs.find(tab => tab.tabId === selectedAgentPageId)
      assert.ok(tab)
      tab.url = args[1]
      return {}
    }
    assert.fail(`Unexpected synthetic native command: ${args[0]}`)
  })
  t.mock.method(ExternalChromiumCdpConnection.prototype, 'exactMarkerTarget', async (marker: string) => {
    const tab = nativeTabs.find(tab => tab.url === marker)
    assert.ok(tab)
    return `fixture-target-${tab.tabId}`
  })
  const targetChecks: [string, string][] = []
  t.mock.method(ExternalChromiumCdpConnection.prototype, 'hasTarget', async (id: string, epoch: string) => {
    targetChecks.push([id, epoch])
    return epoch === generation && nativeTabs.some(tab => id === `fixture-target-${tab.tabId}`)
  })

  let releaseQueue!: () => void
  let queueEntered!: () => void
  const queued = new Promise<void>(resolve => {queueEntered = resolve})
  const queueGate = new Promise<void>(resolve => {releaseQueue = resolve})
  let blockNextResolution = true
  let worktreeResolutions = 0
  const host = {
    resolveWorktreeSelector: async (selector: string) => {
      worktreeResolutions++
      if (blockNextResolution) {
        blockNextResolution = false
        queueEntered()
        await queueGate
      }
      return { id: selector }
    },
    markHeadlessBrowserSessionTabActive: (
      worktreeId: string | undefined, pageId: string, options?: BrowserSessionTabSelectionOptions
    ) => {selections.push({ worktreeId, pageId, options })},
    notifyHeadlessBrowserSessionTabsChanged: (worktreeId: string) => {notifications.push(worktreeId)}
  } as RuntimeBrowserCommandHost
  const process = new ExternalChromiumBrowserProcess(
    'unused-fixture', { executablePath: 'unused-fixture', provider: 'chromium' }, 'unused-fixture'
  )
  await process.start()
  const commands = process.createCommands(host)
  const blocker = commands.browserTabList({ worktree: 'owned-worktree' })
  await queued
  const params: Parameters<RuntimeBrowserCommands['browserTabCreate']>[0] = {
    page: 'captured-page', worktree: 'owned-worktree', url: 'https://example.test/captured',
    activate: true, targetGroupId: 'captured-group', placement: { kind: 'server' }
  }
  const caller: { pairedDeviceId: string; clientKind?: 'mobile' | 'runtime'; token: string } = {
    pairedDeviceId: 'captured-device', clientKind: 'mobile', token: 'synthetic-not-retained'
  }
  const pendingCreate = commands.browserTabCreate(params, caller)
  params.page = 'mutated-page'
  params.worktree = 'other-worktree'
  params.url = 'https://example.test/mutated'
  params.activate = false
  params.navigation = 'all'
  params.targetGroupId = 'mutated-group'
  Object.assign(params.placement!, { kind: 'client', browserHostClientId: 'mutated-host' })
  caller.pairedDeviceId = 'mutated-device'
  caller.clientKind = undefined
  assert.equal(nativeCalls.length, 0)
  releaseQueue()
  await blocker
  assert.deepEqual(await pendingCreate, { browserPageId: 'captured-page' })
  assert.deepEqual(selections, [{
    worktreeId: 'owned-worktree', pageId: 'captured-page',
    options: {
      targetGroupId: 'captured-group', focusesHost: false,
      caller: { clientNavigationId: 'captured-device', navigation: 'caller' }
    }
  }])
  assert.deepEqual(notifications, ['owned-worktree'])
  assert.equal(nativeTabs[0].url, 'https://example.test/captured')

  const cases: {
    name: string
    clientKind?: 'mobile' | 'runtime'
    navigation?: RuntimeNavigationTarget
    activate?: boolean
    expectedNavigation: RuntimeNavigationTarget
    focusesHost: boolean
  }[] = [
    { name: 'mobile-default', clientKind: 'mobile', activate: true, expectedNavigation: 'caller', focusesHost: false },
    { name: 'runtime-default', clientKind: 'runtime', activate: true, expectedNavigation: 'caller', focusesHost: false },
    { name: 'caller', clientKind: 'mobile', navigation: 'caller', activate: true, expectedNavigation: 'caller', focusesHost: false },
    { name: 'host', clientKind: 'mobile', navigation: 'host', activate: true, expectedNavigation: 'host', focusesHost: true },
    { name: 'clients', clientKind: 'mobile', navigation: 'clients', activate: true, expectedNavigation: 'clients', focusesHost: false },
    { name: 'all', clientKind: 'mobile', navigation: 'all', activate: true, expectedNavigation: 'all', focusesHost: true },
    { name: 'paired-false', clientKind: 'mobile', navigation: 'all', activate: false, expectedNavigation: 'all', focusesHost: false },
    { name: 'paired-omitted', clientKind: 'mobile', navigation: 'host', expectedNavigation: 'host', focusesHost: false },
    { name: 'local-true', activate: true, expectedNavigation: 'all', focusesHost: true },
    { name: 'local-false', activate: false, expectedNavigation: 'all', focusesHost: false },
    { name: 'local-omitted', expectedNavigation: 'all', focusesHost: false }
  ]
  for (const scenario of cases) {
    const page = `page-${scenario.name}`
    const url = `https://example.test/${scenario.name}`
    const request = {
      page, url, worktree: 'owned-worktree', activate: scenario.activate,
      navigation: scenario.navigation, targetGroupId: 'selected-group'
    }
    const origin = scenario.clientKind
      ? { pairedDeviceId: 'paired-device', clientKind: scenario.clientKind }
      : undefined
    for (const reuse of [false, true]) {
      const selectionCount = selections.length
      const nativeCount = nativeCalls.length
      const inventoryCount = notifications.length
      const checksBefore = targetChecks.length
      assert.deepEqual(await commands.browserTabCreate(
        { ...request, ...(reuse ? { url: 'https://example.test/must-not-replace' } : {}) }, origin
      ), { browserPageId: page })
      if (scenario.activate === true) {
        assert.deepEqual(selections.slice(selectionCount), [{
          worktreeId: 'owned-worktree', pageId: page,
          options: {
            targetGroupId: 'selected-group', focusesHost: scenario.focusesHost,
            ...(origin ? { caller: {
              clientNavigationId: 'paired-device', navigation: scenario.expectedNavigation
            } } : {})
          }
        }])
      } else {assert.equal(selections.length, selectionCount)}
      if (reuse) {
        assert.equal(nativeCalls.length, nativeCount)
        assert.ok(targetChecks.length > checksBefore)
        assert.equal(notifications.length, inventoryCount)
      } else {assert.equal(notifications.length, inventoryCount + 1)}
      assert.equal((await commands.browserTabShow({ page, worktree: 'owned-worktree' })).tab.url, url)
      // Internal command targeting follows the page even when UI activate is false or omitted.
      const current = await commands.browserTabCurrent({ worktree: 'owned-worktree' })
      assert.equal(current.tab.browserPageId, page)
    }
  }

  const sideEffects = () => [nativeCalls.length, nativeTabs.length, selections.length, notifications.length]
  const beforeUnsupported = sideEffects()
  const resolutionsBeforeUnsupported = worktreeResolutions
  await assert.rejects(commands.browserTabCreate({
    worktree: 'owned-worktree', page: 'client-page', activate: true,
    placement: { kind: 'client', browserHostClientId: 'unsupported-host' }
  }, { pairedDeviceId: 'paired-device', clientKind: 'mobile' }), { code: 'browser_command_unavailable' })
  assert.deepEqual(sideEffects(), beforeUnsupported)
  assert.equal(worktreeResolutions, resolutionsBeforeUnsupported)

  const beforeWrongWorktree = sideEffects()
  await assert.rejects(commands.browserTabCreate({
    worktree: 'other-worktree', page: 'captured-page', activate: true
  }), { code: 'browser_tab_not_found' })
  assert.deepEqual(sideEffects(), beforeWrongWorktree)

  generation = 'replacement-generation'
  const beforeStale = sideEffects()
  await assert.rejects(commands.browserTabCreate({
    worktree: 'owned-worktree', page: 'captured-page', activate: true
  }, { pairedDeviceId: 'paired-device', clientKind: 'mobile' }), { code: 'browser_tab_closed' })
  assert.deepEqual(sideEffects(), beforeStale)
})
