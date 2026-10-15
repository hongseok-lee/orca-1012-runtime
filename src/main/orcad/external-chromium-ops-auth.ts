import { BrowserError } from '../browser/browser-error'
import type { ExternalCdpEvent } from './external-chromium-cdp-connection'
import type {
  ExternalChromiumOpsAuthHandle, ExternalChromiumOpsAuthInput, ExternalChromiumOpsAuthState
} from './external-chromium-ops-auth-types'

export type {
  ExternalChromiumOpsAuthHandle, ExternalChromiumOpsAuthInput, ExternalChromiumOpsAuthState
} from './external-chromium-ops-auth-types'

const FAILURE_CODE = 'browser_ops_auth_unavailable'
const failure = (): BrowserError => new BrowserError(FAILURE_CODE, 'The owned browser operations authentication is unavailable.')
type MainDocument = Readonly<{ id: string; loaderId: string; url: string }>
type Paused = { requestId: string; attempted: boolean }
type Header = { name: string; value: string }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
function httpUrl(value: unknown): URL | null {
  if (typeof value !== 'string') { return null }
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null
  } catch { return null }
}
function canonicalOrigin(value: string): string {
  const url = httpUrl(value)
  if (!url || url.origin !== value) { throw failure() }
  return url.origin
}
function mainDocument(raw: unknown): MainDocument | null {
  if (!record(raw) || raw.parentId !== undefined || !nonempty(raw.id) ||
      !nonempty(raw.loaderId) || typeof raw.url !== 'string') { return null }
  return Object.freeze({ id: raw.id, loaderId: raw.loaderId, url: raw.url })
}
function treeDocument(raw: unknown): MainDocument | null {
  return record(raw) && record(raw.frameTree) ? mainDocument(raw.frameTree.frame) : null
}
function requestHeaders(raw: unknown): Header[] | null {
  if (!record(raw)) { return null }
  const headers: Header[] = []
  for (const [name, value] of Object.entries(raw)) {
    if (name.toLowerCase() === 'authorization' || typeof value !== 'string') { return null }
    headers.push({ name, value })
  }
  return headers
}

class OpsAuthOwner {
  private readonly page: ExternalChromiumOpsAuthInput['page']
  private readonly origin: string
  private readonly attach: ExternalChromiumOpsAuthInput['connection']['attach']
  private readonly command: ExternalChromiumOpsAuthInput['connection']['command']
  private readonly ownsTransport: ExternalChromiumOpsAuthInput['connection']['ownsTransport']
  private readonly cancelSession: ExternalChromiumOpsAuthInput['connection']['cancelSession']
  private readonly subscribe: () => void
  private readonly removeListeners: (() => void)[] = []
  private readBearer: (() => string | null) | null
  private releaseBearer: (() => void | Promise<void>) | null
  private phase: ExternalChromiumOpsAuthState['phase'] = 'starting'
  private sessionId: string | null = null
  private document: MainDocument | null = null
  private revision = 0
  private fetchAttempted = false
  private cleanup: Promise<void> | null = null
  private readonly paused = new Map<string, Paused>()
  private readonly openingDone: Promise<void>
  private resolveOpening!: () => void
  readonly handle: ExternalChromiumOpsAuthHandle

  constructor(input: ExternalChromiumOpsAuthInput, releaseBearer: () => void | Promise<void>) {
    // Capture values and every original receiver before attach can yield.
    this.origin = canonicalOrigin(input.opsOrigin)
    this.page = Object.freeze({ publicPageId: input.page.publicPageId, targetId: input.page.targetId,
      browserGeneration: input.page.browserGeneration, transportIdentity: input.page.transportIdentity })
    if (!nonempty(this.page.publicPageId) || !nonempty(this.page.targetId) ||
        !nonempty(this.page.browserGeneration) || !Number.isSafeInteger(this.page.transportIdentity) ||
        this.page.transportIdentity <= 0) { throw failure() }
    const connection = input.connection
    this.attach = connection.attach.bind(connection)
    this.command = connection.command.bind(connection)
    this.ownsTransport = connection.ownsTransport.bind(connection)
    this.cancelSession = connection.cancelSession.bind(connection)
    this.readBearer = input.readBearer.bind(input)
    this.releaseBearer = releaseBearer
    this.openingDone = new Promise(resolve => { this.resolveOpening = resolve })
    this.handle = Object.freeze({
      snapshot: () => Object.freeze({ phase: this.phase,
        documentEligible: this.phase === 'ready' && this.owned() && this.isOpsDocument(this.document) }),
      dispose: () => this.dispose(false)
    })
    const onEvent = connection.onEvent.bind(connection)
    const onFailure = connection.onFailure.bind(connection)
    const onGenerationChanged = connection.onGenerationChanged.bind(connection)
    this.subscribe = () => {
      this.removeListeners.push(onEvent(event => this.receive(event)))
      this.removeListeners.push(onFailure(() => { void this.dispose(true) }))
      this.removeListeners.push(onGenerationChanged(() => { void this.dispose(true) }))
    }
  }

