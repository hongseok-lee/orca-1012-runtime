import { randomUUID } from 'node:crypto'

/** Only an authenticated socket owner supplies this live capability. */
export type TerminalInputConnection = Readonly<{
  connectionIncarnation: string
  pairedDeviceId: string
  authenticatedCallerFingerprint: string
  assertCurrent: () => void
  assertPreviousInvalidated: (connectionIncarnation: string, pairedDeviceId: string, fingerprint: string) => void
}>
type Connection = { pairedDeviceId: string; fingerprint: string | null; invalidated: boolean }

/** Absence is unknown. Tombstones are created only by an actual owner hook;
 * a fresh server incarnation can never claim that an old socket terminated. */
export class TerminalConnectionOwner {
  private readonly incarnation = randomUUID()
  private readonly connections = new Map<string, Connection>()
  register(connectionId: string, pairedDeviceId: string): void {
    if (this.connections.has(connectionId)) { throw new Error('TERMINAL_CONNECTION_ID_REUSED') }
    this.connections.set(connectionId, { pairedDeviceId, fingerprint: null, invalidated: false })
  }
  invalidate(connectionId: string): void {
    const original = this.connections.get(connectionId)
    if (original) { original.invalidated = true }
  }
  capture(connectionId: string, pairedDeviceId: string, fingerprint: string, checkSocket: () => boolean): TerminalInputConnection {
    const original = this.connections.get(connectionId)
    if (!original || original.pairedDeviceId !== pairedDeviceId || !/^[a-f0-9]{64}$/u.test(fingerprint) ||
        original.fingerprint !== null && original.fingerprint !== fingerprint) { throw new Error('TERMINAL_AUTHENTICATED_CONNECTION_REQUIRED') }
    original.fingerprint = fingerprint
    const connectionIncarnation = `${this.incarnation}:${connectionId}`
    const assertCurrent = (): void => {
      if (original.invalidated || this.connections.get(connectionId) !== original || !checkSocket()) {
        throw new Error('TERMINAL_CONNECTION_INVALIDATED')
      }
    }
    assertCurrent()
    return Object.freeze({ connectionIncarnation, pairedDeviceId, authenticatedCallerFingerprint: fingerprint, assertCurrent,
      assertPreviousInvalidated: (previous: string, device: string, principal: string): void => {
        assertCurrent()
        const prefix = `${this.incarnation}:`
        const old = previous.startsWith(prefix) ? this.connections.get(previous.slice(prefix.length)) : null
        if (!old || !old.invalidated || old.pairedDeviceId !== device || old.fingerprint !== principal ||
            device !== pairedDeviceId || principal !== fingerprint) { throw new Error('TERMINAL_PREVIOUS_CONNECTION_INVALIDATION_UNPROVEN') }
      } })
  }
}
