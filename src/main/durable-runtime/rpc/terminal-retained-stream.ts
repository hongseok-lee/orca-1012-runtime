import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import type { TerminalStreamSource } from './terminal-runtime-stream.ts'
import { withDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { projectTerminalDisplay } from '../terminal/display-projection.ts'
import { resolveCatalogTerminalTarget } from './terminal-target.ts'
import { TerminalDraftStoreError } from '../terminal/durable-contracts.ts'

/** A display-only source for Pod0/disconnection. Reading journaled output never
 * obtains a live action, updates work activity, or wakes a process. */
export function retainedTerminalStream(config: CapturedCatalogReadConfig, context: RpcContext, terminal: string,
  target: NonNullable<Awaited<ReturnType<typeof resolveCatalogTerminalTarget>>>, viewport?: { cols: number; rows: number }): TerminalStreamSource {
  let bytes = Buffer.alloc(0), retainedTruncated = false
  let incarnationId: string = target.sessionId
  const current = () => {
    config.assertCurrentHost()
    if (context.signal?.aborted) { throw new TerminalDraftStoreError('TERMINAL_SUBSCRIPTION_ABORTED') }
  }
  return Object.freeze({ key: `retained:${target.sessionId}:${target.sessionFence}`, reader: {
    async status() {
      current()
      await withDurableTransaction(config.pool, async tx => {
        await lockAggregates(tx, { sessionIds: [target.sessionId] })
        const fresh = await resolveCatalogTerminalTarget(tx, config, context, terminal, current)
        if (!fresh || fresh.lifecycle !== 'OPEN' || fresh.chat || fresh.sessionId !== target.sessionId || fresh.sessionFence !== target.sessionFence) {
          throw new TerminalDraftStoreError('TERMINAL_CATALOG_TARGET_CHANGED')
        }
        const display = await projectTerminalDisplay(tx, target.sessionId)
        retainedTruncated = display.truncated
        incarnationId = display.current ? display.sources[display.current].incarnation : target.sessionId
        // The retained projection is scrollback text, not a claimed VT screen.
        bytes = Buffer.from([...display.lines, ...(display.partial ? [display.partial] : [])].join('\r\n'))
      })
      current()
      return { incarnationId, cols: viewport?.cols ?? 80, rows: viewport?.rows ?? 24, live: false, retainedTruncated }
    },
    async read(expected: string, fromByte: number) {
      current()
      if (expected !== incarnationId || !Number.isSafeInteger(fromByte) || fromByte < 0 || fromByte > bytes.length) {
        throw new TerminalDraftStoreError('TERMINAL_OUTPUT_INVALID')
      }
      return { incarnationId, startByte: fromByte, endByte: bytes.length, bytes: bytes.subarray(fromByte).toString('base64'), live: false, truncated: false }
    }
  } })
}
