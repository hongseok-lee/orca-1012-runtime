import { assertTerminalInputWithinLimit } from '../../../shared/terminal-input'
import {
  classifyTerminalIngressText,
  snapshotDraftBinding,
  snapshotTerminalAttachments
} from './ingress'
import { decodeTerminalUtf8Fragment, parseTerminalDraftFragment } from './draft-parser'
import type {
  TerminalDraft,
  TerminalDraftBinding,
  TerminalDraftChunk,
  TerminalDraftReduction,
  TerminalIngressSnapshot
} from './types'

export function sameTerminalDraftBinding(a: TerminalDraftBinding, b: TerminalDraftBinding): boolean {
  return a.pairedDeviceId === b.pairedDeviceId && a.principalId === b.principalId &&
    a.logicalHandle === b.logicalHandle && a.sessionId === b.sessionId &&
    a.connectionId === b.connectionId && a.floorGeneration === b.floorGeneration && a.mode === b.mode
}

function freezeDraft(draft: TerminalDraft): TerminalDraft {
  return Object.freeze({
    binding: snapshotDraftBinding(draft.binding),
    revision: draft.revision,
    chunks: Object.freeze(draft.chunks.map((chunk) => Object.freeze({
      ingressId: chunk.ingressId, text: chunk.text,
      attachments: snapshotTerminalAttachments(chunk.attachments)
    }))),
    pasteOpen: draft.pasteOpen,
    pendingDelimiter: draft.pendingDelimiter,
    pendingUtf8: Object.freeze([...draft.pendingUtf8]),
    pendingUtf8Stream: draft.pendingUtf8Stream ? Object.freeze({ ...draft.pendingUtf8Stream }) : null
  })
}

export function emptyTerminalDraft(binding: TerminalDraftBinding, revision: string): TerminalDraft {
  if (!revision) {
    throw new Error('Missing server draft revision')
  }
  return freezeDraft({ binding, revision, chunks: [], pasteOpen: false,
    pendingDelimiter: '', pendingUtf8: [], pendingUtf8Stream: null })
}

