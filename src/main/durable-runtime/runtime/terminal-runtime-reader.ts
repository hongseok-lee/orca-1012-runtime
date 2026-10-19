import type { ReadyTerminalInputPort, TerminalRuntimeLookup } from '../input/runtime-input-types.ts'

const unavailable = (): never => { throw new Error('TERMINAL_RUNTIME_UNAVAILABLE') }

/** Pin one existing control. The caller supplies the
 * authenticated Catalog/PG guard; routing is not authority. A replacement
 * execution requires a fresh physical pin, never retargeting existing actions. */
export function pinTerminalRuntime(sessionId: string, lookup: TerminalRuntimeLookup) {
  const initial = lookup(sessionId), terminal = initial?.terminal
  if (!initial || initial.binding.sessionId !== sessionId || !terminal?.supported()) { return unavailable() }
  const binding = initial.binding, controller = initial.context.controller
  function current(): ReadyTerminalInputPort {
    const port = lookup(sessionId), next = port?.binding, owner = port?.context.controller
    if (!port || !next || !owner || port.terminal !== terminal || !terminal?.supported() ||
        next.sessionId !== binding.sessionId || next.tabId !== binding.tabId ||
        next.terminalHandle !== binding.terminalHandle || next.providerBindingRevision !== binding.providerBindingRevision ||
        next.runtimeUnitId !== binding.runtimeUnitId || next.attemptId !== binding.attemptId ||
        next.podUid !== binding.podUid || next.executionEpoch !== binding.executionEpoch ||
        next.connectionInstanceId !== binding.connectionInstanceId ||
        owner.scope !== controller.scope || owner.owner !== controller.owner || owner.term !== controller.term) {
      return unavailable()
    }
    return port
  }
  return Object.freeze({ current })
}

export function borrowTerminalRuntimeReader(sessionId: string, lookup: TerminalRuntimeLookup,
  assertAuthorized: (port: ReadyTerminalInputPort) => Promise<void>) {
  const { current } = pinTerminalRuntime(sessionId, lookup)
  const terminal = current().terminal!
  async function request(method: 'PTY_STATUS' | 'PTY_READ', params?: Record<string, unknown>): Promise<unknown> {
    await assertAuthorized(current())
    current()
    const result = await terminal!.request(method, params)
    await assertAuthorized(current())
    current()
    return result
  }
  return Object.freeze({
    status: () => request('PTY_STATUS'),
    read: (incarnationId: string, fromByte: number) => request('PTY_READ', { incarnationId, fromByte })
  })
}
