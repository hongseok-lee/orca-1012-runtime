import { randomUUID } from 'node:crypto'
import type { BrowserScreencastResult } from '../../shared/runtime-types'
import type {
  BrowserScreencastParams, BrowserScreencastStartResult, ActiveBrowserScreencastSubscriber
} from '../runtime/runtime-browser-commands-browser-command-target-params'
import {
  normalizeScreencastViewport, normalizeScreencastFrameBudget, hasScreencastViewportSize
} from '../runtime/runtime-browser-commands-browser-command-target-params'
import {
  mergeBrowserScreencastFrameBudgets, browserScreencastFrameBudgetsEqual
} from '../browser/browser-screencast-frame-budget'
import {
  INITIAL_SCREENCAST_SUBSCRIBER_DELIVERY, recordScreencastSubscriberSend, screencastSubscriberIsGhost
} from '../runtime/browser-screencast-ghost-subscriber-eviction'
import { sendRemoteBrowserScreencastFrame } from '../runtime/remote-browser-screencast-frame-admission'
import type { BrowserScreencastFrameBudget, BrowserScreencastViewport } from '../browser/browser-screencast-stream-types'
import type { ExternalChromiumPageRecord } from './external-chromium-tab-projection'
import { ExternalChromiumTargetScreencast } from './external-chromium-target-screencast'
import { ExternalChromiumCdpConnection, externalCdpError } from './external-chromium-cdp-connection'

type Viewer = {
  sendBinary: ActiveBrowserScreencastSubscriber['sendBinary']
  emit?: (event: BrowserScreencastResult) => void
  pairedDeviceId?: string
}
type PageStream = {
  stream: ExternalChromiumTargetScreencast
  started: Promise<void>
  subscribers: Map<string, ActiveBrowserScreencastSubscriber>
  owner: string | null
  budget: BrowserScreencastFrameBudget
  latest: Uint8Array<ArrayBufferLike> | null
  format: 'jpeg' | 'png'
  stopping: boolean
}
export class ExternalChromiumScreencastSubscribers {
  private readonly pages = new Map<string, PageStream>()
  constructor(private readonly connection: ExternalChromiumCdpConnection) {}

