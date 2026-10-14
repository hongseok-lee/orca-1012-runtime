import {
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  TerminalStreamOpcode
} from '../../../shared/terminal-stream-protocol'
import { TERMINAL_INPUT_MAX_BYTES, TERMINAL_INPUT_TOO_LARGE_ERROR } from '../../../shared/terminal-input'
import {
  TerminalMultiplexLegacyAckFrame,
  TerminalMultiplexSourceRangeAckFrame
} from '../../runtime/rpc/methods/terminal/stream-schemas'
import { snapshotTerminalAttachments, snapshotTerminalScope } from './ingress'
import type {
  TerminalAttachmentReference,
  TerminalIngressScope,
  TerminalIngressSnapshot,
  TerminalScopeValidity
} from './types'

export type TerminalBinaryIngress =
  | Readonly<{ kind: 'INPUT'; snapshot: TerminalIngressSnapshot; sequence: number }>
  | Readonly<{
      kind: 'OUTPUT_ACK'
      scope: TerminalIngressScope
      ack: Readonly<{ bytes: number }> | Readonly<{ streamGeneration: string; ackedEndByte: number }>
      sequence: number
      isCurrent: () => boolean
    }>
  | Readonly<{ kind: 'STALE_SCOPE' | 'UNSUPPORTED'; reason: string }>

/** Existing frame decoder and ACK schemas; no handler registration or output settlement. */
export function snapshotBinaryTerminalIngress(
  bytes: Uint8Array,
  serverScope: TerminalIngressScope,
  attachments: readonly TerminalAttachmentReference[],
  validateOriginalScope: TerminalScopeValidity
): TerminalBinaryIngress {
  const scope = snapshotTerminalScope(serverScope)
  const orderedAttachments = snapshotTerminalAttachments(attachments)
  const frame = decodeTerminalStreamFrame(bytes.slice())
  const stream = scope.stream
  if (!frame || !stream || frame.streamId !== stream.streamId) {
    return Object.freeze({ kind: 'UNSUPPORTED', reason: 'Frame differs from registered stream' })
  }
  const isCurrent = (): boolean => validateOriginalScope(scope)
  if (!isCurrent()) {
    return Object.freeze({ kind: 'STALE_SCOPE', reason: 'Original stream or floor is no longer current' })
  }
  if (frame.opcode === TerminalStreamOpcode.Ack) {
    const payload = decodeTerminalStreamJson<unknown>(frame.payload)
    if (stream.ackMode === 'SOURCE_RANGES') {
      const parsed = TerminalMultiplexSourceRangeAckFrame.safeParse(payload)
      if (parsed.success && parsed.data.streamGeneration === stream.streamGeneration) {
        return Object.freeze({ kind: 'OUTPUT_ACK', scope, ack: Object.freeze({ ...parsed.data }),
          sequence: frame.seq, isCurrent })
      }
    } else if (stream.ackMode === 'BYTES') {
      const parsed = TerminalMultiplexLegacyAckFrame.safeParse(payload)
      if (parsed.success) {
        return Object.freeze({ kind: 'OUTPUT_ACK', scope, ack: Object.freeze({ ...parsed.data }),
          sequence: frame.seq, isCurrent })
      }
    }
    return Object.freeze({ kind: 'UNSUPPORTED', reason: 'Invalid or unnegotiated output ACK' })
  }
  if (frame.opcode !== TerminalStreamOpcode.Input) {
    return Object.freeze({ kind: 'UNSUPPORTED', reason: 'Not an Input or output ACK frame' })
  }
  if (frame.payload.byteLength > TERMINAL_INPUT_MAX_BYTES) {
    // Reuse the existing error/limit rather than introduce a stream or draft aggregate limit.
    throw new Error(TERMINAL_INPUT_TOO_LARGE_ERROR)
  }
  const snapshot: TerminalIngressSnapshot = Object.freeze({
    scope,
    source: 'BINARY',
    action: Object.freeze({ text: '', enter: false, interrupt: false,
      inputKind: undefined, expectedIncarnationId: undefined,
      agentPrompt: false, resolvedLaunchDraft: undefined }),
    inputBytes: Object.freeze(Array.from(frame.payload)),
    attachments: orderedAttachments,
    isCurrent
  })
  return Object.freeze({ kind: 'INPUT', snapshot, sequence: frame.seq })
}