/** Ordered single-scope reduction only. Does not write, deduplicate, wake, cancel or ACK. */
export function reduceTerminalDraft(
  previous: TerminalDraft | null,
  snapshot: TerminalIngressSnapshot
): TerminalDraftReduction {
  const original = previous ? freezeDraft(previous) : null
  const result = (kind: TerminalDraftReduction['kind'], reason?: string): TerminalDraftReduction =>
    Object.freeze({ kind, draft: original, candidate: null, ...(reason ? { reason } : {}) })
  if (!snapshot.isCurrent()) {
    return result('STALE_SCOPE')
  }
  // Replies/raw traffic never applies or transfers a managed draft, including an old floor's draft.
  if (snapshot.action.inputKind === 'query-reply' || snapshot.scope.binding.mode === 'RAW_TERMINAL') {
    const classified = classifyTerminalIngressText(snapshot, snapshot.action.text)
    if (classified.kind === 'PROTOCOL_REPLY' || classified.kind === 'RAW_CURRENT' ||
      classified.kind === 'STALE_SCOPE') {
      return result(classified.kind)
    }
    return result('UNSUPPORTED', classified.kind === 'UNSUPPORTED'
      ? classified.reason : 'Unresolved non-draft input')
  }
  if (original && (!sameTerminalDraftBinding(original.binding, snapshot.scope.binding) ||
    original.revision !== snapshot.scope.draftRevision)) {
    return result('SCOPE_MISMATCH', 'Original device, floor, connection or draft revision differs')
  }
  let text = snapshot.action.text
  let pendingUtf8: readonly number[] = []
  const draft = original ?? emptyTerminalDraft(snapshot.scope.binding, snapshot.scope.draftRevision)
  if (snapshot.source === 'BINARY') {
    const stream = snapshot.scope.stream
    if (!stream || snapshot.inputBytes === null ||
      (draft.pendingUtf8Stream && (draft.pendingUtf8Stream.streamId !== stream.streamId ||
        draft.pendingUtf8Stream.streamGeneration !== stream.streamGeneration))) {
      return result('SCOPE_MISMATCH', 'UTF-8 continuation differs from original stream')
    }
    try {
      const decoded = decodeTerminalUtf8Fragment(draft.pendingUtf8, snapshot.inputBytes)
      text = decoded.text
      pendingUtf8 = decoded.pending
    } catch {
      return result('UNSUPPORTED', 'Malformed UTF-8 input; original draft preserved')
    }
    // This is a per-ingress text check, not a limit on accumulated body/attachments.
    assertTerminalInputWithinLimit(text)
  } else if (draft.pendingUtf8.length > 0) {
    return result('UNSUPPORTED', 'Unary input cannot complete an unfinished binary UTF-8 character')
  }
  const classified = classifyTerminalIngressText(snapshot, text)
  if (classified.kind === 'STALE_SCOPE' || classified.kind === 'PROTOCOL_REPLY' ||
    classified.kind === 'RAW_CURRENT') {
    return result(classified.kind)
  }
  if (classified.kind === 'UNSUPPORTED') {
    return result('UNSUPPORTED', classified.reason)
  }
  if (classified.kind === 'CLEAR') {
    if (pendingUtf8.length > 0) {
      return result('UNSUPPORTED', 'Clear followed by unfinished UTF-8 input')
    }
    return Object.freeze({ kind: 'DRAFT_EDIT',
      draft: emptyTerminalDraft(draft.binding, draft.revision), candidate: null })
  }
  if (classified.kind === 'STOP_CANDIDATE') {
    // A lone ESC can also be a split paste prefix. Preserve it without selecting a Stop target.
    // The subsequent SQL/gesture boundary must not treat this candidate as proof of cancellation.
    if (snapshot.action.interrupt) {
      return draft.pasteOpen || draft.pendingDelimiter
        ? result('UNSUPPORTED', 'Stop meaning is unresolved inside a partial paste')
        : result('STOP_CANDIDATE')
    }
    if (!draft.pasteOpen && !draft.pendingDelimiter) {
      return Object.freeze({ kind: 'STOP_CANDIDATE',
        draft: freezeDraft({ ...draft, pendingDelimiter: text, pendingUtf8,
          pendingUtf8Stream: pendingUtf8.length > 0 && snapshot.scope.stream
            ? { streamId: snapshot.scope.stream.streamId,
                streamGeneration: snapshot.scope.stream.streamGeneration } : null }), candidate: null })
    }
  }
  const standaloneSubmit = !snapshot.action.enter && text === '\r' &&
    !draft.pasteOpen && !draft.pendingDelimiter && pendingUtf8.length === 0
  const parsed = standaloneSubmit
    ? { kind: 'PARSED' as const, text: '', pasteOpen: false, pendingDelimiter: '' }
    : parseTerminalDraftFragment(draft, text, snapshot.action.enter)
  if (parsed.kind === 'UNSUPPORTED') {
    return result('UNSUPPORTED', parsed.reason)
  }
  const chunks: readonly TerminalDraftChunk[] = parsed.text || snapshot.attachments.length > 0
    ? [...draft.chunks, Object.freeze({ ingressId: snapshot.scope.ingressId,
        text: parsed.text, attachments: snapshot.attachments })]
    : draft.chunks
  const next = freezeDraft({ ...draft, chunks, pasteOpen: parsed.pasteOpen,
    pendingDelimiter: parsed.pendingDelimiter, pendingUtf8,
    pendingUtf8Stream: pendingUtf8.length > 0 && snapshot.scope.stream
      ? { streamId: snapshot.scope.stream.streamId,
          streamGeneration: snapshot.scope.stream.streamGeneration } : null })
  const body = next.chunks.map((chunk) => chunk.text).join('')
  if (body.trimStart().startsWith('/')) {
    return result('UNSUPPORTED', 'Slash command requires a semantic adapter')
  }
  if (snapshot.action.enter || standaloneSubmit) {
    if (next.pasteOpen || next.pendingDelimiter || next.pendingUtf8.length > 0) {
      return result('UNSUPPORTED', 'Cannot submit unfinished paste or UTF-8 input')
    }
    const attachments = Object.freeze(next.chunks.flatMap((chunk) => chunk.attachments))
    if (!body.trim() && attachments.length === 0) {
      return result('UNSUPPORTED', 'Empty submit has no proven prompt meaning')
    }
    return Object.freeze({ kind: 'SUBMIT_CANDIDATE', draft: next,
      candidate: Object.freeze({ scope: snapshot.scope, text: body,
        chunks: next.chunks, attachments }) })
  }
  return Object.freeze({ kind: 'DRAFT_EDIT', draft: next, candidate: null })
}
