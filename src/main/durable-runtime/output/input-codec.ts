import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../../shared/native-chat-types'
import { SendParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import { freezeJournalJson, jsonObject, JournalReadError, type FrozenJson, type OriginalInputComponent } from './model.ts'

function nonempty(value: FrozenJson): value is string {
  return typeof value === 'string' && value.length > 0
}
function hash(value: FrozenJson): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}
function unreadable(code = 'JOURNAL_INPUT_CODEC_UNREADABLE'): never {
  throw new JournalReadError(code)
}

/** A read codec, not an issuer, writer, provider transcript or full wire snapshot.
 * Terminal payload bytes stay in input.original. No structured send quota is applied to legacy aggregates. */
export function decodeCommittedInputBody(input: OriginalInputComponent): Readonly<AgentJournalMessageItem> {
  const envelope = jsonObject(input.original)
  if (envelope.version !== 1) { unreadable('JOURNAL_INPUT_BODY_UNREADABLE') }
  if (envelope.sessionId !== input.sessionId ||
    envelope.operationKey !== input.operationKey || envelope.inputKind !== 'GENERAL' ||
    !Array.isArray(envelope.scope) || envelope.scope.length !== 2 ||
    !Array.isArray(envelope.attachments) || envelope.attachments.length !== input.attachments.length) {
    unreadable()
  }
  for (const [position, actual] of input.attachments.entries()) {
    const original = jsonObject(envelope.attachments[position])
    if (actual.position !== String(position) || original.aliasPath !== actual.aliasPath ||
      original.contentHash !== actual.contentHash || !hash(actual.contentHash) ||
      !actual.aliasPath.startsWith('/') || actual.aliasPath.includes('//') || /(^|\/)\.\.?($|\/)/.test(actual.aliasPath)) {
      unreadable('JOURNAL_INPUT_ATTACHMENT_MISMATCH')
    }
  }
  const payload = jsonObject(envelope.payload)
  if (envelope.method === 'agentSession.send') {
    if (envelope.scope[0] !== 'session' || envelope.scope[1] !== input.sessionId) { unreadable() }
    if (!SendParams.shape.body.safeParse(payload.body).success) {
      unreadable('JOURNAL_INPUT_BODY_UNREADABLE')
    }
    return freezeJournalJson(payload.body) as unknown as Readonly<AgentJournalMessageItem>
  }
  if (envelope.method !== 'terminal.send' || envelope.scope[0] !== 'terminal' ||
    !nonempty(envelope.scope[1]) || input.submission !== null ||
    payload.version !== 1 || typeof payload.text !== 'string' || !Array.isArray(payload.chunks) ||
    !nonempty(payload.originalIngressId) ||
    Object.keys(payload).some((key) => !['version', 'text', 'chunks', 'wire', 'originalIngressId'].includes(key))) {
    unreadable()
  }
  const wire = jsonObject(payload.wire)
  const action = jsonObject(wire.action)
  if (wire.version !== 1 || wire.terminal !== envelope.scope[1] ||
    !['UNARY', 'BINARY'].includes(String(wire.source)) || typeof action.text !== 'string' ||
    typeof action.enter !== 'boolean' || typeof action.interrupt !== 'boolean' ||
    typeof action.agentPrompt !== 'boolean' ||
    !(action.inputKind === null || action.inputKind === 'query-reply') ||
    !(action.expectedIncarnationId === null || nonempty(action.expectedIncarnationId)) ||
    !Array.isArray(wire.attachments)) { unreadable() }
  if (action.resolvedLaunchDraft !== null) {
    const launch = jsonObject(action.resolvedLaunchDraft)
    if (typeof launch.text !== 'string' || typeof launch.createdAt !== 'number' || !Number.isFinite(launch.createdAt)) { unreadable() }
  }
  if (wire.source === 'UNARY' ? wire.inputBytes !== null :
    !Array.isArray(wire.inputBytes) || wire.inputBytes.some((byte) => typeof byte !== 'number' ||
      !Number.isInteger(byte) || byte < 0 || byte > 255)) { unreadable() }
  let origin: unknown
  try { origin = JSON.parse(input.operationKey) } catch { unreadable() }
  if (!Array.isArray(origin) || origin.length !== 3 ||
    !origin.every((part) => typeof part === 'string' && part.length > 0) ||
    !(origin[0] === 'UNARY' && wire.source === 'UNARY' || origin[0] === 'INGRESS' && origin[2] === payload.originalIngressId)) {
    unreadable('JOURNAL_TERMINAL_INGRESS_MISMATCH')
  }
  const blocks: NativeChatBlock[] = []
  const text: string[] = []
  const byAttachmentId = new Map<string, Readonly<{ aliasPath: string; contentHash: string }>>()
  const currentIngressAttachments: string[] = []
  let position = 0
  for (const entry of payload.chunks) {
    const chunk = jsonObject(entry)
    if (!nonempty(chunk.ingressId) || typeof chunk.text !== 'string' || !Array.isArray(chunk.attachments)) { unreadable() }
    text.push(chunk.text)
    // Keep even empty text chunks; no trim, aggregation, positional deduplication or block cap.
    blocks.push({ type: 'text', text: chunk.text })
    for (const entry of chunk.attachments) {
      const ref = jsonObject(entry)
      if (!nonempty(ref.attachmentId)) { unreadable('JOURNAL_INPUT_ATTACHMENT_MISMATCH') }
      const actual = input.attachments[position++]
      if (!actual || actual.aliasPrincipal !== input.principal || actual.mediaType !== 'image/png') {
        unreadable('JOURNAL_TERMINAL_MEDIA_UNREADABLE')
      }
      const previous = byAttachmentId.get(ref.attachmentId)
      if (previous && (previous.aliasPath !== actual.aliasPath || previous.contentHash !== actual.contentHash)) {
        unreadable('JOURNAL_INPUT_ATTACHMENT_MISMATCH')
      }
      byAttachmentId.set(ref.attachmentId, actual)
      if (chunk.ingressId === payload.originalIngressId) { currentIngressAttachments.push(ref.attachmentId) }
      blocks.push({ type: 'image-ref', path: actual.aliasPath })
    }
  }
  if (text.join('') !== payload.text) { unreadable('JOURNAL_TERMINAL_TEXT_MISMATCH') }
  if (position !== input.attachments.length || wire.attachments.length !== currentIngressAttachments.length) {
    unreadable('JOURNAL_INPUT_ATTACHMENT_MISMATCH')
  }
  for (const [index, entry] of wire.attachments.entries()) {
    const ref = jsonObject(entry)
    if (!nonempty(ref.attachmentId) || ref.attachmentId !== currentIngressAttachments[index] ||
      !nonempty(ref.aliasPath) || !hash(ref.contentHash)) { unreadable('JOURNAL_INPUT_ATTACHMENT_MISMATCH') }
    const actual = byAttachmentId.get(ref.attachmentId)
    if (!actual || actual.aliasPath !== ref.aliasPath || actual.contentHash !== ref.contentHash) {
      unreadable('JOURNAL_INPUT_ATTACHMENT_MISMATCH')
    }
  }
  return freezeJournalJson({ kind: 'message', role: 'user', blocks }) as unknown as Readonly<AgentJournalMessageItem>
}