  async start(
    page: ExternalChromiumPageRecord, params: BrowserScreencastParams,
    viewer: Viewer, tab: BrowserScreencastStartResult['ready']['tab']
  ): Promise<BrowserScreencastStartResult> {
    let active = this.pages.get(page.publicPageId)
    if (active?.stopping || active?.stream.isStopped) {
      await active.stream.done
      active = this.pages.get(page.publicPageId)
    }
    const budget = normalizeScreencastFrameBudget(params)
    const viewport = normalizeScreencastViewport(params)
    const subscriptionId = `browser-screencast:${page.publicPageId}:${randomUUID()}`
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const created = !active
    if (!active) {
      const subscribers = new Map<string, ActiveBrowserScreencastSubscriber>()
      const stream = new ExternalChromiumTargetScreencast(this.connection, page, {
        format: params.format, ...budget, ...viewport,
        onFrame: (bytes) => {
          record.latest = bytes
          const ghosts: string[] = []
          for (const [id, subscriber] of subscribers) {
            this.send(subscriber, bytes)
            if (screencastSubscriberIsGhost(subscriber.delivery)) ghosts.push(id)
          }
          for (const id of ghosts) this.leave(record, id)
          return true
        },
        onEvent: (event) => {
          for (const subscriber of subscribers.values()) this.emit(subscriber, event)
        },
        onError: (message) => {
          for (const subscriber of subscribers.values()) this.emit(subscriber, { type: 'error', message })
        }
      })
      const record: PageStream = { stream, started: Promise.resolve(), subscribers, owner: null,
        budget, latest: null, format: params.format, stopping: false }
      active = record
      this.pages.set(page.publicPageId, record)
      // Listeners and the first subscriber are installed before Page.startScreencast can emit.
      void stream.done.then(() => {
        if (this.pages.get(page.publicPageId) === record) this.pages.delete(page.publicPageId)
        record.stopping = true
        record.latest = null
        for (const subscriber of subscribers.values()) subscriber.resolveDone()
        subscribers.clear()
      })
    }
    const record = active
    record.subscribers.set(subscriptionId, { ...viewer, done, resolveDone, viewport, budget,
      pendingFrame: record.latest, delivery: INITIAL_SCREENCAST_SUBSCRIBER_DELIVERY })
    if (hasScreencastViewportSize(viewport)) record.owner = subscriptionId
    if (created) record.started = record.stream.start()
    try {
      await record.started
      if (record.stopping || record.stream.isStopped || !record.subscribers.has(subscriptionId)) throw externalCdpError()
      if (viewer.pairedDeviceId !== undefined) {
        for (const [id, subscriber] of record.subscribers) {
          if (id !== subscriptionId && subscriber.pairedDeviceId === viewer.pairedDeviceId) {
            this.leave(record, id)
          }
        }
      }
      if (!created) {
        if (record.owner === subscriptionId) await record.stream.updateViewport(viewport)
        await this.applyBudget(record)
      }
    } catch {
      this.leave(record, subscriptionId)
      throw externalCdpError()
    }
    return {
      subscriptionId,
      ready: { type: 'ready', subscriptionId, browserPageId: page.publicPageId, format: record.format, tab },
      flushPendingFrame: () => {
        const subscriber = record.subscribers.get(subscriptionId)
        if (record.stopping || !subscriber?.pendingFrame) return
        this.send(subscriber, subscriber.pendingFrame)
        if (screencastSubscriberIsGhost(subscriber.delivery)) this.leave(record, subscriptionId)
      },
      session: { done, stop: () => this.leave(record, subscriptionId),
        updateViewport: (value) => this.updateViewport(record, subscriptionId, value) }
    }
  }
  private emit(subscriber: ActiveBrowserScreencastSubscriber, event: BrowserScreencastResult): void {
    try { subscriber.emit?.(event) } catch { /* A viewer must not interrupt another viewer. */ }
  }
  private send(subscriber: ActiveBrowserScreencastSubscriber, bytes: Uint8Array<ArrayBufferLike>): void {
    let delivered = false
    try { delivered = sendRemoteBrowserScreencastFrame(subscriber.sendBinary, bytes) } catch { /* Refused. */ }
    subscriber.pendingFrame = delivered ? null : bytes
    subscriber.delivery = recordScreencastSubscriberSend(subscriber.delivery, delivered)
  }
  private async applyBudget(record: PageStream): Promise<void> {
    const budget = mergeBrowserScreencastFrameBudgets([...record.subscribers.values()].map(s => s.budget))
    if (!budget || record.stopping || browserScreencastFrameBudgetsEqual(budget, record.budget)) return
    record.budget = budget
    record.latest = null
    for (const subscriber of record.subscribers.values()) subscriber.pendingFrame = null
    await record.stream.updateFrameBudget(budget)
  }
  private async updateViewport(record: PageStream, id: string, value: BrowserScreencastViewport): Promise<void> {
    const subscriber = record.subscribers.get(id)
    if (record.stopping || !subscriber) return
    const viewport = normalizeScreencastViewport({ format: record.format, ...value })
    subscriber.viewport = viewport
    if (hasScreencastViewportSize(viewport)) record.owner = id
    if (record.owner !== id) return
    record.latest = null
    for (const viewer of record.subscribers.values()) viewer.pendingFrame = null
    await record.stream.updateViewport(viewport)
  }
  private leave(record: PageStream, id: string): void {
    const subscriber = record.subscribers.get(id)
    if (!subscriber) return
    record.subscribers.delete(id)
    subscriber.pendingFrame = null
    if (!record.subscribers.size) {
      record.stopping = true
      record.stream.stop()
      void record.stream.done.then(subscriber.resolveDone)
      return
    }
    subscriber.resolveDone()
    if (record.owner === id) {
      const owners = [...record.subscribers].filter(([, s]) => hasScreencastViewportSize(s.viewport))
      const next = owners.at(-1)
      record.owner = next?.[0] ?? null
      if (next) {
        record.latest = null
        for (const viewer of record.subscribers.values()) viewer.pendingFrame = null
        void record.stream.updateViewport(next[1].viewport).catch(() => this.stopRecord(record))
      }
    }
    void this.applyBudget(record).catch(() => this.stopRecord(record))
  }
  private async stopRecord(record: PageStream): Promise<void> {
    record.stopping = true
    record.stream.stop()
    await record.stream.done
  }
  async stopPage(pageId: string): Promise<void> {
    const record = this.pages.get(pageId)
    if (record) await this.stopRecord(record)
  }
  async stopAll(): Promise<void> {
    await Promise.all([...this.pages.keys()].map(id => this.stopPage(id)))
  }
}
