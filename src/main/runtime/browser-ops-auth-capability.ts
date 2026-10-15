import { BrowserError } from '../browser/browser-error'
import type { OpsBrowserPageSession, OpsBrowserPageSessionInput } from '../durable-runtime/ops/browser-session-auth.ts'

export type BrowserOpsAuthIssuer = Readonly<{
  origin: string
  issuePageSession(input: OpsBrowserPageSessionInput): OpsBrowserPageSession
}>
/** Private runtime caller data. This object never enters RPC params or PG launch data. */
export type BrowserOpsAuthCapability = Readonly<OpsBrowserPageSessionInput & {
  origin: string
  openPageSession(): OpsBrowserPageSession
  ownCleanup(disposeOwn: () => Promise<void>): void
}>
export type BrowserTabCreateCaller = Readonly<{
  pairedDeviceId?: string
  clientKind?: 'mobile' | 'runtime'
  opsAuth?: BrowserOpsAuthCapability
}>

export function browserOpsAuthUnavailable(): BrowserError {
  return new BrowserError('browser_ops_auth_unavailable', 'The owned browser operations authentication is unavailable.')
}
export function ownBrowserAuthValue(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) { throw browserOpsAuthUnavailable() }
  const descriptor = Object.getOwnPropertyDescriptor(input, key)
  if (!descriptor || !('value' in descriptor)) { throw browserOpsAuthUnavailable() }
  return descriptor.value
}
export function captureBrowserOpsOrigin(input: unknown): string {
  if (typeof input !== 'string') { throw browserOpsAuthUnavailable() }
  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== input) {
      throw browserOpsAuthUnavailable()
    }
    return url.origin
  } catch { throw browserOpsAuthUnavailable() }
}
function text(input: unknown): string {
  if (typeof input !== 'string' || !input || input.trim() !== input) { throw browserOpsAuthUnavailable() }
  return input
}
export function captureBrowserTabCreateCaller(input?: BrowserTabCreateCaller): BrowserTabCreateCaller {
  const descriptor = input && Object.getOwnPropertyDescriptor(input, 'opsAuth')
  if (descriptor && !('value' in descriptor)) { throw browserOpsAuthUnavailable() }
  const value = descriptor?.value
  let opsAuth: BrowserOpsAuthCapability | undefined
  if (value !== undefined) {
    const origin = captureBrowserOpsOrigin(ownBrowserAuthValue(value, 'origin'))
    const authenticatedCallerFingerprint = text(ownBrowserAuthValue(value, 'authenticatedCallerFingerprint'))
    if (!/^[a-f0-9]{64}$/.test(authenticatedCallerFingerprint)) { throw browserOpsAuthUnavailable() }
    const browserPageId = text(ownBrowserAuthValue(value, 'browserPageId'))
    const worktreePublicId = text(ownBrowserAuthValue(value, 'worktreePublicId'))
    const open = ownBrowserAuthValue(value, 'openPageSession'), own = ownBrowserAuthValue(value, 'ownCleanup')
    if (typeof open !== 'function' || typeof own !== 'function') { throw browserOpsAuthUnavailable() }
    const openPageSession = open.bind(value), ownCleanup = own.bind(value)
    opsAuth = Object.freeze({ origin, authenticatedCallerFingerprint, browserPageId, worktreePublicId,
      openPageSession, ownCleanup })
  }
  return Object.freeze({ pairedDeviceId: input?.pairedDeviceId, clientKind: input?.clientKind,
    ...(opsAuth ? { opsAuth } : {}) })
}

/** Created only after the authenticated Catalog reservation and OPEN checks. */
export function createBrowserOpsAuthAttempt(issuer: BrowserOpsAuthIssuer, metadata: OpsBrowserPageSessionInput) {
  const origin = issuer.origin, issue = issuer.issuePageSession.bind(issuer)
  const selected = Object.freeze({ authenticatedCallerFingerprint: metadata.authenticatedCallerFingerprint,
    browserPageId: metadata.browserPageId, worktreePublicId: metadata.worktreePublicId })
  const owned = new Set<() => Promise<void>>()
  let disposed = false
  const capability: BrowserOpsAuthCapability = Object.freeze({ ...selected, origin,
    openPageSession: () => {
      if (disposed) { throw browserOpsAuthUnavailable() }
      return issue(selected)
    },
    ownCleanup: (disposeOwn: () => Promise<void>) => {
      if (disposed) { void disposeOwn(); throw browserOpsAuthUnavailable() }
      owned.add(disposeOwn)
    }
  })
  return Object.freeze({ capability, disposeCreated: async () => {
    if (disposed) { return }
    disposed = true
    await Promise.allSettled(Array.from(owned, dispose => dispose()))
    owned.clear()
  } })
}