  private owned(): boolean {
    try { return this.ownsTransport(this.page.transportIdentity, this.page.browserGeneration) }
    catch { return false }
  }
  private stopped(): boolean { return this.phase === 'disposed' || this.phase === 'failed' }
  private assertOpen(): void {
    if (this.stopped() || !this.owned()) { throw failure() }
  }
  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.assertOpen()
    if (!this.sessionId) { throw failure() }
    return this.command(method, params, this.sessionId, this.page.transportIdentity)
  }
  private isOpsDocument(document: MainDocument | null): boolean {
    const url = document && httpUrl(document.url)
    return !!url && url.origin === this.origin && (url.pathname === '/ops' || url.pathname === '/ops/')
  }
  private commit(document: MainDocument | null): void {
    this.revision++
    this.document = document
  }

  async start(): Promise<void> {
    try {
      this.subscribe()
      this.assertOpen()
      this.sessionId = await this.attach(this.page.targetId, this.page.browserGeneration, () => this.assertOpen())
      this.assertOpen()
      if (!nonempty(this.sessionId)) { throw failure() }
      await this.send('Page.enable')
      const revision = this.revision
      const document = treeDocument(await this.send('Page.getFrameTree'))
      this.assertOpen()
      if (!document) { throw failure() }
      // An event received while observing the tree outranks the earlier snapshot.
      if (revision === this.revision) { this.commit(document) }
      this.fetchAttempted = true
      await this.send('Fetch.enable', { patterns: [
        { resourceType: 'Fetch', requestStage: 'Request' },
        { resourceType: 'XHR', requestStage: 'Request' }
      ], handleAuthRequests: false })
      this.assertOpen()
      this.phase = 'ready'
    } finally { this.resolveOpening() }
  }

  private receive(event: ExternalCdpEvent): void {
    if (this.stopped()) { return }
    if ((event.method === 'Target.targetDestroyed' && event.params?.targetId === this.page.targetId) ||
        (this.sessionId && event.method === 'Target.detachedFromTarget' && event.params?.sessionId === this.sessionId)) {
      void this.dispose(true)
      return
    }
    if (!this.sessionId || event.sessionId !== this.sessionId) { return }
    if (!this.owned() || event.method === 'Inspector.detached') { void this.dispose(true); return }
    const params = event.params
    if (event.method === 'Page.frameNavigated') {
      if (record(params?.frame) && params.frame.parentId !== undefined) { return }
      this.commit(mainDocument(params?.frame))
    } else if (event.method === 'Page.navigatedWithinDocument' && params?.frameId === this.document?.id) {
      this.commit(typeof params?.url === 'string' && this.document
        ? Object.freeze({ ...this.document, url: params.url }) : null)
    } else if (['Page.frameStartedNavigating', 'Page.frameStartedLoading', 'Page.frameDetached'].includes(event.method ?? '') &&
        params?.frameId === this.document?.id) {
      this.commit(null)
    } else if (event.method === 'Fetch.requestPaused') {
      // Only the owned session's pause is ours to continue. Never retain body/raw params.
      if (!params || !nonempty(params.requestId)) { void this.dispose(true); return }
      if (this.paused.has(params.requestId)) { return }
      const pause: Paused = { requestId: params.requestId, attempted: false }
      this.paused.set(pause.requestId, pause)
      void this.continuePaused(pause, params).catch(() => this.dispose(true))
    }
  }

  private async continuePaused(pause: Paused, params: Record<string, unknown>): Promise<void> {
    const document = this.document
    const revision = this.revision
    const request = record(params.request) ? params.request : null
    const url = request && httpUrl(request.url)
    const headers = request && requestHeaders(request.headers)
    const eligible = this.phase === 'ready' && this.isOpsDocument(document) && document?.id === params.frameId &&
      !('responseStatusCode' in params) && !('responseErrorReason' in params) && !('redirectedRequestId' in params) &&
      (params.resourceType === 'Fetch' || params.resourceType === 'XHR') &&
      !!url && url.origin === this.origin && url.pathname.startsWith('/ops/v1/')
    if (!eligible || !headers) { await this.resume(pause); return }
    // A fresh committed frame tree and unchanged observation epoch are both required.
    const observed = treeDocument(await this.send('Page.getFrameTree'))
    if (this.stopped() || !this.owned() || this.revision !== revision || this.document !== document ||
        !document || !observed || observed.id !== document.id || observed.loaderId !== document.loaderId ||
        observed.url !== document.url) {
      if (this.revision === revision && this.document === document) { this.commit(null) }
      await this.resume(pause)
      return
    }
    const bearer = this.readBearer?.()
    // readBearer is synchronous but may revoke/replace ownership as a side effect.
    if (this.stopped() || !this.owned() || this.revision !== revision || this.document !== document ||
        typeof bearer !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(bearer)) {
      await this.resume(pause)
      return
    }
    await this.resume(pause, [...headers, { name: 'Authorization', value: `Bearer ${bearer}` }])
  }

  private async resume(pause: Paused, headers?: Header[]): Promise<void> {
    if (pause.attempted) { return }
    pause.attempted = true
    try {
      if (!this.sessionId || !this.owned()) { return }
      await this.command('Fetch.continueRequest', { requestId: pause.requestId, ...(headers ? { headers } : {}) },
        this.sessionId, this.page.transportIdentity)
    } finally { this.paused.delete(pause.requestId) }
  }

  dispose(failed: boolean): Promise<void> {
    if (this.cleanup) { return this.cleanup }
    let complete!: () => void
    this.cleanup = new Promise(resolve => { complete = resolve })
    this.phase = failed ? 'failed' : 'disposed'
    this.commit(null)
    for (const remove of this.removeListeners.splice(0)) {
      try { remove() } catch { /* Keep disposing the other owned listeners. */ }
    }
    this.readBearer = null
    const release = this.releaseBearer
    this.releaseBearer = null
    // Cancel only this helper's pending observations, never another CDP session.
    if (this.sessionId && this.owned()) {
      try { this.cancelSession(this.sessionId, this.page.transportIdentity) } catch { /* Owned cleanup continues. */ }
    }
    void this.finish(release).then(complete, complete)
    return this.cleanup
  }
  private async finish(release: (() => void | Promise<void>) | null): Promise<void> {
    // Continue pauses immediately; a bearer owner's async disposal must not park them.
    const resumed = Promise.allSettled([...this.paused.values()].map(pause => this.resume(pause)))
    let released: Promise<void>
    try { released = Promise.resolve(release?.()).catch(() => {}) }
    catch { released = Promise.resolve() }
    await this.openingDone
    await resumed
    const sessionId = this.sessionId
    if (!sessionId || !this.owned()) { await released; return }
    if (this.fetchAttempted) {
      try { await this.command('Fetch.disable', {}, sessionId, this.page.transportIdentity) }
      catch { /* Detach the same session even if disabling failed. */ }
    }
    if (this.owned()) {
      try { await this.command('Target.detachFromTarget', { sessionId }, undefined, this.page.transportIdentity) }
      catch { /* Never substitute a different transport/session for cleanup. */ }
    }
    await released
  }
}

/** Standalone owner only. No caller/UI/Browser registry or server auth wiring is installed here. */
export async function createExternalChromiumOpsAuth(input: ExternalChromiumOpsAuthInput): Promise<ExternalChromiumOpsAuthHandle> {
  let release: (() => void | Promise<void>) | null = null
  let owner: OpsAuthOwner | null = null
  try {
    release = input.disposeBearer.bind(input)
    owner = new OpsAuthOwner(input, release)
    await owner.start()
    return owner.handle
  } catch {
    if (owner) { await owner.dispose(true) }
    else { try { await release?.() } catch { /* Stable public failure below. */ } }
    throw failure()
  }
}
