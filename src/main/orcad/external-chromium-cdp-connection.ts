import { createHash } from 'node:crypto'
import WebSocket from 'ws'
import { z } from 'zod'
import { BrowserError } from '../browser/browser-error'

const Envelope = z.object({
  id: z.number().int().optional(),
  method: z.string().optional(),
  sessionId: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional()
})
const Targets = z.object({
  targetInfos: z.array(z.object({ targetId: z.string().min(1), type: z.string(), url: z.string() }))
})
const Attached = z.object({ sessionId: z.string().min(1) })
export type ExternalCdpEvent = z.infer<typeof Envelope>
type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  sessionId?: string
}
export function externalCdpError(): BrowserError {
  return new BrowserError('browser_screencast_unavailable', 'The owned browser CDP transport is unavailable.')
}
export function validateExternalBrowserEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || value.includes('?') || value.includes('#')) throw externalCdpError()
  try {
    const url = new URL(value)
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !url.port || url.username || url.password || url.search || url.hash
      || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(url.pathname)) throw externalCdpError()
    return url.href
  } catch { throw externalCdpError() }
}

export class ExternalChromiumCdpConnection {
  private socket: WebSocket | null = null
  private endpoint: string | null = null
  private generationValue: string | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly events = new Set<(event: ExternalCdpEvent) => void>()
  private readonly failures = new Set<() => void>()
  private readonly generations = new Set<() => void>()
  private connecting: Promise<void> | null = null
  private rejectOpening: ((error: Error) => void) | null = null

  get generation(): string {
    if (!this.generationValue) throw externalCdpError()
    return this.generationValue
  }
  onEvent(listener: (event: ExternalCdpEvent) => void): () => void {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }
  onFailure(listener: () => void): () => void {
    this.failures.add(listener)
    return () => this.failures.delete(listener)
  }
  onGenerationChanged(listener: () => void): () => void {
    this.generations.add(listener)
    return () => this.generations.delete(listener)
  }
  async connect(rawEndpoint: unknown): Promise<void> {
    const endpoint = validateExternalBrowserEndpoint(rawEndpoint)
    if (this.connecting) await this.connecting
    if (endpoint === this.endpoint && this.socket?.readyState === WebSocket.OPEN) return
    if (this.endpoint && endpoint !== this.endpoint) {
      this.close()
      for (const listener of this.generations) listener()
    }
    this.endpoint = endpoint
    this.generationValue = createHash('sha256').update(endpoint).digest('hex')
    const connecting = this.open(endpoint).then(async () => {
      await this.command('Target.setDiscoverTargets', { discover: true })
    })
    this.connecting = connecting
    try { await connecting } catch {
      this.close()
      throw externalCdpError()
    } finally {
      if (this.connecting === connecting) this.connecting = null
    }
  }
  private open(endpoint: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint, { handshakeTimeout: 8000, maxPayload: 50 * 1024 * 1024 })
      this.socket = socket
      this.rejectOpening = reject
      let opened = false
      const fail = (): void => {
        if (this.socket !== socket) return
        this.failSocket(socket)
        if (!opened) reject(externalCdpError())
      }
      socket.on('error', fail)
      socket.on('close', fail)
      socket.once('open', () => {
        if (this.socket !== socket) return
        opened = true
        this.rejectOpening = null
        resolve()
      })
      socket.on('message', (bytes) => {
        if (this.socket !== socket) return
        let event: ExternalCdpEvent
        try { event = Envelope.parse(JSON.parse(bytes.toString())) } catch { fail(); return }
        if (event.id !== undefined) {
          const command = this.pending.get(event.id)
          if (!command) return
          this.pending.delete(event.id)
          clearTimeout(command.timer)
          if (event.error !== undefined || event.sessionId !== command.sessionId) {
            command.reject(externalCdpError())
          } else command.resolve(event.result)
          return
        }
        for (const listener of this.events) listener(event)
      })
    })
  }
  command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(externalCdpError())
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(externalCdpError())
        this.failSocket(socket)
      }, 8000)
      this.pending.set(id, { resolve, reject, timer, sessionId })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
        if (error) this.failSocket(socket)
      })
    })
  }
  cancelSession(sessionId: string): void {
    for (const [id, command] of this.pending) {
      if (command.sessionId !== sessionId) continue
      clearTimeout(command.timer)
      this.pending.delete(id)
      command.reject(externalCdpError())
    }
  }
  private failSocket(socket: WebSocket): void {
    if (this.socket !== socket) return
    this.socket = null
    this.rejectOpening?.(externalCdpError())
    this.rejectOpening = null
    for (const command of this.pending.values()) {
      clearTimeout(command.timer)
      command.reject(externalCdpError())
    }
    this.pending.clear()
    socket.removeAllListeners()
    socket.on('error', () => {})
    socket.terminate()
    for (const listener of this.failures) listener()
  }
  close(): void {
    if (this.socket) this.failSocket(this.socket)
  }
  async exactMarkerTarget(marker: string): Promise<string> {
    const targets = Targets.parse(await this.command('Target.getTargets')).targetInfos
      .filter((target) => target.type === 'page' && target.url === marker)
    if (targets.length !== 1) throw externalCdpError()
    return targets[0].targetId
  }
  async hasTarget(targetId: string, generation: string): Promise<boolean> {
    if (generation !== this.generation) return false
    const targets = Targets.parse(await this.command('Target.getTargets')).targetInfos
    return generation === this.generation && targets.some(target => target.type === 'page' && target.targetId === targetId)
  }
  async attach(targetId: string, generation: string): Promise<string> {
    if (generation !== this.generation) throw externalCdpError()
    const targets = Targets.parse(await this.command('Target.getTargets')).targetInfos
    if (!targets.some((target) => target.type === 'page' && target.targetId === targetId)) {
      throw externalCdpError()
    }
    const attached = Attached.parse(await this.command('Target.attachToTarget', { targetId, flatten: true }))
    if (generation !== this.generation) {
      await this.command('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => {})
      throw externalCdpError()
    }
    return attached.sessionId
  }
}
