import type { RpcAnyMethodDeclaration, RpcContext } from '../../runtime/rpc/core.ts'
import { captureDurableCatalogReadConfig, type DurableCatalogReadConfig } from './config.ts'
import { readManagedTerminalNativeChat } from '../output/terminal-native-read.ts'
import { NativeChatSession } from '../../../shared/rpc-contract/native-chat-params.ts'
import { sanitizeNativeChatRpcBlock } from '../../runtime/rpc/methods/native-chat-rpc-block-sanitize.ts'
import type { NativeChatMessage } from '../../../shared/native-chat-types.ts'

/** Server composition wraps the existing nativeChat declarations only. The
 * original owner remains responsible for unmanaged filesystem transcripts. */
export function bindManagedTerminalNativeChatMethods(methods: readonly RpcAnyMethodDeclaration[], original: DurableCatalogReadConfig,
  assertOutputAvailable: () => void = () => {}) {
  const config = captureDurableCatalogReadConfig(original)
  const sanitize = (messages: NativeChatMessage[], context: RpcContext) => messages.map(message => ({...message,
    blocks: message.blocks.map(block => sanitizeNativeChatRpcBlock(block, context.clientKind))}))
  return Object.freeze(methods.map(method => {
    if (method.name === 'nativeChat.readSession' && !('stream' in method && method.stream)) {
      const legacy = (params: never, context: RpcContext) => Reflect.apply(method.handler, method, [params, context])
      return {...method, async handler(params: never, context: RpcContext) {
        const page = await readManagedTerminalNativeChat(config, params, context)
        if (page === null) { return legacy(params, context) }
        assertOutputAvailable()
        if (page.kind !== 'PAGE') { throw new Error('TERMINAL_HISTORY_UNEXPECTED_HEAD') }
        return {messages: sanitize(page.messages, context), hasMore: page.hasMore, beforeOffset: page.beforeOffset,
          ...(page.lifecycle ? {lifecycle: page.lifecycle} : {})}
      }}
    }
    if (method.name === 'nativeChat.subscribe' && 'stream' in method && method.stream) {
      const legacy = method.handler.bind(method)
      return {...method, async handler(originalParams: never, context: RpcContext, emit: (frame: unknown) => void) {
        const params = NativeChatSession.parse(originalParams)
        if (context.signal?.aborted) { return }
        const first = await readManagedTerminalNativeChat(config, params, context)
        if (first === null) { return legacy(originalParams, context, emit) }
        assertOutputAvailable()
        if (first.kind !== 'PAGE') { throw new Error('TERMINAL_HISTORY_UNEXPECTED_HEAD') }
        const runtime = context.runtime, connectionId = context.connectionId, signal = context.signal
        const token = `nativeChat:${connectionId ?? 'local'}:${params.subscriptionId ?? `${params.agent}:${params.sessionId}`}`
        let closed = false, timer: ReturnType<typeof setTimeout> | undefined, head = first.headKey
        let latest = first
        const cleanup = () => {
          if (closed) { return }
          closed = true; if (timer) { clearTimeout(timer) }; signal?.removeEventListener('abort', abort)
          emit({type: 'end'})
        }
        const abort = () => runtime.cleanupSubscription(token)
        runtime.registerSubscriptionCleanup(token, cleanup, connectionId)
        signal?.addEventListener('abort', abort, {once: true})
        if (signal?.aborted) { abort(); return }
        emit({type: 'snapshot', messages: sanitize(first.messages, context), hasMore: first.hasMore, beforeOffset: first.beforeOffset,
          ...(first.lifecycle ? {lifecycle: first.lifecycle} : {})})
        const poll = async () => {
          if (closed) { return }
          try {
            assertOutputAvailable()
            const page = await readManagedTerminalNativeChat(config, params, context, head)
            if (closed) { return }
            if (!page) { throw new Error('TERMINAL_HISTORY_TARGET_LOST') }
            if (page.kind === 'PAGE') {
              head = page.headKey
              latest = page
              // Existing replacement frame handles native revisions/tombstones and epoch changes.
              emit({type: 'replacement', messages: sanitize(page.messages, context), hasMore: page.hasMore, beforeOffset: page.beforeOffset,
                ...(page.lifecycle ? {lifecycle: page.lifecycle} : {})})
            }
          } catch {
            if (!closed) { emit({type: 'snapshot', messages: sanitize(latest.messages, context),
              hasMore: latest.hasMore, beforeOffset: latest.beforeOffset, error: 'Transcript unavailable'}); abort() }
          }
          if (!closed) { timer = setTimeout(() => { void poll() }, config.pollIntervalMs) }
        }
        timer = setTimeout(() => { void poll() }, config.pollIntervalMs)
      }}
    }
    return method
  }))
}
