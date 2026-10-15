import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { BrowserTabInfo } from '../../shared/runtime-types'
import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import type { BrowserTabCreateParams } from '../../shared/rpc-contract/browser-tab-create-params'
import type { BrowserSessionTabSelectionOptions } from '../runtime/browser-tab-create-publication'
import { BrowserError } from '../browser/browser-error'
import { externalCdpError } from './external-chromium-cdp-connection'
import { ExternalChromiumTargetBinding } from './external-chromium-target-binding'
import { ExternalChromiumOpsAuthOwners } from './external-chromium-ops-auth-owner'
import { captureBrowserTabCreateCaller, browserOpsAuthUnavailable, type BrowserOpsAuthCapability } from '../runtime/browser-ops-auth-capability'
import { captureExternalChromiumTabPublication } from './external-chromium-tab-publication'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import type { ExternalChromiumBrowserSession } from './external-chromium-browser-session'
import { externalChromiumTabInfo, type ExternalChromiumPageRecord } from './external-chromium-tab-projection'
const AgentBrowserCreatedTab = z.object({ tabId: z.string().min(1) })

export class ExternalChromiumTabRegistry {
  private readonly pagesByPublicId = new Map<string, ExternalChromiumPageRecord>()
  private readonly pagesByAgentId = new Map<string, ExternalChromiumPageRecord>()
  private readonly activePageIdByWorktree = new Map<string, string>()
  private readonly targets: ExternalChromiumTargetBinding
  private initialAgentPageId: string | null = null
  private readonly opsAuth: ExternalChromiumOpsAuthOwners
  private epoch = 0

  constructor( private readonly session: ExternalChromiumBrowserSession, private readonly stopPage: (pageId: string) => Promise<void> ) {
    this.opsAuth = new ExternalChromiumOpsAuthOwners(session.cdp)
    this.targets = new ExternalChromiumTargetBinding(session,
      page => this.pagesByPublicId.get(page.publicPageId) === page,
      page => this.deletePage(page))
    session.cdp.onGenerationChanged(() => this.clear())
    session.cdp.onFailure(() => { void this.opsAuth.clear() })
    session.cdp.onEvent((event) => {
      if (event.method !== 'Target.targetDestroyed') {return}
      this.opsAuth.disposeTarget(event.params?.targetId)
      for (const page of this.pagesByPublicId.values()) {
        if (page.targetId === event.params?.targetId) {this.deletePage(page)}
      }
    })
  }

  initialize(agentPageId: string): void {
    this.initialAgentPageId = this.session.freshStartupPageId === agentPageId ? agentPageId : null
  }

  clear(): void {
    this.epoch++
    void this.opsAuth.clear()
    for (const page of this.pagesByPublicId.values()) {void this.stopPage(page.publicPageId)}
    this.pagesByPublicId.clear()
    this.pagesByAgentId.clear()
    this.activePageIdByWorktree.clear()
    this.initialAgentPageId = null
  }
  stopOpsAuth(): Promise<void> { this.epoch++; return this.opsAuth.stop() }

