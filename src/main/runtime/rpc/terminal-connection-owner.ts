import { randomUUID } from 'node:crypto'

/** Only an authenticated socket owner supplies this live capability. */
export type TerminalInputConnection = Readonly<{
  connectionIncarnation: string
  pairedDeviceId: string
  authenticatedCallerFingerprint: string
  assertCurrent: () => void
  assertPreviousInvalidated: (connectionIncarnation: string, pairedDeviceId: string, fingerprint: string) => void
  reserveLogicalFloor: (target: TerminalLogicalTarget, previousConnection: string | null) => TerminalLogicalFloorGrant
}>
export type TerminalLogicalTarget = Readonly<{handle: string; sessionId: string; mode: 'AGENT_CHAT_COMPAT'}>
export type TerminalLogicalFloorGrant = Readonly<{assertCurrent: () => void; commit: () => void; rollbackConfirmed: () => void}>
type Connection = { pairedDeviceId: string; fingerprint: string | null; invalidated: boolean }
type LogicalOwner = {target: TerminalLogicalTarget; connection: string; device: string; fingerprint: string; committed: boolean}

/** Absence is unknown. Tombstones are created only by an actual owner hook;
 * a fresh server incarnation can never claim that an old socket terminated. */
export class TerminalConnectionOwner {
  private readonly incarnation = randomUUID()
  private readonly connections = new Map<string, Connection>()
  private readonly logicalFloors = new Map<string, LogicalOwner>()
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
    const assertPreviousInvalidated = (previous: string, device: string, principal: string): void => {
        assertCurrent()
        const prefix = `${this.incarnation}:`
        const old = previous.startsWith(prefix) ? this.connections.get(previous.slice(prefix.length)) : null
        if (!old || !old.invalidated || old.pairedDeviceId !== device || old.fingerprint !== principal ||
            device !== pairedDeviceId || principal !== fingerprint) { throw new Error('TERMINAL_PREVIOUS_CONNECTION_INVALIDATION_UNPROVEN') }
    }
    return Object.freeze({ connectionIncarnation, pairedDeviceId, authenticatedCallerFingerprint: fingerprint, assertCurrent,
      assertPreviousInvalidated,
      reserveLogicalFloor: (target: TerminalLogicalTarget, previousConnection: string | null): TerminalLogicalFloorGrant => {
        assertCurrent()
        if (!target.handle || !target.sessionId || target.mode !== 'AGENT_CHAT_COMPAT') { throw new Error('TERMINAL_LOGICAL_TARGET_REQUIRED') }
        const fixed = Object.freeze({...target}), prior = this.logicalFloors.get(target.handle)
        if (prior && (prior.target.sessionId !== fixed.sessionId || prior.target.mode !== fixed.mode ||
            prior.device !== pairedDeviceId || prior.fingerprint !== fingerprint)) { throw new Error('TERMINAL_LOGICAL_FLOOR_OWNED') }
        if (previousConnection === null && prior) { throw new Error('TERMINAL_LOGICAL_FLOOR_ALREADY_RESERVED') }
        if (previousConnection !== null) {
          if (!prior || prior.connection !== previousConnection) { throw new Error('TERMINAL_LOGICAL_FLOOR_GRANT_UNPROVEN') }
          if (previousConnection !== connectionIncarnation) { assertPreviousInvalidated(previousConnection, pairedDeviceId, fingerprint) }
        }
        const next: LogicalOwner = prior?.connection === connectionIncarnation ? prior : {
          target: fixed, connection: connectionIncarnation, device: pairedDeviceId, fingerprint, committed: false}
        this.logicalFloors.set(target.handle, next)
        const check = (): void => {
          assertCurrent()
          if (this.logicalFloors.get(fixed.handle) !== next) { throw new Error('TERMINAL_LOGICAL_FLOOR_REPLACED') }
        }
        return Object.freeze({assertCurrent: check,
          commit: () => { check(); next.committed = true },
          rollbackConfirmed: () => {
            if (this.logicalFloors.get(fixed.handle) === next && next !== prior && !next.committed) {
              if (prior) { this.logicalFloors.set(fixed.handle, prior) } else { this.logicalFloors.delete(fixed.handle) }
            }
          }})
      } })
  }
}
