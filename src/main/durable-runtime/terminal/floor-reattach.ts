import type { DurableTransaction } from '../db/connection.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { requireInputSessionLock } from '../input/composition.ts'
import { readTerminalDraftInTransaction, saveTerminalDraftInTransaction } from './draft-repository'
import { rebindStoredTerminalDraft } from './durable-codec'
import type { StoredTerminalDraft } from './durable-codec'
import { TerminalDraftStoreError, terminalCounter, assertSynchronousTerminalAuthorization } from './durable-contracts'
import type { TerminalFloorPin, TerminalFloorAuthorization } from './durable-contracts'
import {
  assertTerminalFloorPin, readTerminalFloorInTransaction,
  snapshotTerminalFloorPin, changeTerminalFloorConnectionInTransaction
} from './floor-repository'

export async function reattachTerminalFloorInTransaction(
  tx: DurableTransaction,
  request: Readonly<{ previous: TerminalFloorPin; nextConnectionId: string; expectedDraftRevision: string }>,
  authorization: TerminalFloorAuthorization
): Promise<Readonly<{ floor: TerminalFloorPin; draft: StoredTerminalDraft | null }>> {
  const previous = snapshotTerminalFloorPin(request.previous)
  const nextConnectionId = request.nextConnectionId
  const expectedDraftRevision = terminalCounter(request.expectedDraftRevision)
  const check = authorization.assertReattachAllowed.bind(authorization)
  const authorize = (original: TerminalFloorPin, next: string): void =>
    assertSynchronousTerminalAuthorization(check(original, next))
  requireInputSessionLock(tx, logicalId('session', previous.binding.sessionId))
  if (!nextConnectionId || nextConnectionId === previous.binding.connectionId) {
    throw new TerminalDraftStoreError('TERMINAL_REATTACH_CONNECTION')
  }
  authorize(previous, nextConnectionId)
  const actual = await readTerminalFloorInTransaction(tx, previous.binding)
  authorize(previous, nextConnectionId)
  assertTerminalFloorPin(actual, previous)
  const original = await readTerminalDraftInTransaction(tx, previous.binding)
  authorize(previous, nextConnectionId)
  if ((original?.draft.revision ?? '0') !== expectedDraftRevision) {
    throw new TerminalDraftStoreError('TERMINAL_STALE_DRAFT_REVISION')
  }
  const floor = await changeTerminalFloorConnectionInTransaction(tx, previous, nextConnectionId, authorize)
  authorize(previous, nextConnectionId)
  const draft = original ? await saveTerminalDraftInTransaction(tx,
    rebindStoredTerminalDraft(original, floor.binding, expectedDraftRevision), expectedDraftRevision, true) : null
  authorize(previous, nextConnectionId)
  return Object.freeze({ floor, draft })
}
