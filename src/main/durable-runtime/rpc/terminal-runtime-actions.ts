import { isTerminalQueryReply } from '../../../shared/terminal-query-reply.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import type { TerminalRuntimeLookup } from '../input/runtime-input-types.ts'
import type { resolveCatalogTerminalTarget } from './terminal-target.ts'
import { pinTerminalRuntime } from '../runtime/terminal-runtime-reader.ts'
import { assertCatalogTerminalRuntime } from './terminal-runtime-read.ts'
import { claimCatalogRawFloor } from './terminal-raw-floor.ts'
import { writeRawTerminal, readRawTerminalResult } from '../terminal/raw-write.ts'
import { TerminalDraftStoreError } from '../terminal/durable-contracts.ts'
import { withDurableTransaction } from '../db/connection.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { assertTerminalFloorPin, readTerminalFloorInTransaction } from '../terminal/floor-repository.ts'

/** Created with the subscription's original ready owner. Raw controls cannot
 * acquire a new execution, enqueue a wake or turn bytes into a Chat Message. */
export function createCatalogTerminalActions(config: CapturedCatalogReadConfig, context: RpcContext, terminal: string,
  target: NonNullable<Awaited<ReturnType<typeof resolveCatalogTerminalTarget>>>, lookup: TerminalRuntimeLookup) {
  const pin = pinTerminalRuntime(target.sessionId, lookup), connection = context.terminalInputConnection
  let active = true
  const assertCurrent = () => {
    config.assertCurrentHost()
    if (!active || !connection || context.signal?.aborted || connection.pairedDeviceId !== context.pairedDeviceId ||
        connection.authenticatedCallerFingerprint !== context.authenticatedCallerFingerprint) {
      throw new TerminalDraftStoreError('TERMINAL_AUTHENTICATED_CONNECTION_REQUIRED')
    }
    connection.assertCurrent(); pin.current()
  }
  const authorize = (tx: DurableTransaction) => {
    assertCurrent()
    return assertCatalogTerminalRuntime(tx, config, context, terminal, target, pin.current(), assertCurrent)
  }
  async function floor(protocolReply = false) {
    await withDurableTransaction(config.pool, authorize)
    if (protocolReply) {
      const held = await withDurableTransaction(config.pool, async tx => {
        await lockAggregates(tx, { sessionIds: [target.sessionId] })
        const expected = { logicalHandle: terminal, sessionId: target.sessionId, mode: 'RAW_TERMINAL' as const,
          connectionId: connection!.connectionIncarnation, pairedDeviceId: connection!.pairedDeviceId,
          principalId: fingerprintAttachmentPrincipal(connection!.authenticatedCallerFingerprint), floorGeneration: '0' }
        const actual = await readTerminalFloorInTransaction(tx, expected)
        if (!actual || actual.binding.mode !== expected.mode || actual.binding.connectionId !== expected.connectionId ||
            actual.binding.principalId !== expected.principalId || actual.binding.pairedDeviceId !== expected.pairedDeviceId) {
          throw new TerminalDraftStoreError('TERMINAL_QUERY_REPLY_NOT_OWNER')
        }
        return actual
      })
      return Object.freeze({ floor: held, assertCurrent })
    }
    return claimCatalogRawFloor(config, context, terminal, target, assertCurrent)
  }
  return Object.freeze({
    close: () => { active = false },
    write(incarnationId: string, bytes: Uint8Array, requestKey: string, alreadyOrdered = false) {
      const captured = bytes.slice()
      assertCurrent()
      const execute = async (resolveOnly: boolean) => {
        await withDurableTransaction(config.pool, authorize)
        const previous = await readRawTerminalResult(config.pool, terminal,
          fingerprintAttachmentPrincipal(connection!.authenticatedCallerFingerprint), connection!.connectionIncarnation, requestKey, captured)
        if (previous) { return previous }
        if (resolveOnly) { throw new TerminalDraftStoreError('TERMINAL_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY') }
        const held = await floor(isTerminalQueryReply(Buffer.from(captured).toString('utf8')))
        return writeRawTerminal(config.pool, { binding: pin.current().binding, floor: held.floor,
          incarnationId, requestKey, bytes: captured,
          assertCurrent: async tx => { held.assertCurrent(); await authorize(tx); held.assertCurrent() },
          write: (id, encoded) => {
            held.assertCurrent()
            return pin.current().terminal!.request('PTY_WRITE', { incarnationId, requestId: id, bytes: encoded })
          } })
      }
      // terminal.send already holds this exact connection's ordered lane.
      return alreadyOrdered ? execute(false) : connection!.runOrderedInput(terminal, requestKey, execute)
    },
    resize(incarnationId: string, cols: number, rows: number, requestKey: string) {
      assertCurrent()
      if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || cols > 1000 || rows < 1 || rows > 500) {
        throw new TerminalDraftStoreError('AGENT_TERMINAL_VIEWPORT')
      }
      return connection!.runOrderedInput(terminal, requestKey, async resolveOnly => {
        if (resolveOnly) { throw new TerminalDraftStoreError('TERMINAL_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY') }
        const held = await floor(), b = pin.current().binding
        return withDurableTransaction(config.pool, async tx => {
          await lockAggregates(tx, { sessionIds: [b.sessionId], runtimeUnitIds: [b.runtimeUnitId] })
          await authorize(tx); held.assertCurrent()
          assertTerminalFloorPin(await readTerminalFloorInTransaction(tx, held.floor.binding), held.floor)
          return pin.current().terminal!.request('PTY_RESIZE', { incarnationId, cols, rows })
        })
      })
    }
  })
}
