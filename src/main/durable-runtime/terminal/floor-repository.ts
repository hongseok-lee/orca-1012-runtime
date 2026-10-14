import type { DurableTransaction } from '../db/connection.ts'
import type { QueryResultRow } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { requireInputSessionLock } from '../input/composition.ts'
import { snapshotDraftBinding } from './ingress'
import { sameTerminalDraftBinding } from './draft-reducer'
import { terminalCounter, TerminalDraftStoreError, assertSynchronousTerminalAuthorization } from './durable-contracts'
import type { TerminalFloorAuthorization, TerminalFloorPin } from './durable-contracts'
import type { TerminalDraftBinding } from './types'

// The authoritative 018 row export is joined only after its owner's exact pin arrives.
// Until then this entry maps a pg result to the existing domain binding, not a copied DB row type.
function floorPin(row: QueryResultRow): TerminalFloorPin {
  return Object.freeze({ binding: snapshotDraftBinding({
    logicalHandle: row.terminal_handle, sessionId: row.session_id,
    pairedDeviceId: row.paired_device_id, principalId: row.principal_id,
    connectionId: row.connection_id, mode: row.mode,
    floorGeneration: terminalCounter(row.floor_generation)
  }), revision: terminalCounter(row.revision) })
}

export async function readTerminalFloorInTransaction(
  tx: DurableTransaction,
  binding: TerminalDraftBinding
): Promise<TerminalFloorPin | null> {
  const pin = snapshotDraftBinding(binding)
  requireInputSessionLock(tx, logicalId('session', pin.sessionId))
  const result = await tx.query(
    'SELECT * FROM durable_runtime.terminal_input_floors WHERE terminal_handle=$1 AND session_id=$2',
    [pin.logicalHandle, pin.sessionId]
  )
  return result.rows[0] ? floorPin(result.rows[0]) : null
}

export function snapshotTerminalFloorPin(pin: TerminalFloorPin): TerminalFloorPin {
  const binding = snapshotDraftBinding(pin.binding)
  terminalCounter(binding.floorGeneration)
  return Object.freeze({ binding, revision: terminalCounter(pin.revision) })
}

export function assertTerminalFloorPin(actual: TerminalFloorPin | null, expected: TerminalFloorPin): void {
  if (!actual || actual.revision !== expected.revision ||
    !sameTerminalDraftBinding(actual.binding, expected.binding)) {
    throw new TerminalDraftStoreError('TERMINAL_STALE_FLOOR')
  }
}

