import { ExternalChromiumCdpConnection } from './external-chromium-cdp-connection'
import type { ExternalCdpEvent } from './external-chromium-cdp-connection'
import { ExternalChromiumBrowserSession } from './external-chromium-browser-session'
import { deferred } from '../durable-runtime/rpc/fixture-support.mts'

/** Explicit native/CDP doubles for the new composition only; no process or socket is opened. */
export class CompositionCdp extends ExternalChromiumCdpConnection {
  fixtureGeneration = 'composition-generation'
  fixtureTransport = 1
  readonly calls: { method: string; params: Record<string, unknown>; sessionId?: string; transportIdentity?: number }[] = []
  readonly targets = new Map<string, { id: string; loaderId: string; url: string }>()
  readonly sessions = new Map<string, string>()
  readonly listeners = new Set<(event: ExternalCdpEvent) => void>()
  readonly failed = new Set<() => void>()
  readonly changed = new Set<() => void>()
  readonly cancelled: string[] = []
  attachGate: ReturnType<typeof deferred<void>> | null = null
  readonly attachEntered = deferred<void>()
  readonly continued = deferred<void>()
  private serial = 0
  override get generation(): string { return this.fixtureGeneration }
  override get transportIdentity(): number { return this.fixtureTransport }
  override ownsTransport(identity: number, generation: string): boolean {
    return identity === this.fixtureTransport && generation === this.fixtureGeneration
  }
  override onEvent(listener: (event: ExternalCdpEvent) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener) }
  }
  override onFailure(listener: () => void): () => void {
    this.failed.add(listener); return () => { this.failed.delete(listener) }
  }
  override onGenerationChanged(listener: () => void): () => void {
    this.changed.add(listener); return () => { this.changed.delete(listener) }
  }
  emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    for (const listener of Array.from(this.listeners)) { listener({ method, params, sessionId }) }
  }
  override cancelSession(sessionId: string): void { this.cancelled.push(sessionId) }
  override async command(method: string, params: Record<string, unknown> = {}, sessionId?: string, transportIdentity?: number): Promise<unknown> {
    this.calls.push({ method, params: structuredClone(params), sessionId, transportIdentity })
    if (method === 'Fetch.continueRequest') { this.continued.resolve() }
    if (method === 'Target.getTargets') {
      return { targetInfos: Array.from(this.targets, ([targetId, frame]) => ({ targetId, type: 'page', url: frame.url })) }
    }
    if (method === 'Target.attachToTarget') {
      const owned = `auth-${++this.serial}`; this.sessions.set(owned, String(params.targetId))
      this.attachEntered.resolve()
      if (this.attachGate) { await this.attachGate.promise }
      return { sessionId: owned }
    }
    if (method === 'Page.getFrameTree') {
      const target = sessionId && this.sessions.get(sessionId)
      const frame = target && this.targets.get(target)
      return { frameTree: { frame: frame ? { ...frame } : null } }
    }
    if (method === 'Target.detachFromTarget') { this.sessions.delete(String(params.sessionId)) }
    return {}
  }
  commit(targetId: string, url: string): void {
    const frame = { id: `frame-${targetId}`, loaderId: `loader-${++this.serial}`, url }
    this.targets.set(targetId, frame)
    for (const [sessionId, target] of this.sessions) {
      if (target === targetId) { this.emit('Page.frameNavigated', { frame }, sessionId) }
    }
  }
}
export class CompositionNativeSession extends ExternalChromiumBrowserSession {
  override readonly cdp = new CompositionCdp()
  readonly nativeCalls: string[][] = []
  readonly pages = new Map<string, { tabId: string; title: string; url: string; active: boolean }>()
  failNavigate = false
  failClose = false
  selected = ''
  markerGate: ReturnType<typeof deferred<void>> | null = null
  readonly markerEntered = deferred<void>()
  beforeNavigate: ((url: string) => void) | null = null
  private nextPage = 0
  constructor() { super('unused-composition-driver', { executablePath: 'unused', provider: 'chromium' }, 'unused-composition-state') }
  override async connectCdp(): Promise<void> {}
  override async stop(): Promise<void> { this.nativeCalls.push(['provider-stop']) }
  override async readTabs() { return Array.from(this.pages.values(), page => ({ ...page })) }
  override async run(command: readonly string[]): Promise<unknown> {
    this.nativeCalls.push([...command])
    if (command[0] === 'tab' && command[1] === 'new') {
      const tabId = `agent-${++this.nextPage}`; this.selected = tabId
      this.pages.set(tabId, { tabId, title: 'Synthetic', url: command[2], active: true })
      this.cdp.commit(`target-${tabId}`, command[2]); this.markerEntered.resolve()
      if (this.markerGate) { await this.markerGate.promise }
      return { tabId }
    }
    if (command[0] === 'open') {
      this.beforeNavigate?.(command[1])
      if (this.failNavigate && !command[1].includes('#orca-target-')) { throw new Error('Synthetic native navigation failure') }
      const page = this.pages.get(this.selected)
      if (!page) { throw new Error('Missing synthetic selected page') }
      page.url = command[1]; this.cdp.commit(`target-${this.selected}`, command[1])
    } else if (command[0] === 'tab' && command[1] === 'close') {
      if (this.failClose) { throw new Error('Synthetic native close failure') }
      this.pages.delete(command[2]); this.cdp.targets.delete(`target-${command[2]}`)
    } else if (command[0] === 'tab' && command[1]) { this.selected = command[1] }
    return {}
  }
}
