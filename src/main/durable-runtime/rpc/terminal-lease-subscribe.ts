import { TerminalSubscribe } from '../../../shared/rpc-contract/terminal-stream-params.ts'
import type { RpcContext, RpcStreamingMethodDeclaration } from '../../runtime/rpc/core.ts'
import { capturedJson } from '../structured/durable-common.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { withDurableTransaction } from '../db/connection.ts'
import { resolveCatalogTerminalTarget } from './terminal-target.ts'
import { TerminalDraftStoreError } from '../terminal/durable-contracts.ts'

/** A durable terminal tab has no PTY in this process: its provider runs in the
 * Agent Pod and chat renders the journaled native transcript. Subscribing only
 * acknowledges the client's input lease; input itself goes through
 * terminal.send and the durable floor. The stream stays open until the client
 * unsubscribes or its connection ends. Other handles keep the original owner. */
export function createCatalogTerminalLeaseSubscribe(config: CapturedCatalogReadConfig) {
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
    return holdCatalogTerminalInputLease(params, capturedContext, emit)
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
