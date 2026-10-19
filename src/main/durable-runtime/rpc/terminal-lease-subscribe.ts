import type { TerminalRuntimeLookup } from '../input/runtime-input-types.ts'
import { createCatalogTerminalRuntimeReader } from './terminal-runtime-read.ts'
import { streamCatalogTerminal } from './terminal-runtime-stream.ts'
import { TerminalSubscribe } from '../../../shared/rpc-contract/terminal-stream-params.ts'
import type { RpcContext, RpcStreamingMethodDeclaration } from '../../runtime/rpc/core.ts'
import { capturedJson } from '../structured/durable-common.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { withDurableTransaction } from '../db/connection.ts'
import { resolveCatalogTerminalTarget } from './terminal-target.ts'
import { TerminalDraftStoreError } from '../terminal/durable-contracts.ts'

/** Chat retains its logical input lease. Raw Terminal borrows the existing
 * Agent PTY; observation never wakes or replaces a runtime. */
export function createCatalogTerminalLeaseSubscribe(config: CapturedCatalogReadConfig, lookup?: TerminalRuntimeLookup) {
  return async (original: unknown, context: RpcContext, emit: (frame: unknown) => void,
    legacy: RpcStreamingMethodDeclaration['handler']): Promise<void> => {
    const params = TerminalSubscribe.parse(capturedJson(original))
    const capturedContext = { ...context, clientCapabilities: Object.freeze([...(context.clientCapabilities ?? [])]) }
    const assertCurrent = () => {
      config.assertCurrentHost()
      if (capturedContext.signal?.aborted) { throw new TerminalDraftStoreError('TERMINAL_SUBSCRIPTION_ABORTED') }
    }
    assertCurrent()
    const found = await withDurableTransaction(config.pool,
      tx => resolveCatalogTerminalTarget(tx, config, capturedContext, params.terminal, assertCurrent))
    assertCurrent()
    if (!found) { return legacy(params as never, capturedContext, emit) }
    if (found.lifecycle !== 'OPEN') { throw new TerminalDraftStoreError('TERMINAL_CATALOG_TARGET_CLOSED') }
    if (found.chat) { return holdCatalogTerminalInputLease(params, capturedContext, emit) }
    if (!lookup) { throw new TerminalDraftStoreError('TERMINAL_RUNTIME_UNAVAILABLE') }
    const reader = createCatalogTerminalRuntimeReader(config, capturedContext, params.terminal, found, lookup)
    return streamCatalogTerminal(params, capturedContext, emit, reader)
  }
}

/** Owns stream cleanup only; the caller must resolve Catalog access first. */
export async function holdCatalogTerminalInputLease(params: ReturnType<typeof TerminalSubscribe.parse>,
  context: RpcContext, emit: (frame: unknown) => void): Promise<void> {
    const subscriptionId = params.client?.id ? `${params.terminal}:${params.client.id}` : params.terminal
    const signal = context.signal
    await new Promise<void>(resolve => {
      let ended = false
      const onAbort = (): void => registration.releaseIfCurrent()
      const end = (): void => {
        if (ended) { return }
        ended = true
        signal?.removeEventListener('abort', onAbort)
        try { emit({ type: 'end' }) } catch { /* the connection is already gone */ }
        resolve()
      }
      // Same key and owner rules as the original lease, so terminal.unsubscribe retires it.
      const registration = context.runtime.registerOwnedSubscriptionCleanup(subscriptionId, end, context.connectionId)
      if (signal?.aborted) { registration.releaseIfCurrent(); return }
      signal?.addEventListener('abort', onAbort, { once: true })
      emit({ type: 'subscribed', streamId: null, lines: [], truncated: false })
    })
}
