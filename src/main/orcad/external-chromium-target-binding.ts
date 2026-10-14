import { BrowserError } from '../browser/browser-error'
import type { ExternalChromiumBrowserSession } from './external-chromium-browser-session'
import type { ExternalChromiumPageRecord } from './external-chromium-tab-projection'

export class ExternalChromiumTargetBinding {
  constructor(
    private readonly session: ExternalChromiumBrowserSession,
    private readonly isCurrent: (page: ExternalChromiumPageRecord) => boolean,
    private readonly retire: (page: ExternalChromiumPageRecord) => void
  ) {}
  async assertCurrent(page: ExternalChromiumPageRecord): Promise<void> {
    await this.session.connectCdp()
    if (!this.isCurrent(page) || !await this.session.cdp.hasTarget(page.targetId, page.browserGeneration)) {
      this.retire(page)
      throw new BrowserError('browser_tab_closed', 'The owned browser target is unavailable.')
    }
  }
  async select(page: ExternalChromiumPageRecord): Promise<void> {
    await this.assertCurrent(page)
    await this.session.selectPage(page.agentPageId)
    await this.assertCurrent(page)
  }
  async retireIfMissing(page: ExternalChromiumPageRecord): Promise<void> {
    // A transport failure is unverifiable; only an actual identity mismatch retires a binding.
    try {
      if (!this.isCurrent(page) || !await this.session.cdp.hasTarget(page.targetId, page.browserGeneration)) {
        this.retire(page)
      }
    } catch { /* No reconnect or target inference after a failed start. */ }
  }
}
