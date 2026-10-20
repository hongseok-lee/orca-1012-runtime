import { randomUUID } from 'node:crypto'

/** Only an authenticated socket owner supplies this live capability. */
export type TerminalInputConnection = Readonly<{
  connectionIncarnation: string
  pairedDeviceId: string
  authenticatedCallerFingerprint: string
  assertCurrent: () => void
  assertPreviousInvalidated: (connectionIncarnation: string, pairedDeviceId: string, fingerprint: string) => void
  /** foreignOwner: the PG floor belongs to another device/caller and this send takes it over. */
  reserveLogicalFloor: (target: TerminalLogicalTarget, previousConnection: string | null, foreignOwner?: boolean) => TerminalLogicalFloorGrant
  runOrderedInput: <T>(handle: string, requestKey: string, operation: (resolveOnly: boolean) => Promise<T>) => Promise<T>
}>
export type TerminalLogicalTarget = Readonly<{handle: string; sessionId: string; mode: 'AGENT_CHAT_COMPAT' | 'RAW_TERMINAL'}>
export type TerminalLogicalFloorGrant = Readonly<{assertCurrent: () => void; commit: () => void; rollbackConfirmed: () => void}>
type Connection = { pairedDeviceId: string; fingerprint: string | null; invalidated: boolean }
type LogicalOwner = {target: TerminalLogicalTarget; connection: string; device: string; fingerprint: string; committed: boolean}
type InputLane = {tail: Promise<void>; uncertainKey: string | null}
class TerminalInputOrderError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code }
}

/** Absence is unknown. Tombstones are created only by an actual owner hook.
 * A fresh server incarnation never claims an old socket terminated; it only
 * lets the same device and caller take over that socket's floor, and the PG
 * floor CAS then rejects any late write through the old binding. */
export class TerminalConnectionOwner {
  private readonly incarnation = randomUUID()
  private readonly connections = new Map<string, Connection>()
  private readonly logicalFloors = new Map<string, LogicalOwner>()
  private readonly inputLanes = new Map<string, InputLane>()
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
        // A connection of an earlier server process cannot write through this
        // process at all; after a backend restart or Serve failover the same
        // device and caller may take its floor over (the draft revision CAS
        // still orders it). Within this process the old connection must be
        // invalidated explicitly.
        if (!previous.startsWith(prefix)) {
          if (device !== pairedDeviceId || principal !== fingerprint) { throw new Error('TERMINAL_PREVIOUS_CONNECTION_INVALIDATION_UNPROVEN') }
          return
        }
        const old = this.connections.get(previous.slice(prefix.length))
        if (!old || !old.invalidated || old.pairedDeviceId !== device || old.fingerprint !== principal ||
            device !== pairedDeviceId || principal !== fingerprint) { throw new Error('TERMINAL_PREVIOUS_CONNECTION_INVALIDATION_UNPROVEN') }
    }
    return Object.freeze({ connectionIncarnation, pairedDeviceId, authenticatedCallerFingerprint: fingerprint, assertCurrent,
      assertPreviousInvalidated,
      runOrderedInput: <T>(handle: string, requestKey: string, operation: (resolveOnly: boolean) => Promise<T>): Promise<T> => {
        assertCurrent()
        if (!handle || !requestKey) { throw new TerminalInputOrderError('TERMINAL_ORDER_IDENTITY_REQUIRED') }
        // Enqueue synchronously, before the adapter's first database await. A
        // reconnect of this same owner shares the lane; unrelated handles do not.
        const key = JSON.stringify([handle, pairedDeviceId, fingerprint])
        let lane = this.inputLanes.get(key)
        if (!lane) { lane = {tail: Promise.resolve(), uncertainKey: null}; this.inputLanes.set(key, lane) }
        const originalLane = lane
        const result = originalLane.tail.then(async () => {
          assertCurrent()
          if (originalLane.uncertainKey !== null && originalLane.uncertainKey !== requestKey) {
            throw new TerminalInputOrderError('TERMINAL_PRIOR_COMMIT_UNCERTAIN')
          }
          const resolveOnly = originalLane.uncertainKey === requestKey
          try {
            const value = await operation(resolveOnly)
            if (resolveOnly) { originalLane.uncertainKey = null }
            return value
          } catch (error) {
            const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
            if (code === 'TERMINAL_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY' || code === 'TERMINAL_FLOOR_COMMIT_UNCERTAIN') {
              originalLane.uncertainKey = requestKey
            }
            throw error
          }
        })
        originalLane.tail = result.then(() => undefined, () => undefined)
        return result
      },
      reserveLogicalFloor: (target: TerminalLogicalTarget, previousConnection: string | null, foreignOwner = false): TerminalLogicalFloorGrant => {
        assertCurrent()
        if (!target.handle || !target.sessionId || !['AGENT_CHAT_COMPAT', 'RAW_TERMINAL'].includes(target.mode)) { throw new Error('TERMINAL_LOGICAL_TARGET_REQUIRED') }
        const fixed = Object.freeze({...target}), prior = this.logicalFloors.get(target.handle)
        if (prior && prior.target.sessionId !== fixed.sessionId) { throw new Error('TERMINAL_LOGICAL_FLOOR_OWNED') }
        // Another device or caller sending to the same session takes the floor
        // over (last sender wins); it must name the floor it read from PG.
        const takeover = foreignOwner || !!prior && (prior.device !== pairedDeviceId || prior.fingerprint !== fingerprint || prior.target.mode !== fixed.mode)
        if (takeover && (previousConnection === null || prior && prior.connection !== previousConnection)) { throw new Error('TERMINAL_LOGICAL_FLOOR_OWNED') }
        if (previousConnection === null && prior) { throw new Error('TERMINAL_LOGICAL_FLOOR_ALREADY_RESERVED') }
        if (previousConnection !== null) {
          // An earlier process's floor has no in-memory owner here; the PG
          // floor reattach checks it was the same device and principal.
          const earlier = !previousConnection.startsWith(`${this.incarnation}:`)
          if (earlier ? prior && prior.connection !== previousConnection : !prior || prior.connection !== previousConnection) {
            throw new Error('TERMINAL_LOGICAL_FLOOR_GRANT_UNPROVEN')
          }
          if (previousConnection !== connectionIncarnation && !takeover && !foreignOwner) { assertPreviousInvalidated(previousConnection, pairedDeviceId, fingerprint) }
        }
        const next: LogicalOwner = prior?.connection === connectionIncarnation && !takeover ? prior : {
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
