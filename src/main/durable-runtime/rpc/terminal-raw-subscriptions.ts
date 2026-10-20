import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { TerminalSend } from '../../../shared/rpc-contract/terminal-unary-params.ts'
import type { createCatalogTerminalActions } from './terminal-runtime-actions.ts'
import { TerminalDraftStoreError } from '../terminal/durable-contracts.ts'
import { isTerminalQueryReply } from '../../../shared/terminal-query-reply.ts'
import { assertTerminalInputWithinLimit } from '../../../shared/terminal-input.ts'

type Actions = ReturnType<typeof createCatalogTerminalActions>
type Entry = { incarnationId: string; actions: Actions }
/** Only a successfully attached raw subscription supplies a unary target. A
 * stable handle alone never silently selects a replacement PTY for old input. */
export function createTerminalRawSubscriptions() {
  const bindings = new Map<string, Set<Entry>>()
  function key(terminal: string, context: RpcContext): string {
    const connection = context.terminalInputConnection
    if (!connection || connection.pairedDeviceId !== context.pairedDeviceId ||
        connection.authenticatedCallerFingerprint !== context.authenticatedCallerFingerprint) {
      throw new TerminalDraftStoreError('TERMINAL_AUTHENTICATED_CONNECTION_REQUIRED')
    }
    connection.assertCurrent()
    return JSON.stringify([terminal, connection.connectionIncarnation])
  }
  return Object.freeze({
    dispose() {
      for (const entries of bindings.values()) { for (const entry of entries) { entry.actions.close() } }
      bindings.clear()
    },
    attach(terminal: string, context: RpcContext, incarnationId: string, actions: Actions) {
      const id = key(terminal,context), entry = { incarnationId, actions }
      const held = bindings.get(id) ?? new Set<Entry>()
      held.add(entry); bindings.set(id,held)
      return () => { held.delete(entry); if (!held.size && bindings.get(id) === held) { bindings.delete(id) } }
    },
    async send(params: ReturnType<typeof TerminalSend.parse>, context: RpcContext) {
      const held = bindings.get(key(params.terminal,context))
      if (!held || held.size !== 1 || !context.requestId) { throw new TerminalDraftStoreError('TERMINAL_RAW_SUBSCRIPTION_REQUIRED') }
      const entry = [...held][0]
      if (params.expectedIncarnationId && params.expectedIncarnationId !== entry.incarnationId) {
        throw new TerminalDraftStoreError('TERMINAL_RAW_INCARNATION_CHANGED')
      }
      if (params.agentPrompt || params.resolvedLaunchDraft || params.requireAgentStatus ||
          params.inputKind === 'query-reply' && (!isTerminalQueryReply(params.text ?? '') || params.enter === true || params.interrupt === true)) {
        throw new TerminalDraftStoreError('TERMINAL_RAW_UNSUPPORTED_ACTION')
      }
      // Preserve the original terminal writer's text + CR + Ctrl-C ordering.
      const text = (params.text ?? '') + (params.enter === true ? '\r' : '') + (params.interrupt === true ? '\x03' : '')
      assertTerminalInputWithinLimit(text)
      const result = await entry.actions.write(entry.incarnationId, Buffer.from(text),
        JSON.stringify(['UNARY',context.requestId]), true)
      return { send: { handle: params.terminal, accepted: result.status === 'WRITTEN', bytesWritten: result.bytesWritten } }
    }
  })
}
