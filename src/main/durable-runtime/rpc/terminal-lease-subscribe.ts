import { TerminalSubscribe } from '../../../shared/rpc-contract/terminal-stream-params.ts'
import type { RpcContext, RpcStreamingMethodDeclaration } from '../../runtime/rpc/core.ts'
import { capturedJson } from '../structured/durable-common.ts'
import type { CapturedCatalogReadConfig } from './config.ts'

/** A durable terminal tab has no PTY in this process: its provider runs in the
 * Agent Pod and chat renders the journaled native transcript. Subscribing only
 * acknowledges the client's input lease; input itself goes through
 * terminal.send and the durable floor. The stream stays open until the client
 * unsubscribes or its connection ends. Other handles keep the original owner. */
export function createCatalogTerminalLeaseSubscribe(config: CapturedCatalogReadConfig) {
  return async (original: unknown, context: RpcContext, emit: (frame: unknown) => void,
    legacy: RpcStreamingMethodDeclaration['handler']): Promise<void> => {
    const params = TerminalSubscribe.parse(capturedJson(original))
    config.assertCurrentHost()
    const found = await config.pool.query(
      "SELECT 1 FROM durable_runtime.tabs WHERE terminal_handle=$1 AND kind='terminal' AND lifecycle='OPEN'", [params.terminal])
    if (found.rowCount === 0) { return legacy(params as never, context, emit) }
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
}
