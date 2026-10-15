import type { BrowserOpsAuthCapability } from '../runtime/browser-ops-auth-capability'
import { browserOpsAuthUnavailable, ownBrowserAuthValue } from '../runtime/browser-ops-auth-capability'
import { createExternalChromiumOpsAuth } from './external-chromium-ops-auth'
import type { ExternalChromiumOpsAuthHandle, ExternalChromiumOpsAuthInput } from './external-chromium-ops-auth-types'
import type { ExternalChromiumPageRecord } from './external-chromium-tab-projection'

type Connection = ExternalChromiumOpsAuthInput['connection'] & Readonly<{ transportIdentity: number }>
type Owner = {
  page: ExternalChromiumPageRecord
  expected: ExternalChromiumOpsAuthInput['page']
  origin: string
  fingerprint: string
  worktreePublicId: string
  closed: boolean
  release: (() => void) | null
  interceptor: ExternalChromiumOpsAuthHandle | null
  installing: Promise<void> | null
  disposal: Promise<void> | null
}

/** Tracks unpublished/in-flight pages too. Keys are exact native page objects, never just public IDs. */
export class ExternalChromiumOpsAuthOwners {
  private readonly entries = new Map<ExternalChromiumPageRecord, Owner>()
  private readonly closing = new Set<Promise<void>>()
  private stopped = false
  constructor(private readonly connection: Connection,
    private readonly install = createExternalChromiumOpsAuth) {}

  private current(owner: Owner): boolean {
    const page = owner.page, expected = owner.expected
    return !this.stopped && !owner.closed && this.entries.get(page) === owner &&
      page.publicPageId === expected.publicPageId && page.targetId === expected.targetId &&
      page.browserGeneration === expected.browserGeneration && page.worktreeId === owner.worktreePublicId &&
      this.connection.ownsTransport(expected.transportIdentity, expected.browserGeneration)
  }
  assertCurrent(page: ExternalChromiumPageRecord): void {
    const owner = this.entries.get(page)
    if (!owner || !this.current(owner) || owner.interceptor?.snapshot().phase !== 'ready') {
      throw browserOpsAuthUnavailable()
    }
  }
  async ensure(page: ExternalChromiumPageRecord, capability?: BrowserOpsAuthCapability): Promise<boolean> {
    if (!capability) { return false }
    if (this.stopped || capability.browserPageId !== page.publicPageId || capability.worktreePublicId !== page.worktreeId) {
      throw browserOpsAuthUnavailable()
    }
    const previous = this.entries.get(page)
    if (previous) {
      if (previous.fingerprint !== capability.authenticatedCallerFingerprint || previous.origin !== capability.origin ||
          previous.worktreePublicId !== capability.worktreePublicId) { throw browserOpsAuthUnavailable() }
      await previous.installing
      this.assertCurrent(page)
      return false // Replays acquire no cleanup ownership over this earlier normal session.
    }
    const owner: Owner = { page, expected: Object.freeze({ publicPageId: page.publicPageId, targetId: page.targetId,
      browserGeneration: page.browserGeneration, transportIdentity: this.connection.transportIdentity }),
    origin: capability.origin, fingerprint: capability.authenticatedCallerFingerprint,
    worktreePublicId: capability.worktreePublicId, closed: false, release: null,
    interceptor: null, installing: null, disposal: null }
    this.entries.set(page, owner)
    try {
      if (!this.current(owner)) { throw browserOpsAuthUnavailable() }
      capability.ownCleanup(() => this.dispose(owner))
      if (!this.current(owner)) { throw browserOpsAuthUnavailable() }
      owner.installing = this.open(owner, capability)
      await owner.installing
      this.assertCurrent(page)
      return true
    } catch (error) {
      await this.dispose(owner)
      throw error
    }
  }
  private async open(owner: Owner, capability: BrowserOpsAuthCapability): Promise<void> {
    const session = capability.openPageSession()
    if (ownBrowserAuthValue(session, 'browserPageId') !== owner.expected.publicPageId ||
        ownBrowserAuthValue(session, 'worktreePublicId') !== owner.worktreePublicId ||
        ownBrowserAuthValue(session, 'authenticatedCallerFingerprint') !== owner.fingerprint) {
      throw browserOpsAuthUnavailable()
    }
    const read = ownBrowserAuthValue(session, 'readBearer'), release = ownBrowserAuthValue(session, 'dispose')
    if (typeof read !== 'function' || typeof release !== 'function') { throw browserOpsAuthUnavailable() }
    owner.release = release.bind(session)
    if (!this.current(owner)) { owner.release(); throw browserOpsAuthUnavailable() }
    owner.interceptor = await this.install({ opsOrigin: owner.origin, page: owner.expected, connection: this.connection,
      readBearer: read.bind(session), disposeBearer: owner.release })
    if (!this.current(owner)) { await owner.interceptor.dispose(); throw browserOpsAuthUnavailable() }
  }
  private dispose(owner: Owner): Promise<void> {
    if (owner.disposal) { return owner.disposal }
    let complete!: () => void
    const disposal = new Promise<void>(resolve => { complete = resolve })
    owner.disposal = disposal
    this.closing.add(disposal)
    owner.closed = true
    if (this.entries.get(owner.page) === owner) { this.entries.delete(owner.page) }
    // Revoke before awaiting native close or an in-flight install.
    try { owner.release?.() } catch { /* Do not expose credential-owner errors. */ }
    const started = owner.interceptor?.dispose()
    const finish = async () => {
      // An issuer can synchronously reenter clear before installing was assigned.
      await Promise.resolve()
      await owner.installing?.catch(() => {})
      await started?.catch(() => {})
      await owner.interceptor?.dispose()
    }
    void finish().then(complete, complete)
    void disposal.then(() => { this.closing.delete(disposal) })
    return disposal
  }
  disposePage(page: ExternalChromiumPageRecord): Promise<void> {
    const owner = this.entries.get(page)
    return owner ? this.dispose(owner) : Promise.resolve()
  }
  disposeTarget(targetId: unknown): void {
    for (const owner of this.entries.values()) {
      if (owner.expected.targetId === targetId) { void this.dispose(owner) }
    }
  }
  clear(): Promise<void> {
    for (const owner of this.entries.values()) { void this.dispose(owner) }
    return Promise.all(Array.from(this.closing)).then(() => {})
  }
  stop(): Promise<void> { this.stopped = true; return this.clear() }
}
