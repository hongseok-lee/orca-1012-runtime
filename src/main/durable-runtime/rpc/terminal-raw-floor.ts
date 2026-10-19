import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import type { TerminalDraftBinding } from '../terminal/types.ts'
import { sameTerminalDraftBinding } from '../terminal/draft-reducer.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { runDurableTransaction, withDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { claimTerminalFloorInTransaction, readTerminalFloorInTransaction } from '../terminal/floor-repository.ts'
import { assertManagedCatalogTarget } from '../terminal/catalog-target.ts'
import { TerminalDraftStoreError } from '../terminal/durable-contracts.ts'
import type { resolveCatalogTerminalTarget } from './terminal-target.ts'

export async function claimCatalogRawFloor(config: CapturedCatalogReadConfig, context: RpcContext, terminal: string,
  target: NonNullable<Awaited<ReturnType<typeof resolveCatalogTerminalTarget>>>, assertCurrent: () => void) {
  const connection = context.terminalInputConnection
  if (!connection || !context.authenticatedCallerFingerprint || !context.pairedDeviceId ||
      connection.authenticatedCallerFingerprint !== context.authenticatedCallerFingerprint ||
      connection.pairedDeviceId !== context.pairedDeviceId) { throw new TerminalDraftStoreError('TERMINAL_AUTHENTICATED_CONNECTION_REQUIRED') }
  const binding = (generation: string): TerminalDraftBinding => Object.freeze({
    logicalHandle: terminal, sessionId: target.sessionId, mode: 'RAW_TERMINAL',
    principalId: fingerprintAttachmentPrincipal(connection.authenticatedCallerFingerprint),
    pairedDeviceId: connection.pairedDeviceId, connectionId: connection.connectionIncarnation, floorGeneration: generation
  })
  const before = await withDurableTransaction(config.pool, async tx => {
    await lockAggregates(tx, { sessionIds: [target.sessionId] })
    assertCurrent(); connection.assertCurrent()
    return readTerminalFloorInTransaction(tx, binding('0'))
  })
  const owner = binding('0')
  const foreign = !!before && (before.binding.principalId !== owner.principalId ||
    before.binding.pairedDeviceId !== owner.pairedDeviceId || before.binding.mode !== owner.mode)
  const grant = connection.reserveLogicalFloor({ handle: terminal, sessionId: target.sessionId, mode: 'RAW_TERMINAL' },
    before?.binding.connectionId ?? null, foreign)
  // Raw bytes have no draft to reattach. Every connection/owner/mode change
  // advances the floor generation; old stream pins remain invalid forever.
  const changed = before && (foreign || before.binding.connectionId !== owner.connectionId)
  const next = binding(before ? (BigInt(before.binding.floorGeneration) + (changed ? 1n : 0n)).toString() : '0')
  const result = await runDurableTransaction(config.pool, async tx => {
    await lockAggregates(tx, { sessionIds: [target.sessionId] })
    const check = () => { assertCurrent(); connection.assertCurrent(); grant.assertCurrent() }
    check()
    await assertManagedCatalogTarget(tx, target.targetPin, next)
    return claimTerminalFloorInTransaction(tx, next, before, { assertClaimAllowed: check,
      assertReattachAllowed: () => { throw new TerminalDraftStoreError('TERMINAL_REATTACH_REQUIRED') } })
  })
  if (!result.ok) {
    if (result.commitOutcome === 'UNKNOWN') {
      // No raw effect has started. Taking the original Session lock again waits
      // for the uncertain transaction to finish; inspect its actual floor.
      const settled = await withDurableTransaction(config.pool, async tx => {
        await lockAggregates(tx, { sessionIds: [target.sessionId] })
        assertCurrent(); connection.assertCurrent(); grant.assertCurrent()
        return readTerminalFloorInTransaction(tx, next)
      })
      if (settled && sameTerminalDraftBinding(settled.binding, next)) {
        grant.commit()
        return Object.freeze({ floor: settled, assertCurrent: () => { assertCurrent(); connection.assertCurrent(); grant.assertCurrent() } })
      }
      grant.rollbackConfirmed()
      throw new TerminalDraftStoreError('TERMINAL_RAW_FLOOR_NOT_ACQUIRED')
    }
    if (result.settlement === 'ROLLED_BACK' || result.settlement === 'NOT_STARTED') { grant.rollbackConfirmed() }
    throw result.error
  }
  grant.commit()
  return Object.freeze({ floor: result.value, assertCurrent: () => { assertCurrent(); connection.assertCurrent(); grant.assertCurrent() } })
}
