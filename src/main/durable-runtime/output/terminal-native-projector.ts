import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation.ts'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation.ts'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key.ts'
import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection.ts'
import type { AgentJournalItemIdentity, AgentJournalItemBody, AgentJournalRenderItem } from '../../../shared/agent-session-journal-types.ts'
import type { StructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/structured-agent-session-event-sink.ts'
import type { NativeChatTurnLifecycle } from '../../../shared/native-chat-types.ts'
import type { CommittedJournalEvent, OriginalInputComponent } from './model.ts'
import { jsonObject, JournalReadError } from './model.ts'
import { decodeCommittedInputBody } from './input-codec.ts'
import { parseTerminalCodexEvent } from './terminal-codex-event.ts'
import { canonicalInputJson } from '../input/canonical.ts'
import type { JsonValue } from '../db/atomic.ts'

/** The replay of a submitted user message (not a tool result) opens a Claude turn. */
function claudeStartsTurn(message: Record<string, unknown>): boolean {
  const body = message.message
  if (message.type !== 'user' || message.parent_tool_use_id !== null || !body || typeof body !== 'object') { return false }
  const content = Reflect.get(body, 'content')
  return typeof content === 'string' || Array.isArray(content) && content.some(part => part && typeof part === 'object' && Reflect.get(part, 'type') !== 'tool_result')
}

/** Pure replay of COMMITTED raw notifications through the original translator.
 * Item identity/ordinal/revisions are the existing native journal identities. */
export function projectTerminalNativeHistory(sessionId: string, events: readonly CommittedJournalEvent[],
  inputs: readonly OriginalInputComponent[], nativeInputEchoIds: ReadonlySet<string> = new Set()) {
  const items = new Map<string, AgentJournalRenderItem>(), revisions = new Map<string, number>()
  const offsets = new Map<string, number>()
  let position = 0, observedAt = 0
  let bytePosition = 0, itemBytePosition = 0
  let lifecycle: NativeChatTurnLifecycle | undefined
  const append = (identity: AgentJournalItemIdentity, body: AgentJournalItemBody, at = observedAt) => {
    const itemId = agentJournalItemKey(identity), previous = items.get(itemId)
    // Reserve the original item position before any render-only echo filtering.
    if (!offsets.has(itemId)) {
      offsets.set(itemId, itemBytePosition++)
      bytePosition = Math.max(bytePosition, itemBytePosition)
    }
    // Exact stored delivery thread/turn identity only, never text/hash dedup.
    if (nativeInputEchoIds.has(itemId) && body.kind === 'message' && body.role === 'user') { return }
    if (body.kind === 'turn') {
      lifecycle = body.state === 'running' || body.state === 'completed' || body.state === 'interrupted'
        ? {state: body.state === 'running' ? 'working' : body.state, turnId: body.turnId,
          timestamp: body.state === 'running' ? body.startedAt ?? at : body.completedAt ?? at}
        : undefined
    }
    const revision = (revisions.get(itemId) ?? 0) + 1
    revisions.set(itemId, revision)
    items.set(itemId, {itemId, body, revision, sequence: previous?.sequence ?? position, observedAt: previous?.observedAt ?? at})
  }
  const tombstone = (identity: AgentJournalItemIdentity) => {
    const id = agentJournalItemKey(identity)
    revisions.set(id, (revisions.get(id) ?? 0) + 1); items.delete(id)
  }
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (id, body, options) => append(id, body, options?.observedAt), appendTombstone: tombstone, publish() {},
    tryAppendItem(id, body, options) { append(id, body, options?.observedAt); return {accepted: true} },
    tryAppendTombstone(id) { tombstone(id); return {accepted: true} },
    tryAppendLifecycleBatch(_id, mutations, options) {
      for (const mutation of mutations) {
        if (mutation.kind === 'item') { append(mutation.identity, mutation.body, options?.observedAt) }
        else { tombstone(mutation.identity) }
      }
      return {accepted: true}
    }
  }
  const translators = new Map<string, ReturnType<typeof createCodexJournalTranslator>>()
  const claudeTranslators = new Map<string, ReturnType<typeof createClaudeJournalTranslator>>()
  const originals = new Map(inputs.map(input => [input.inputId, input]))
  try {
    for (const event of events) {
      position = event.sequence; observedAt = Date.parse(event.committedAt)
      // Managed numeric cursors use canonical committed UTF8 lengths and
      // per-record item order; they are not provider transcript seek addresses.
      // Unrendered rows count too; revisions retain the first item position.
      itemBytePosition = bytePosition
      bytePosition += Buffer.byteLength(canonicalInputJson(event.body as JsonValue), 'utf8') + 1
      if (!Number.isSafeInteger(bytePosition)) { throw new JournalReadError('TERMINAL_HISTORY_OFFSET_UNREADABLE') }
      if (event.body === null || typeof event.body !== 'object' || Array.isArray(event.body)) { continue }
      const body = jsonObject(event.body)
      if (body.kind === 'INPUT_SUBMISSION') {
        if (typeof body.inputId !== 'string') { throw new JournalReadError('TERMINAL_HISTORY_INPUT') }
        const original = originals.get(body.inputId)
        if (!original || original.sessionId !== sessionId || original.submission !== null) { throw new JournalReadError('TERMINAL_HISTORY_INPUT') }
        // The real accepted input identity is never collapsed by text/hash.
        const itemId = `input:${original.inputId}`
        offsets.set(itemId, itemBytePosition++)
        bytePosition = Math.max(bytePosition, itemBytePosition)
        items.set(itemId, {itemId, revision: 1, sequence: position, observedAt,
          body: decodeCommittedInputBody(original)})
      } else if (body.kind === 'INPUT_OBSERVATION' && body.state === 'UNKNOWN') {
        const original = inputs.find(input => input.messageId === body.messageId && input.sessionId === sessionId &&
          input.submission === null && items.has(`input:${input.inputId}`))
        if (!original || typeof body.deliveryAttemptId !== 'string' || !body.deliveryAttemptId ||
            typeof body.evidenceRef !== 'string' || !body.evidenceRef || !event.eventId ||
            event.sourceKey !== JSON.stringify(['v1', sessionId, 'native', 'INPUT_UNKNOWN', 'platform',
              body.deliveryAttemptId, body.evidenceRef])) { throw new JournalReadError('TERMINAL_HISTORY_INPUT_OBSERVATION') }
        // This is original platform delivery history, not a provider reply or turn.
        append({provider: 'orca', clientMessageId: `terminal-input-unknown:${sessionId}:${event.eventId}`},
          {kind: 'status', text: 'Delivery unconfirmed.', tone: 'warning'})
      } else if (body.kind === 'TERMINAL_CODEX_NOTIFICATION') {
        const raw = parseTerminalCodexEvent(body)
        if (raw.sessionId !== sessionId) { throw new JournalReadError('TERMINAL_HISTORY_SCOPE') }
        const key = JSON.stringify([raw.notification.connectionId, raw.nativeSessionRef])
        if (raw.notification.method === 'claude/message') {
          // A hosted Claude frame is one SDK message, replayed through the desktop Claude translator.
          let claude = claudeTranslators.get(key)
          if (!claude) {
            claude = createClaudeJournalTranslator({sink, coalesceMs: 0, fallbackIdPrefix: `terminal:${raw.notification.connectionId}`})
            claudeTranslators.set(key, claude)
          }
          observedAt = Date.parse(raw.notification.observedAt)
          const message = jsonObject(raw.notification.params) as Record<string, unknown>
          claude.handle({type: 'message', sessionId: raw.nativeSessionRef, message, observedAt,
            ...(claudeStartsTurn(message) ? {startsTurn: true as const} : {})})
          claude.flush()
          continue
        }
        let translator = translators.get(key)
        if (!translator) {
          translator = createCodexJournalTranslator({sink, sessionId, coalesceMs: 0,
            now: () => observedAt, primaryThreadId: () => raw.nativeSessionRef})
          translators.set(key, translator)
        }
        observedAt = Date.parse(raw.notification.observedAt)
        const params = raw.notification.params
        // Keep explicit provider lineage, including legitimate subagent thread IDs.
        const p = params !== null && typeof params === 'object' && !Array.isArray(params) ? params : null
        const thread = p?.thread
        const threadId = typeof p?.threadId === 'string' ? p.threadId : typeof p?.thread_id === 'string' ? p.thread_id
          : thread !== null && typeof thread === 'object' && !Array.isArray(thread) && typeof thread?.id === 'string' ? thread.id : raw.nativeSessionRef
        const translated = translator.handle({type: 'notification', sessionId, threadId,
          method: raw.notification.method, params, observedAt})
        if (!translated.accepted && translated.reason !== 'untranslated') { throw new JournalReadError('TERMINAL_HISTORY_TRANSLATION') }
        translator.flush()
      }
    }
    const ordered = [...items.values()].sort((a, b) => offsets.get(a.itemId)! - offsets.get(b.itemId)!)
    const messages = projectStructuredItemsToNativeChat(ordered)
    return {messages: messages.map(message => Object.freeze({message, offset: offsets.get(message.id)!})),
      ...(lifecycle ? {lifecycle} : {})}
  } finally {
    for (const translator of translators.values()) { translator.dispose() }
    for (const translator of claudeTranslators.values()) { translator.dispose() }
  }
}
