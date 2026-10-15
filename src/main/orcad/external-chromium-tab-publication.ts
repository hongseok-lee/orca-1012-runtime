import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import type { BrowserSessionTabSelectionOptions } from '../runtime/browser-tab-create-publication'
import type { ExternalChromiumBrowserSession } from './external-chromium-browser-session'
import type { ExternalChromiumPageRecord } from './external-chromium-tab-projection'
import { BrowserError } from '../browser/browser-error'
import { externalCdpError } from './external-chromium-cdp-connection'

/** Called before createTab's first await; captures the private hook and owner. */
export function captureExternalChromiumTabPublication(
  host: RuntimeBrowserCommandHost, session: ExternalChromiumBrowserSession,
  publicPages: Map<string, ExternalChromiumPageRecord>, agentPages: Map<string, ExternalChromiumPageRecord>,
  activePages: Map<string, string>
) {
  const withPublication = host.withBrowserTabPublication?.bind(host)
  return async (page: ExternalChromiumPageRecord, existing: ExternalChromiumPageRecord | undefined,
    selection?: BrowserSessionTabSelectionOptions): Promise<void> => {
    let active = true, published = false
    // This exact callback has no await, promise, native command or deferred work.
    const publish = (): void => {
      if (!active || published) { throw new BrowserError('browser_error', 'Publication callback is no longer available.') }
      if (session.cdp.generation !== page.browserGeneration ||
          publicPages.get(page.publicPageId) !== existing || agentPages.get(page.agentPageId) !== existing) {
        throw externalCdpError()
      }
      published = true
      if (!existing) {
        publicPages.set(page.publicPageId, page)
        agentPages.set(page.agentPageId, page)
      }
      activePages.set(page.worktreeId ?? '', page.publicPageId)
      if (selection) { host.markHeadlessBrowserSessionTabActive?.(page.worktreeId, page.publicPageId, selection) }
      if (!existing && page.worktreeId) { host.notifyHeadlessBrowserSessionTabsChanged?.(page.worktreeId) }
    }
    try {
      if (withPublication) {
        if (!page.worktreeId) { throw new BrowserError('invalid_argument', 'PG Browser publication requires a Workspace.') }
        await withPublication(page.worktreeId, page.publicPageId, publish)
      } else { publish() }
      if (!published) { throw new BrowserError('browser_error', 'Browser publication was not confirmed.') }
    } finally { active = false }
  }
}
