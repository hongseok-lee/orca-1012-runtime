import { describe, expect, it, vi } from 'vitest'
import { ExternalChromiumBrowserSession } from './external-chromium-browser-session'
import { ExternalChromiumTargetBinding } from './external-chromium-target-binding'
import type { ExternalChromiumPageRecord } from './external-chromium-tab-projection'

const page: ExternalChromiumPageRecord = { publicPageId: 'owned-page', agentPageId: 't1',
  targetId: 'actual-target', browserGeneration: 'old-generation', worktreeId: 'owned-worktree' }

describe('external target command boundary', () => {
  for (const boundary of ['mapping-replaced', 'target-absent'] as const) {
    it(`retires ${boundary} before issuing any native tab selection`, async () => {
      const session = new ExternalChromiumBrowserSession('unused', { executablePath: 'unused', provider: 'chromium' }, 'unused')
      vi.spyOn(session, 'connectCdp').mockResolvedValue()
      const target = vi.spyOn(session.cdp, 'hasTarget').mockResolvedValue(false)
      const select = vi.spyOn(session, 'selectPage').mockResolvedValue()
      const retire = vi.fn()
      const binding = new ExternalChromiumTargetBinding(session, () => boundary !== 'mapping-replaced', retire)
      await expect(binding.select(page)).rejects.toMatchObject({ code: 'browser_tab_closed' })
      expect(select).not.toHaveBeenCalled()
      expect(retire).toHaveBeenCalledWith(page)
      if (boundary === 'target-absent') expect(target).toHaveBeenCalledWith(page.targetId, page.browserGeneration)
    })
  }
  it('does not reconnect or infer target loss from unverifiable transport after a failed start', async () => {
    const session = new ExternalChromiumBrowserSession('unused', { executablePath: 'unused', provider: 'chromium' }, 'unused')
    const connect = vi.spyOn(session, 'connectCdp').mockResolvedValue()
    vi.spyOn(session.cdp, 'hasTarget').mockRejectedValue(new Error('Controlled unavailable transport'))
    const retire = vi.fn()
    await new ExternalChromiumTargetBinding(session, () => true, retire).retireIfMissing(page)
    expect(connect).not.toHaveBeenCalled()
    expect(retire).not.toHaveBeenCalled()
  })
})
