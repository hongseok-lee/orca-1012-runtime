import { createHash, randomBytes } from 'node:crypto'
import { snapshotOpsActor } from './actor.ts'
import type { OpsServerScope } from './actor.ts'
import type { OpsActor } from './types.ts'
import { opsId } from './validation.ts'

export type OpsBrowserPageSessionInput = Readonly<{
  authenticatedCallerFingerprint: string
  browserPageId: string
  worktreePublicId: string
}>
export type OpsBrowserPageSessionKey = Readonly<{
  browserPageId: string
  worktreePublicId: string
}>
export type OpsBrowserPageSession = OpsBrowserPageSessionInput & Readonly<{
  /** Trusted server CDP hook only. Never forward to page content or a URL. */
  readBearer(): string
  dispose(): void
}>
export type OpsBrowserSessionAuthority = Readonly<{
  issuePageSession(input: OpsBrowserPageSessionInput): OpsBrowserPageSession
  findPageSession(key: OpsBrowserPageSessionKey): OpsBrowserPageSession | null
  authenticateBearer(token: string): OpsActor | null
  close(): void
}>
export type OpsBrowserSessionAuthErrorCode =
  | 'OPS_BROWSER_SESSION_INPUT_INVALID'
  | 'OPS_BROWSER_SESSION_SCOPE_INVALID'
  | 'OPS_BROWSER_SESSION_CONFLICT'
  | 'OPS_BROWSER_SESSION_CLOSED'
  | 'OPS_BROWSER_SESSION_ISSUE_FAILED'

export class OpsBrowserSessionAuthError extends Error {
  constructor(readonly code: OpsBrowserSessionAuthErrorCode) {
    super('The operations browser page session is unavailable.')
    this.name = 'OpsBrowserSessionAuthError'
  }
}
function invalid(): never {
  throw new OpsBrowserSessionAuthError('OPS_BROWSER_SESSION_INPUT_INVALID')
}
function opaque(value: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    invalid()
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      invalid()
    }
  }
  return value
}
function captureKey(input: OpsBrowserPageSessionKey): OpsBrowserPageSessionKey {
  try {
    return Object.freeze({ browserPageId: opaque(input.browserPageId),
      worktreePublicId: opaque(input.worktreePublicId) })
  } catch {
    return invalid()
  }
}
function captureInput(input: OpsBrowserPageSessionInput): OpsBrowserPageSessionInput {
  try {
    const key = captureKey(input), fingerprint = input.authenticatedCallerFingerprint
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      invalid()
    }
    return Object.freeze({ ...key, authenticatedCallerFingerprint: fingerprint })
  } catch {
    return invalid()
  }
}
function captureScope(input: OpsServerScope): OpsServerScope {
  try {
    const datasetName = opaque(input.datasetName), namespaceId = opaque(input.namespaceId)
    const workspaces = input.workspaceIds
    if (!Array.isArray(workspaces)) {
      invalid()
    }
    return Object.freeze({ datasetName, namespaceId,
      workspaceIds: Object.freeze([...new Set(workspaces.map(opsId))].sort()) })
  } catch {
    throw new OpsBrowserSessionAuthError('OPS_BROWSER_SESSION_SCOPE_INVALID')
  }
}

type SessionRecord = Readonly<{
  handle: OpsBrowserPageSession
  actor: OpsActor
}>
const bearerPrefix = 'orca-ops-page-v1.'
const bearerPattern = /^orca-ops-page-v1\.[A-Za-z0-9_-]{43}$/
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Server composition only; the caller has already authenticated/authorized the
 * RPC and reserved the exact logical Browser in PG. This module issues neither
 * that verification nor a PG receipt, provider capability or HA-persistent key.
 * All methods are synchronous and receiver-independent: input and server scope
 * snapshots finish before any caller await. There is no external I/O or TTL. */
export function createOpsBrowserSessionAuthority(scope: OpsServerScope): OpsBrowserSessionAuthority {
  const selected = captureScope(scope)
  const pages = new Map<string, SessionRecord>()
  // Only SHA256 digests index bearer lookup. Raw values stay in handle closures.
  const bearers = new Map<string, SessionRecord>()
  let closed = false
  const issuePageSession = (input: OpsBrowserPageSessionInput): OpsBrowserPageSession => {
    if (closed) {
      throw new OpsBrowserSessionAuthError('OPS_BROWSER_SESSION_CLOSED')
    }
    const metadata = captureInput(input), previous = pages.get(metadata.browserPageId)
    if (previous) {
      if (previous.handle.worktreePublicId !== metadata.worktreePublicId ||
          previous.handle.authenticatedCallerFingerprint !== metadata.authenticatedCallerFingerprint) {
        throw new OpsBrowserSessionAuthError('OPS_BROWSER_SESSION_CONFLICT')
      }
      return previous.handle
    }
    const actor = snapshotOpsActor({ ...selected,
      principalId: `pairing-sha256:${metadata.authenticatedCallerFingerprint}`,
      authorizationRef: `ops-pairing-sha256:${metadata.authenticatedCallerFingerprint}` })
    let bearer: string | null, bearerDigest: string
    try {
      do {
        bearer = `${bearerPrefix}${randomBytes(32).toString('base64url')}`
        bearerDigest = digest(bearer)
      } while (bearers.has(bearerDigest))
    } catch {
      throw new OpsBrowserSessionAuthError('OPS_BROWSER_SESSION_ISSUE_FAILED')
    }
    let disposed = false
    const handle: OpsBrowserPageSession = Object.freeze({ ...metadata,
      readBearer: (): string => {
        if (closed || disposed || bearer === null) {
          throw new OpsBrowserSessionAuthError('OPS_BROWSER_SESSION_CLOSED')
        }
        return bearer
      },
      dispose: (): void => {
        if (disposed) {
          return
        }
        disposed = true
        bearer = null
        // A stale handle can never remove a later reissue of the same page.
        if (pages.get(metadata.browserPageId) === owned) {
          pages.delete(metadata.browserPageId)
        }
        if (bearers.get(bearerDigest) === owned) {
          bearers.delete(bearerDigest)
        }
      }
    })
    const owned: SessionRecord = Object.freeze({ handle, actor })
    pages.set(metadata.browserPageId, owned)
    bearers.set(bearerDigest, owned)
    return handle
  }
  const findPageSession = (input: OpsBrowserPageSessionKey): OpsBrowserPageSession | null => {
    const key = captureKey(input)
    if (closed) {
      return null
    }
    const record = pages.get(key.browserPageId)
    return record?.handle.worktreePublicId === key.worktreePublicId ? record.handle : null
  }
  const authenticateBearer = (token: string): OpsActor | null => {
    if (closed || typeof token !== 'string' || !bearerPattern.test(token)) {
      return null
    }
    return bearers.get(digest(token))?.actor ?? null
  }
  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    for (const record of [...pages.values()]) {
      record.handle.dispose()
    }
    pages.clear()
    bearers.clear()
  }
  return Object.freeze({ issuePageSession, findPageSession, authenticateBearer, close })
}