/** An authenticated grant is a prerequisite. This SQL-only entry never issues one. */
export async function claimTerminalFloorInTransaction(
  tx: DurableTransaction,
  nextBinding: TerminalDraftBinding,
  expected: TerminalFloorPin | null,
  authorization: TerminalFloorAuthorization
): Promise<TerminalFloorPin> {
  const next = snapshotDraftBinding(nextBinding)
  terminalCounter(next.floorGeneration)
  const previous = expected ? snapshotTerminalFloorPin(expected) : null
  const check = authorization.assertClaimAllowed.bind(authorization)
  const authorize = (candidate: TerminalDraftBinding, old: TerminalFloorPin | null): void =>
    assertSynchronousTerminalAuthorization(check(candidate, old))
  requireInputSessionLock(tx, logicalId('session', next.sessionId))
  authorize(next, previous)
  if (previous && (next.logicalHandle !== previous.binding.logicalHandle ||
    next.sessionId !== previous.binding.sessionId)) {
    throw new TerminalDraftStoreError('TERMINAL_FLOOR_IDENTITY')
  }
  const actual = await readTerminalFloorInTransaction(tx, next)
  authorize(next, previous)
  if (previous) {
    assertTerminalFloorPin(actual, previous)
  } else if (actual) {
    throw new TerminalDraftStoreError('TERMINAL_STALE_FLOOR')
  }
  const target = await tx.query(
    `SELECT t.id FROM durable_runtime.tabs t JOIN durable_runtime.sessions s ON s.id=t.session_id
     WHERE t.terminal_handle=$1 AND t.session_id=$2 AND t.lifecycle='OPEN' AND s.lifecycle='OPEN'`,
    [next.logicalHandle, next.sessionId]
  )
  authorize(next, previous)
  if (target.rowCount !== 1) {
    throw new TerminalDraftStoreError('TERMINAL_FLOOR_TARGET')
  }
  let result
  if (!previous) {
    result = await tx.query(
      `INSERT INTO durable_runtime.terminal_input_floors(terminal_handle,session_id,floor_generation,
       revision,principal_id,paired_device_id,connection_id,mode,updated_at)
       VALUES($1,$2,$3,0,$4,$5,$6,$7,clock_timestamp()) ON CONFLICT DO NOTHING RETURNING *`,
      [next.logicalHandle, next.sessionId, next.floorGeneration, next.principalId,
        next.pairedDeviceId, next.connectionId, next.mode]
    )
  } else {
    const old = previous.binding
    const changedOwnerOrMode = old.principalId !== next.principalId ||
      old.pairedDeviceId !== next.pairedDeviceId || old.mode !== next.mode
    if (BigInt(next.floorGeneration) < BigInt(old.floorGeneration) ||
      (changedOwnerOrMode && BigInt(next.floorGeneration) <= BigInt(old.floorGeneration))) {
      throw new TerminalDraftStoreError('TERMINAL_FLOOR_GENERATION')
    }
    if (next.floorGeneration === old.floorGeneration && next.connectionId !== old.connectionId) {
      throw new TerminalDraftStoreError('TERMINAL_REATTACH_REQUIRED')
    }
    if (sameTerminalDraftBinding(old, next)) {
      return previous
    }
    result = await tx.query(
      `UPDATE durable_runtime.terminal_input_floors SET floor_generation=$4,principal_id=$5,
       paired_device_id=$6,connection_id=$7,mode=$8,revision=revision+1,updated_at=clock_timestamp()
       WHERE terminal_handle=$1 AND session_id=$2 AND revision=$3 RETURNING *`,
      [next.logicalHandle, next.sessionId, previous.revision, next.floorGeneration,
        next.principalId, next.pairedDeviceId, next.connectionId, next.mode]
    )
  }
  authorize(next, previous)
  if (result.rowCount !== 1) {
    throw new TerminalDraftStoreError('TERMINAL_STALE_FLOOR')
  }
  return floorPin(result.rows[0])
}

/** Used by explicit reattach after both floor and legacy draft were checked. */
export async function changeTerminalFloorConnectionInTransaction(
  tx: DurableTransaction,
  previous: TerminalFloorPin,
  nextConnectionId: string,
  assertOriginalReattach: (previous: TerminalFloorPin, nextConnectionId: string) => void
): Promise<TerminalFloorPin> {
  const pin = snapshotTerminalFloorPin(previous)
  requireInputSessionLock(tx, logicalId('session', pin.binding.sessionId))
  if (!nextConnectionId || nextConnectionId === pin.binding.connectionId) {
    throw new TerminalDraftStoreError('TERMINAL_REATTACH_CONNECTION')
  }
  assertOriginalReattach(pin, nextConnectionId)
  const result = await tx.query(
    `UPDATE durable_runtime.terminal_input_floors SET connection_id=$4,revision=revision+1,
     updated_at=clock_timestamp() WHERE terminal_handle=$1 AND session_id=$2 AND revision=$3
     AND floor_generation=$5 AND principal_id=$6 AND paired_device_id=$7 AND mode=$8
     AND connection_id=$9 RETURNING *`,
    [pin.binding.logicalHandle, pin.binding.sessionId, pin.revision, nextConnectionId,
      pin.binding.floorGeneration, pin.binding.principalId, pin.binding.pairedDeviceId,
      pin.binding.mode, pin.binding.connectionId]
  )
  assertOriginalReattach(pin, nextConnectionId)
  if (result.rowCount !== 1) {
    throw new TerminalDraftStoreError('TERMINAL_STALE_FLOOR')
  }
  return floorPin(result.rows[0])
}
