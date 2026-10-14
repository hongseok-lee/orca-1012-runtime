import { z } from 'zod'
import {
  BrowserScreencastOpcode, encodeBrowserScreencastFrame
} from '../../shared/browser-screencast-protocol'
import { enrichFrameMetadata, readFrameMetadata } from '../browser/browser-screencast-frame-metadata'
import { readBrowserScreencastImageSize } from '../browser/browser-screencast-image-size'
import { isLiveFrameCompatibleWithViewport } from '../browser/browser-screencast-viewport-fit'
import type {
  BrowserScreencastFrameBudget, BrowserScreencastOptions, BrowserScreencastViewport
} from '../browser/browser-screencast-stream-types'
import type { ExternalChromiumPageRecord } from './external-chromium-tab-projection'
import { ExternalChromiumCdpConnection, externalCdpError } from './external-chromium-cdp-connection'

const Frame = z.object({ data: z.string(), sessionId: z.number().int(), metadata: z.unknown() })

export class ExternalChromiumTargetScreencast {
  readonly done: Promise<void>
  private resolveDone!: () => void
  private sessionId: string | null = null
  private readonly transportIdentity: number
  private closed = false
  private started = false
  private metricsAttempted = false
  private cleanup: Promise<void> | null = null
  private opening: Promise<void> | null = null
  private seq = 0
  private lastSentAt = 0
  private pending: { image: Uint8Array; metadata: ReturnType<typeof readFrameMetadata> } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly removeEvent: () => void
  private readonly removeFailure: () => void
  private updates: Promise<void> = Promise.resolve()