  async createTab(
    host: RuntimeBrowserCommandHost,
    params: z.infer<typeof BrowserTabCreateParams>,
    selection?: BrowserSessionTabSelectionOptions,
    inputAuth?: BrowserOpsAuthCapability
  ): Promise<unknown> {
    const opsAuth = captureBrowserTabCreateCaller(inputAuth ? { opsAuth: inputAuth } : undefined).opsAuth
    const epoch = this.epoch
    const assertAuthEpoch = () => { if (opsAuth && epoch !== this.epoch) { throw browserOpsAuthUnavailable() } }
    const publish = captureExternalChromiumTabPublication(host, this.session,
      this.pagesByPublicId, this.pagesByAgentId, this.activePageIdByWorktree)
    if (params.placement?.kind === 'client') {
      throw new BrowserError(
        'browser_command_unavailable',
        'Client-hosted browser placement is not supported by the external Chromium provider.'
      )
    }
    if (typeof params.profileId === 'string' && params.profileId !== 'default') {
      throw new BrowserError(
        'browser_profile_unavailable',
        'Only the default browser profile is available.'
      )
    }
    const worktreeId = await this.resolveWorktreeId(host, params.worktree)
    assertAuthEpoch()
    const requestedPageId =
      typeof params.page === 'string' && params.page.length > 0 ? params.page : undefined
    const existing = requestedPageId ? this.pagesByPublicId.get(requestedPageId) : undefined
    if (existing) {
      if (worktreeId && existing.worktreeId !== worktreeId) {
        throw new BrowserError(
          'browser_tab_not_found',
          `Browser page ${requestedPageId} was not found in this worktree.`
        )
      }
      await this.targets.assertCurrent(existing)
      assertAuthEpoch()
      const acquired = await this.opsAuth.ensure(existing, opsAuth)
      try {
        if (opsAuth) { this.opsAuth.assertCurrent(existing) }
        await publish(existing, existing, selection)
      } catch (error) {
        if (acquired) { await this.opsAuth.disposePage(existing) }
        throw error
      }
      return { browserPageId: existing.publicPageId }
    }
    const url = normalizeBrowserNavigationUrl(String(params.url ?? 'about:blank'))
    if (!url) {
      throw new BrowserError(
        'invalid_argument',
        `Unsupported browser URL: ${String(params.url ?? '')}`
      )
    }
    const marker = `about:blank#orca-target-${randomUUID()}`
    let agentPageId: string | null = null
    const publicPageId = requestedPageId ?? randomUUID()
    let page: ExternalChromiumPageRecord | undefined
    let acquired = false
    try {
      if (this.initialAgentPageId) {
        agentPageId = this.initialAgentPageId
        this.initialAgentPageId = null
        await this.session.selectPage(agentPageId)
        await this.session.run(['open', marker])
      } else {
        agentPageId = AgentBrowserCreatedTab.parse(await this.session.run(['tab', 'new', marker])).tabId
      }
      const nativeMarkers = (await this.session.readTabs()).filter(tab => tab.url === marker)
      if (nativeMarkers.length !== 1 || nativeMarkers[0].tabId !== agentPageId) {throw externalCdpError()}
      await this.session.connectCdp()
      const targetId = await this.session.cdp.exactMarkerTarget(marker)
      page = { agentPageId, publicPageId, worktreeId, targetId,
        browserGeneration: this.session.cdp.generation }
      assertAuthEpoch()
      acquired = await this.opsAuth.ensure(page, opsAuth)
      await this.session.selectPage(agentPageId)
      if (opsAuth) { this.opsAuth.assertCurrent(page) }
      await this.session.run(['open', url])
      assertAuthEpoch()
      if (opsAuth) { this.opsAuth.assertCurrent(page) }
      if (!await this.session.cdp.hasTarget(targetId, page.browserGeneration)) {throw externalCdpError()}
    } catch (error) {
      if (page && acquired) { await this.opsAuth.disposePage(page) }
      if (!agentPageId) {
        const owned = await this.session.readTabs().then(tabs => tabs.filter(tab => tab.url === marker)).catch(() => [])
        if (owned.length === 1) {agentPageId = owned[0].tabId}
      }
      // Auth failures revoke their exact owner; no generation-blind physical cleanup is added.
      if (agentPageId && !opsAuth) {await this.session.run(['tab', 'close', agentPageId]).catch(() => {})}
      throw error
    }
    // PG rejection leaves the native page unregistered. No generation-blind close.
    if (!page) { throw externalCdpError() }
    try {
      assertAuthEpoch()
      if (opsAuth) { this.opsAuth.assertCurrent(page) }
      await publish(page, undefined, selection)
    } catch (error) {
      if (acquired) { await this.opsAuth.disposePage(page) }
      throw error
    }
    return { browserPageId: publicPageId }
  }

  async listTabs( host: RuntimeBrowserCommandHost, params: Record<string, unknown> ): Promise<unknown> {
    const requestedWorktreeId = await this.resolveWorktreeId(host, params.worktree)
    await this.session.connectCdp()
    const tabs = await this.session.readTabs()
    const liveAgentPageIds = new Set(tabs.map((tab) => tab.tabId))
    for (const page of this.pagesByPublicId.values()) {
      if (!liveAgentPageIds.has(page.agentPageId)) {
        this.deletePage(page)
      }
    }
    const visibleTabs = tabs.flatMap((tab) => {
      const page = this.pagesByAgentId.get(tab.tabId)
      if (!page || (requestedWorktreeId && page.worktreeId !== requestedWorktreeId)) {
        return []
      }
      if (tab.active) {
        this.setActivePage(page)
      }
      return [{ page, tab }]
    })
    return {
      tabs: visibleTabs.map(({ page, tab }, index) => externalChromiumTabInfo(page, tab, index))
    }
  }

  async describeTab( host: RuntimeBrowserCommandHost, params: Record<string, unknown> ): Promise<Record<string, unknown>> {
    return this.describePage(await this.resolveTargetPage(host, params))
  }

  async currentTab( host: RuntimeBrowserCommandHost, params: Record<string, unknown> ): Promise<unknown> {
    const worktreeId = await this.resolveWorktreeId(host, params.worktree)
    const page = this.findActivePage(worktreeId)
    if (!page) {
      throw new BrowserError('browser_no_tab', 'No browser tab is active in this worktree.')
    }
    return this.describePage(page)
  }

