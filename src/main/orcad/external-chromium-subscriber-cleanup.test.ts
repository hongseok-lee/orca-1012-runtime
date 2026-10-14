import { describe, expect, it, vi } from 'vitest'
import type { ExternalChromiumPageRecord } from './external-chromium-tab-projection'
import { ExternalChromiumCdpConnection } from './external-chromium-cdp-connection'

const controlled = vi.hoisted(() => ({
  streams: [] as { stops: number; reject: ((error: Error) => void) | null }[],
  boundary: null as 'budget' | 'viewport' | null
}))
vi.mock('./external-chromium-target-screencast', () => ({
  ExternalChromiumTargetScreencast: class {
    readonly done: Promise<void>
    private resolveDone!: () => void
    private stopped = false
    private readonly state = { stops: 0, reject: null as ((error: Error) => void) | null }
    constructor() {
      controlled.streams.push(this.state)
      this.done = new Promise(resolve => { this.resolveDone = resolve })
    }
    get isStopped() { return this.stopped }
    start() { return Promise.resolve() }
    stop() { this.state.stops++; this.stopped = true; this.resolveDone() }
    updateViewport() { return this.update('viewport') }
    updateFrameBudget() { return this.update('budget') }
    private update(kind: string): Promise<void> {
      if (controlled.boundary !== kind || controlled.streams[0] !== this.state) return Promise.resolve()
      controlled.boundary = null
      return new Promise((_resolve, reject) => { this.state.reject = reject })
    }
  }
}))
import { ExternalChromiumScreencastSubscribers } from './external-chromium-screencast-subscribers'

const page: ExternalChromiumPageRecord = { publicPageId: 'owned', agentPageId: 't1',
  targetId: 'controlled-target', browserGeneration: 'controlled-generation' }
const tab = { browserPageId: 'owned', index: 0, url: 'about:blank', title: 'Controlled', active: true }

// Controlled rejection proves record ownership only; it is not native/decoder success evidence.
describe('external subscriber captured cleanup', () => {
  for (const boundary of ['budget', 'viewport'] as const) {
    it(`does not stop a replacement record after an old ${boundary} rejection`, async () => {
      controlled.streams = []
      controlled.boundary = null
      const subscribers = new ExternalChromiumScreencastSubscribers(new ExternalChromiumCdpConnection())
      const first = await subscribers.start(page, { format: 'jpeg', quality: 20,
        ...(boundary === 'viewport' ? { viewportWidth: 640, viewportHeight: 480 } : {}) },
      { sendBinary: () => true }, tab)
      const second = await subscribers.start(page, { format: 'jpeg', quality: boundary === 'budget' ? 90 : 20,
        ...(boundary === 'viewport' ? { viewportWidth: 800, viewportHeight: 600 } : {}) },
      { sendBinary: () => true }, tab)
      controlled.boundary = boundary
      const leaving = boundary === 'budget' ? first : second
      const remaining = boundary === 'budget' ? second : first
      leaving.session.stop()
      expect(controlled.streams[0].reject).not.toBeNull()
      remaining.session.stop()
      await remaining.session.done
      const replacement = await subscribers.start(page, { format: 'jpeg', quality: 50 },
        { sendBinary: () => true }, tab)
      try {
        controlled.streams[0].reject?.(new Error('Controlled old update failure'))
        await vi.waitFor(() => expect(controlled.streams[0].stops).toBe(2))
        expect(controlled.streams[1].stops).toBe(0)
      } finally {
        replacement.session.stop()
        await replacement.session.done
      }
    })
  }
})
