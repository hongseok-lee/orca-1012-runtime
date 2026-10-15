import { randomUUID } from 'node:crypto'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import { HoldParams } from '../../runtime/rpc/methods/structured-agent-session-schemas'
import { isStructuredNativeChatEnabled, supportsStructuredAgentSessionCapability,
  supportsStructuredAgentSessions } from '../../runtime/rpc/methods/structured-agent-session-policy'
import { captureCatalogReadContext } from './context.ts'
import { CatalogReadError, type CapturedCatalogReadConfig } from './config.ts'
import { createCatalogStructuredHoldResolver } from './structured-hold-resolution.ts'

type Hold = { close(): void }

/** Adapter-owned observation registration. It is not a lease, activity or provider hold. */
export function createCatalogStructuredHolds(config: CapturedCatalogReadConfig) {
  const resolve = createCatalogStructuredHoldResolver(config)
  const holds = new Map<string, Hold>()
  let disposed = false

  function capture(params: unknown, context: RpcContext, cleanup: boolean) {
    const input = Object.freeze(HoldParams.parse(params))
    const runtime = context.runtime, fingerprint = context.authenticatedCallerFingerprint
    const clientKind = context.clientKind, capabilities = Object.freeze([...(context.clientCapabilities ?? [])])
    const connectionId = context.connectionId, signal = context.signal
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new CatalogReadError('CATALOG_AUTHENTICATED_CALLER_REQUIRED')
    }
    const structuredNativeChatEnabled = cleanup ? false : isStructuredNativeChatEnabled({
      getClientSettings: runtime.getClientSettings.bind(runtime) })
    const policy = { clientKind, clientCapabilities: capabilities, structuredNativeChatEnabled }
    if (!(cleanup ? supportsStructuredAgentSessionCapability(policy) : supportsStructuredAgentSessions(policy))) {
      throw new CatalogReadError('structured_agent_session_unsupported')
    }
    const key = JSON.stringify([connectionId === undefined ? ['local'] : ['connection', connectionId],
      fingerprint, input.sessionId, input.holderId])
    return { input, runtime, fingerprint, clientKind, capabilities, connectionId, signal, key }
  }

  async function hold(params: unknown, context: RpcContext): Promise<{ held: true }> {
    if (disposed) { throw new CatalogReadError('CATALOG_ADAPTER_DISPOSED') }
    const caller = capture(params, context, false)
    const call = captureCatalogReadContext(config, { runtime: caller.runtime,
      authenticatedCallerFingerprint: caller.fingerprint, clientKind: caller.clientKind, clientCapabilities: caller.capabilities })
    const runtime = caller.runtime
    const registerOwned = typeof runtime.registerOwnedSubscriptionCleanup === 'function'
      ? runtime.registerOwnedSubscriptionCleanup.bind(runtime) : null
    const register = runtime.registerSubscriptionCleanup.bind(runtime), cleanup = runtime.cleanupSubscription.bind(runtime)
    holds.get(caller.key)?.close()
    // Unique registration identity contains neither raw credentials nor their fingerprint.
    const id = `catalog-structured-hold:${randomUUID()}`
    let closed = false
    let retire = (): void => { if (holds.get(caller.key) === record) { cleanup(id) } }
    const record: Hold = { close() {
      if (closed) { return }
      closed = true
      caller.signal?.removeEventListener('abort', close)
      const release = retire
      retire = () => {}
      try { release() } finally { if (holds.get(caller.key) === record) { holds.delete(caller.key) } }
    } }
    const close = (): void => record.close()
    holds.set(caller.key, record)
    try {
      if (registerOwned) {
        const registration = registerOwned(id, close, caller.connectionId)
        retire = registration.releaseIfCurrent.bind(registration)
      } else { register(id, close, caller.connectionId) }
      if (closed) { retire(); throw new CatalogReadError('STRUCTURED_HOLD_CLOSED') }
      caller.signal?.addEventListener('abort', close, { once: true })
      if (caller.signal?.aborted) { throw new CatalogReadError('STRUCTURED_HOLD_CLOSED') }
      await resolve(caller.input.sessionId, call.authority)
      if (disposed) { throw new CatalogReadError('CATALOG_ADAPTER_DISPOSED') }
      if (closed || holds.get(caller.key) !== record || caller.signal?.aborted) {
        throw new CatalogReadError('STRUCTURED_HOLD_CLOSED')
      }
      return { held: true }
    } catch (error) { record.close(); throw error }
  }

  function release(params: unknown, context: RpcContext): { released: true } {
    if (disposed) { throw new CatalogReadError('CATALOG_ADAPTER_DISPOSED') }
    const caller = capture(params, context, true)
    holds.get(caller.key)?.close()
    return { released: true }
  }

  function dispose(): void {
    if (disposed) { return }
    disposed = true
    for (const record of Array.from(holds.values())) { record.close() }
  }
  return Object.freeze({ hold, release, dispose })
}