  async switchTab( host: RuntimeBrowserCommandHost, params: Record<string, unknown> ): Promise<unknown> {
    const worktreeId = await this.resolveWorktreeId(host, params.worktree)
    const pages = [...this.pagesByPublicId.values()].filter(
      (page) => !worktreeId || page.worktreeId === worktreeId
    )
    const page =
      typeof params.page === 'string'
        ? this.pagesByPublicId.get(params.page)
        : typeof params.index === 'number'
          ? pages[params.index]
          : undefined
    if (!page || (worktreeId && page.worktreeId !== worktreeId)) {
      throw new BrowserError('browser_tab_not_found', 'Browser tab was not found in this worktree.')
    }
    await this.targets.select(page)
    this.setActivePage(page)
    return { switched: pages.indexOf(page), browserPageId: page.publicPageId }
  }

  async closeTab( host: RuntimeBrowserCommandHost, params: Record<string, unknown> ): Promise<unknown> {
    const worktreeId = await this.resolveWorktreeId(host, params.worktree)
    const pages = [...this.pagesByPublicId.values()].filter(
      (page) => !worktreeId || page.worktreeId === worktreeId
    )
    const page =
      typeof params.page === 'string'
        ? this.pagesByPublicId.get(params.page)
        : typeof params.index === 'number'
          ? pages[params.index]
          : this.findActivePage(worktreeId)
    if (!page || (worktreeId && page.worktreeId !== worktreeId)) {
      if (typeof params.page === 'string') {
        throw new BrowserError(
          'browser_tab_not_found',
          'Browser tab was not found in this worktree.'
        )
      }
      return { closed: false }
    }
    await this.targets.assertCurrent(page)
    await this.opsAuth.disposePage(page)
    await this.stopPage(page.publicPageId)
    await this.targets.assertCurrent(page)
    await this.session.run(['tab', 'close', page.agentPageId])
    this.deletePage(page)
    if (page.worktreeId) {
      host.notifyHeadlessBrowserSessionTabsChanged?.(page.worktreeId)
    }
    return { closed: true }
  }

  async resolveTargetPage( host: RuntimeBrowserCommandHost, params: Record<string, unknown>, select = false ): Promise<ExternalChromiumPageRecord> {
    const worktreeId = await this.resolveWorktreeId(host, params.worktree)
    const page =
      typeof params.page === 'string'
        ? this.pagesByPublicId.get(params.page)
        : this.findActivePage(worktreeId)
    if (!page || (worktreeId && page.worktreeId !== worktreeId)) {
      throw new BrowserError('browser_no_tab', 'No browser tab is active in this worktree.')
    }
    await (select ? this.targets.select(page) : this.targets.assertCurrent(page))
    return page
  }

  async retireMissingTarget(page: ExternalChromiumPageRecord): Promise<void> {
    await this.targets.retireIfMissing(page)
  }

  async describePage(page: ExternalChromiumPageRecord): Promise<BrowserTabInfo> {
    await this.targets.assertCurrent(page)
    const tabs = await this.session.readTabs()
    const scopedTabs = tabs.filter(
      (tab) => this.pagesByAgentId.get(tab.tabId)?.worktreeId === page.worktreeId
    )
    const index = scopedTabs.findIndex((tab) => tab.tabId === page.agentPageId)
    if (index === -1) {
      this.deletePage(page)
      throw new BrowserError('browser_tab_closed', 'Browser tab is no longer available.')
    }
    return externalChromiumTabInfo(page, scopedTabs[index], index)
  }

  private findActivePage(worktreeId?: string): ExternalChromiumPageRecord | undefined {
    const key = worktreeId ?? ''
    const activePageId = this.activePageIdByWorktree.get(key)
    const active = activePageId ? this.pagesByPublicId.get(activePageId) : undefined
    if (active) {
      return active
    }
    return [...this.pagesByPublicId.values()].find(
      (page) => !worktreeId || page.worktreeId === worktreeId
    )
  }

  private setActivePage(page: ExternalChromiumPageRecord): void {
    this.activePageIdByWorktree.set(page.worktreeId ?? '', page.publicPageId)
  }

  private deletePage(page: ExternalChromiumPageRecord): void {
    if (this.pagesByPublicId.get(page.publicPageId) !== page) {return}
    void this.opsAuth.disposePage(page)
    void this.stopPage(page.publicPageId)
    this.pagesByPublicId.delete(page.publicPageId)
    this.pagesByAgentId.delete(page.agentPageId)
    const key = page.worktreeId ?? ''
    if (this.activePageIdByWorktree.get(key) === page.publicPageId) {
      this.activePageIdByWorktree.delete(key)
    }
  }

  private async resolveWorktreeId( host: RuntimeBrowserCommandHost, worktree: unknown ): Promise<string | undefined> {
    return typeof worktree === 'string' && worktree
      ? (await host.resolveWorktreeSelector(worktree)).id
      : undefined
  }
}