  constructor(
    private readonly connection: ExternalChromiumCdpConnection,
    private readonly page: ExternalChromiumPageRecord,
    private readonly options: BrowserScreencastOptions
  ) {
    this.transportIdentity = connection.transportIdentity
    this.done = new Promise((resolve) => { this.resolveDone = resolve })
    this.removeFailure = connection.onFailure(() => this.fail())
    this.removeEvent = connection.onEvent((event) => {
      if (event.method === 'Target.targetDestroyed' && event.params?.targetId === page.targetId) {
        this.fail()
        return
      }
      if (event.method === 'Target.detachedFromTarget' && event.params?.sessionId === this.sessionId) {
        this.fail()
        return
      }
      if (this.closed || !this.sessionId || event.sessionId !== this.sessionId) return
      if (event.method === 'Page.screencastFrame') this.receive(event.params)
      if (event.method === 'Page.javascriptDialogOpening') {
        options.onEvent?.({ type: 'dialog', dialogType: String(event.params?.type ?? 'alert'),
          message: typeof event.params?.message === 'string' ? event.params.message : 'Browser dialog' })
      }
      if (event.method === 'Page.javascriptDialogClosed') options.onEvent?.({ type: 'dialogClosed' })
    })
  }
  get isStopped(): boolean { return this.closed }
  start(): Promise<void> {
    this.opening = this.open()
    return this.opening
  }
  private async open(): Promise<void> {
    try {
      this.assertOpen()
      this.sessionId = await this.connection.attach(this.page.targetId, this.page.browserGeneration, () => this.assertOpen())
      this.assertOpen()
      await this.command('Page.enable')
      await this.applyViewport()
      this.started = true
      await this.command('Page.startScreencast', this.captureParams())
      this.assertOpen()
    } catch {
      this.fail()
      throw externalCdpError()
    }
  }
  private assertOpen(): void {
    if (this.closed || !this.connection.ownsTransport(this.transportIdentity, this.page.browserGeneration)) throw externalCdpError()
  }
  private command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.assertOpen()
    if (!this.sessionId) return Promise.reject(externalCdpError())
    return this.connection.command(method, params, this.sessionId, this.transportIdentity)
  }
  private captureParams(): Record<string, unknown> {
    const { format, quality, maxWidth, maxHeight, everyNthFrame } = this.options
    return { format, quality, maxWidth, maxHeight, everyNthFrame }
  }
  private async applyViewport(): Promise<void> {
    const { viewportWidth: width, viewportHeight: height, deviceScaleFactor, mobile } = this.options
    if (width === undefined || height === undefined) {
      if (this.metricsAttempted) await this.command('Emulation.clearDeviceMetricsOverride')
      this.metricsAttempted = false
      return
    }
    // Chromium may apply metrics before its response is cancelled.
    this.metricsAttempted = true
    await this.command('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: deviceScaleFactor ?? 1, mobile: mobile === true
    })
  }
  private receive(raw: unknown): void {
    const parsed = Frame.safeParse(raw)
    if (!parsed.success) { this.fail(); return }
    const { data, sessionId: ackToken, metadata } = parsed.data
    try {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw externalCdpError()
      const image = new Uint8Array(Buffer.from(data, 'base64'))
      const size = readBrowserScreencastImageSize(image, this.options.format)
      if (size && isLiveFrameCompatibleWithViewport(size, this.options)) {
        this.pending = { image, metadata: enrichFrameMetadata(readFrameMetadata(metadata), size, this.options) }
        this.schedule()
      }
    } catch { this.fail() }
    // ACK uses the frame token in params and the bound session in the envelope.
    if (!this.closed) void this.command('Page.screencastFrameAck', { sessionId: ackToken }).catch(() => this.fail())
  }
  private schedule(): void {
    if (this.timer || this.closed) return
    const remaining = this.options.minFrameIntervalMs - (Date.now() - this.lastSentAt)
    if (remaining <= 0 || !this.lastSentAt) { this.flush(); return }
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, remaining)
  }
  private flush(): void {
    if (this.closed || !this.pending) return
    const frame = this.pending
    this.pending = null
    this.lastSentAt = Date.now()
    this.options.onFrame(encodeBrowserScreencastFrame({
      opcode: BrowserScreencastOpcode.Frame, seq: this.seq++, format: this.options.format,
      ...frame
    }))
  }
  private update(operation: () => Promise<void>): Promise<void> {
    const next = this.updates.then(async () => { this.assertOpen(); await operation(); this.assertOpen() })
    this.updates = next.catch(() => { this.fail() })
    return next
  }
  updateViewport(viewport: BrowserScreencastViewport): Promise<void> {
    return this.update(async () => {
      Object.assign(this.options, viewport)
      this.pending = null
      await this.applyViewport()
    })
  }
  updateFrameBudget(budget: BrowserScreencastFrameBudget): Promise<void> {
    return this.update(async () => {
      Object.assign(this.options, budget)
      this.pending = null
      await this.command('Page.stopScreencast')
      await this.command('Page.startScreencast', this.captureParams())
    })
  }
  private fail(): void {
    if (this.closed) return
    this.options.onError?.('The owned browser screencast ended.')
    this.stop()
  }
  stop(): void {
    if (this.closed) return
    this.closed = true
    this.removeEvent()
    this.removeFailure()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
    if (this.sessionId) this.connection.cancelSession(this.sessionId, this.transportIdentity)
    this.cleanup = this.finish()
    void this.cleanup.catch(() => {}).finally(() => this.resolveDone())
  }
  private cleanupCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.sessionId || !this.connection.ownsTransport(this.transportIdentity, this.page.browserGeneration)) {
      return Promise.reject(externalCdpError())
    }
    return this.connection.command(method, params, this.sessionId, this.transportIdentity)
  }
  private async finish(): Promise<void> {
    // An attach already in flight can finish after stop; detach that exact session too.
    await Promise.all([this.opening?.catch(() => {}), this.updates.catch(() => {})])
    const sessionId = this.sessionId
    if (!sessionId) return
    if (this.started) await this.cleanupCommand('Page.stopScreencast').catch(() => {})
    if (this.metricsAttempted) await this.cleanupCommand('Emulation.clearDeviceMetricsOverride').catch(() => {})
    this.connection.cancelSession(sessionId, this.transportIdentity)
    if (this.connection.ownsTransport(this.transportIdentity, this.page.browserGeneration)) {
      await this.connection.command('Target.detachFromTarget', { sessionId }, undefined, this.transportIdentity).catch(() => {})
    }
  }
}
