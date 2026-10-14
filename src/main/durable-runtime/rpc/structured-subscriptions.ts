import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session-wire'
import type {
  AgentSessionHistoryRequest, AgentSessionHistoryResult, AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { SubscribeParams, UnsubscribeParams } from '../../runtime/rpc/methods/structured-agent-session-schemas'
import {
  isStructuredNativeChatEnabled, supportsStructuredAgentSessionCapability, supportsStructuredAgentSessions
} from '../../runtime/rpc/methods/structured-agent-session-policy'
import {
  structuredAgentSessionSubscriptionBase, structuredAgentSessionSubscriptionId
} from '../../runtime/rpc/methods/structured-agent-session-subscription-id'
import { captureCatalogParsed } from '../catalog/immutable.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { CatalogReadError, catalogReadFailure } from './config.ts'
import { SharedSessionHeadHints } from './session-head-hints.ts'

/** Captured transport policy, not a PG scope/authority or a caller-selected DB identity. */
export type StructuredHistoryReadInput = Readonly<{
  sessionId: string
  authenticatedCallerFingerprint: string
  clientKind: RpcContext['clientKind']
  clientCapabilities: RpcContext['clientCapabilities']
  structuredNativeChatEnabled: boolean
}>
export type CapturedStructuredHistoryReader = (request: AgentSessionHistoryRequest) => Promise<AgentSessionHistoryResult>
export type StructuredHistoryReaderOwner = {
  capture(input: StructuredHistoryReadInput): CapturedStructuredHistoryReader
}
type Subscription = {
  id: string
  base: string
  fingerprint: string
  close(): void
  idle(): Promise<void>
}

/**
 * Internal composition boundary. PR67's captured RR reader is supplied by its owner after merge.
 * No fallback reader, copied history implementation, native host or public registry is installed here.
 */
export function createCatalogStructuredSubscriptions(
  config: CapturedCatalogReadConfig, historyOwner: StructuredHistoryReaderOwner
) {
  const captureReader = historyOwner.capture.bind(historyOwner)
  const hints = SharedSessionHeadHints.for(config)
  const subscriptions = new Map<string, Subscription>()
  let disposed = false

  function captureCaller(context: RpcContext, cleanup: boolean) {
    const runtime = context.runtime
    const clientKind = context.clientKind
    const clientCapabilities = context.clientCapabilities === undefined ? undefined : Object.freeze([...context.clientCapabilities])
    const fingerprint = context.authenticatedCallerFingerprint
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new CatalogReadError('CATALOG_AUTHENTICATED_CALLER_REQUIRED')
    }
    const getClientSettings = runtime.getClientSettings.bind(runtime)
    const structuredNativeChatEnabled = isStructuredNativeChatEnabled({ getClientSettings })
    const policy = { clientKind, clientCapabilities, structuredNativeChatEnabled }
    if (!(cleanup ? supportsStructuredAgentSessionCapability(policy) : supportsStructuredAgentSessions(policy))) {
      throw new CatalogReadError('structured_agent_session_unsupported')
    }
    const registerOwned = typeof runtime.registerOwnedSubscriptionCleanup === 'function'
      ? runtime.registerOwnedSubscriptionCleanup.bind(runtime) : null
    const register = runtime.registerSubscriptionCleanup.bind(runtime)
    const release = runtime.cleanupSubscription.bind(runtime)
    const report = context.reportSubscriptionError?.bind(context)
    const connectionId = context.connectionId, requestId = context.requestId, signal = context.signal
    return { runtime, fingerprint, clientKind, clientCapabilities, structuredNativeChatEnabled,
      registerOwned, register, release, report, connectionId, requestId, signal }
  }

  async function subscribe(params: unknown, context: RpcContext, emit: (event: AgentSessionSubscribeEvent) => void): Promise<void> {
    if (disposed) { throw new CatalogReadError('CATALOG_ADAPTER_DISPOSED') }
    // Parse/capture every mutable transport input and original receiver before the first await.
    const input = captureCatalogParsed(SubscribeParams.parse(params))
    const caller = captureCaller(context, false)
    const id = structuredAgentSessionSubscriptionId(context, input.sessionId)
    const base = structuredAgentSessionSubscriptionBase(context, input.sessionId)
    const read = captureReader(Object.freeze({ sessionId: input.sessionId,
      authenticatedCallerFingerprint: caller.fingerprint, clientKind: caller.clientKind,
      clientCapabilities: caller.clientCapabilities, structuredNativeChatEnabled: caller.structuredNativeChatEnabled }))
    subscriptions.get(id)?.close()
    let closed = false, generation = 0, started = false, pending = false
    let cursor: AgentJournalCursor | undefined = input.cursor
    let fence: number | undefined
    let running: Promise<void> | null = null
    let detach = (): void => {}
    let releaseRegistration = (): void => {}
    const record: Subscription = { id, base, fingerprint: caller.fingerprint, close,
      idle: () => running ?? Promise.resolve() }
    const aborted = (): void => releaseRegistration()
    function close(): void {
      if (closed) { return }
      closed = true; generation++
      detach()
      caller.signal?.removeEventListener('abort', aborted)
      if (subscriptions.get(id) === record) { subscriptions.delete(id) }
      releaseRegistration()
      try { emit({ type: 'end' }) } catch { /* The closing transport cannot fail another stream. */ }
    }
    function fail(error: unknown): void {
      if (closed) { return }
      close()
      try { caller.report?.(catalogReadFailure(error)) } catch { /* The owner has already cleaned up. */ }
    }
    function send(event: AgentSessionSubscribeEvent, current: number): boolean {
      if (closed || current !== generation) { return false }
      emit(event)
      return !closed && current === generation
    }
    async function deliver(initial: boolean): Promise<void> {
      const current = generation
      let checkpoint = initial
      for (;;) {
        const request: AgentSessionHistoryRequest = { sessionId: input.sessionId,
          direction: cursor ? 'after' : 'tail', ...(cursor ? { cursor: { ...cursor } } : {}),
          limit: AGENT_SESSION_HISTORY_MAX_LIMIT }
        const result = await read(captureCatalogParsed(request))
        if (closed || current !== generation) { return }
        const page = result.page, observedFence = result.ok ? page.fence : result.fence ?? page.fence
        if (observedFence === undefined) { throw new CatalogReadError('STRUCTURED_SUBSCRIBE_FENCE_UNAVAILABLE') }
        const clock = page.hostNow === undefined ? {} : { hostNow: page.hostNow }
        if (!result.ok || cursor === undefined) {
          const event: AgentSessionSubscribeEvent = result.ok
            ? { type: 'snapshot', sessionId: input.sessionId, page, fence: observedFence, ...clock }
            : { type: 'reset', sessionId: input.sessionId, reset: result.reset, page, fence: observedFence, ...clock }
          if (!send(event, current)) { return }
          cursor = { ...(page.liveCursor ?? page.window.nextCursor) }; fence = observedFence
          return
        }
        const next = page.window.nextCursor
        const advanced = next.epoch !== cursor.epoch || next.sequence > cursor.sequence
        if (checkpoint || advanced || fence !== observedFence || page.items.length || page.removedItemIds.length || page.submissions.length) {
          if (!send({ type: 'batch', sessionId: input.sessionId, batch: { cursor: next,
            items: page.items, removedItemIds: page.removedItemIds, submissions: page.submissions },
          fence: observedFence, ...clock }, current)) { return }
          cursor = { ...next }; fence = observedFence
        }
        checkpoint = false
        if (!page.hasNewer) { return }
        if (!advanced) { throw new CatalogReadError('STRUCTURED_HISTORY_UNREADABLE') }
      }
    }
    function drain(initial = false): Promise<void> {
      pending = true
      if (running) { return running }
      const run = async (): Promise<void> => {
        let checkpoint = initial
        while (pending && !closed) {
          pending = false
          await deliver(checkpoint)
          checkpoint = false
        }
      }
      running = run().finally(() => { running = null })
      return running
    }
    subscriptions.set(id, record)
    try {
      if (caller.registerOwned) {
        const registration = caller.registerOwned(id, close, caller.connectionId)
        releaseRegistration = registration.releaseIfCurrent.bind(registration)
      } else {
        caller.register(id, close, caller.connectionId)
        releaseRegistration = () => caller.release(id)
      }
      caller.signal?.addEventListener('abort', aborted, { once: true })
      if (caller.signal?.aborted) { close(); return }
      await drain(true)
      if (closed) { return }
      started = true
      detach = hints.listen(input.sessionId, () => { void drain().catch(fail) }, fail)
    } catch (error) {
      if (closed) { return }
      close()
      if (started) { caller.report?.(catalogReadFailure(error)) }
      else { throw catalogReadFailure(error) }
    }
  }

  function unsubscribe(params: unknown, context: RpcContext): { unsubscribed: true } {
    const input = UnsubscribeParams.parse(params)
    const caller = captureCaller(context, true)
    const base = structuredAgentSessionSubscriptionBase(context, input.sessionId)
    for (const record of [...subscriptions.values()]) {
      if (record.base !== base || record.fingerprint !== caller.fingerprint) { continue }
      if (input.subscriptionId !== undefined && record.id !== input.subscriptionId &&
          !(input.subscriptionId === base && record.id.startsWith(`${base}:`))) { continue }
      record.close()
    }
    return { unsubscribed: true }
  }

  function dispose(): void {
    if (disposed) { return }
    disposed = true
    for (const record of [...subscriptions.values()]) { record.close() }
  }
  /** Internal poll/drain barrier; no new wire method or independent consumer loop. */
  async function flush(): Promise<void> {
    await hints.flush()
    await Promise.all([...subscriptions.values()].map(record => record.idle().catch(() => {})))
  }
  return Object.freeze({ subscribe, unsubscribe, dispose, flush })
}
