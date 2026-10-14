import { TerminalSend } from '../../../shared/rpc-contract/terminal-unary-params'
import { assertTerminalInputWithinLimit } from '../../../shared/terminal-input'
import { isTerminalQueryReply } from '../../../shared/terminal-query-reply'
import {
  AGENT_TUI_CLEAR_MAX_LINES,
  buildAgentTuiClearInput
} from '../../../shared/agent-tui-input-clear'
import type {
  TerminalAttachmentReference,
  TerminalDraftBinding,
  TerminalIngressClassification,
  TerminalIngressScope,
  TerminalIngressSnapshot,
  TerminalScopeValidity,
  TerminalWireAction
} from './types'

export const TERMINAL_PASTE_START = '\x1b[200~'
export const TERMINAL_PASTE_END = '\x1b[201~'

export function snapshotTerminalScope(input: TerminalIngressScope): TerminalIngressScope {
  const binding = snapshotDraftBinding(input.binding)
  for (const value of [input.ingressId, input.draftRevision]) {
    if (typeof value !== 'string' || !value) {
      throw new Error('Missing server ingress identity or draft revision')
    }
  }
  if (input.ptyIncarnationId !== null &&
    (typeof input.ptyIncarnationId !== 'string' || !input.ptyIncarnationId)) {
    throw new Error('Invalid server PTY incarnation')
  }
  if (typeof input.semanticAdapterRequired !== 'boolean') {
    throw new Error('Missing server semantic classification')
  }
  let stream: TerminalIngressScope['stream'] = null
  if (input.stream) {
    if (input.stream.connectionId !== binding.connectionId ||
      !Number.isInteger(input.stream.streamId) || input.stream.streamId < 1 ||
      typeof input.stream.streamGeneration !== 'string' || !input.stream.streamGeneration ||
      ![null, 'BYTES', 'SOURCE_RANGES'].includes(input.stream.ackMode)) {
      throw new Error('Invalid server stream registration')
    }
    stream = Object.freeze({
      connectionId: input.stream.connectionId,
      streamId: input.stream.streamId,
      streamGeneration: input.stream.streamGeneration,
      ackMode: input.stream.ackMode
    })
  }
  return Object.freeze({
    binding,
    ingressId: input.ingressId,
    draftRevision: input.draftRevision,
    ptyIncarnationId: input.ptyIncarnationId,
    semanticAdapterRequired: input.semanticAdapterRequired,
    stream
  })
}

export function snapshotDraftBinding(input: TerminalDraftBinding): TerminalDraftBinding {
  const binding = {
    pairedDeviceId: input.pairedDeviceId,
    principalId: input.principalId,
    logicalHandle: input.logicalHandle,
    sessionId: input.sessionId,
    connectionId: input.connectionId,
    floorGeneration: input.floorGeneration,
    mode: input.mode
  }
  if (Object.values(binding).some((value) => typeof value !== 'string' || !value) ||
    !['AGENT_CHAT_COMPAT', 'RAW_TERMINAL'].includes(binding.mode)) {
    throw new Error('Missing verified server terminal binding')
  }
  return Object.freeze(binding)
}

export function snapshotTerminalAttachments(
  input: readonly TerminalAttachmentReference[]
): readonly TerminalAttachmentReference[] {
  return Object.freeze(input.map((reference) => {
    if (typeof reference.attachmentId !== 'string' || !reference.attachmentId) {
      throw new Error('Invalid attachment reference')
    }
    return Object.freeze({ attachmentId: reference.attachmentId })
  }))
}

/** Synchronous: payload, authority and ordered references are frozen before any caller await. */
export function snapshotUnaryTerminalIngress(
  payload: unknown,
  serverScope: TerminalIngressScope,
  attachments: readonly TerminalAttachmentReference[],
  validateOriginalScope: TerminalScopeValidity
): TerminalIngressSnapshot {
  const params = TerminalSend.parse(payload)
  const scope = snapshotTerminalScope(serverScope)
  if (scope.stream !== null || params.terminal !== scope.binding.logicalHandle) {
    throw new Error('Unary terminal target differs from verified binding')
  }
  const action: TerminalWireAction = Object.freeze({
    text: params.text ?? '',
    enter: params.enter === true,
    interrupt: params.interrupt === true,
    inputKind: params.inputKind,
    expectedIncarnationId: params.expectedIncarnationId,
    agentPrompt: params.agentPrompt === true,
    resolvedLaunchDraft: params.resolvedLaunchDraft
      ? Object.freeze({ ...params.resolvedLaunchDraft }) : undefined
  })
  const snapshot = Object.freeze({
    scope,
    source: 'UNARY' as const,
    action,
    inputBytes: null,
    attachments: snapshotTerminalAttachments(attachments),
    isCurrent: () => validateOriginalScope(scope)
  })
  // Same existing per-terminal-send text boundary; never an aggregate draft quota.
  assertTerminalInputWithinLimit(action.text)
  if (action.resolvedLaunchDraft) {
    assertTerminalInputWithinLimit(action.resolvedLaunchDraft.text)
  }
  return snapshot
}

export function isConfirmedTerminalDraftClear(text: string): boolean {
  for (let lines = 1; lines <= AGENT_TUI_CLEAR_MAX_LINES; lines += 1) {
    if (text === buildAgentTuiClearInput(lines)) {
      return true
    }
  }
  return false
}

/** Binary fragments can supply an already losslessly decoded text prefix to the reducer. */
export function classifyTerminalIngress(snapshot: TerminalIngressSnapshot): TerminalIngressClassification {
  if (snapshot.source === 'BINARY') {
    return Object.freeze({ kind: 'UNSUPPORTED', reason: 'Binary fragments require the scoped reducer' })
  }
  return classifyTerminalIngressText(snapshot, snapshot.action.text)
}

/** Internal reducer entry: text is decoded from the frozen bytes, never a caller override. */
export function classifyTerminalIngressText(
  snapshot: TerminalIngressSnapshot,
  text: string
): TerminalIngressClassification {
  if (!snapshot.isCurrent()) {
    return Object.freeze({ kind: 'STALE_SCOPE' })
  }
  const { action, scope } = snapshot
  if (action.inputKind === 'query-reply' || (snapshot.source === 'BINARY' && isTerminalQueryReply(text))) {
    return !action.enter && !action.interrupt && !action.agentPrompt &&
      snapshot.attachments.length === 0 && isTerminalQueryReply(text)
      ? Object.freeze({ kind: 'PROTOCOL_REPLY' })
      : Object.freeze({ kind: 'UNSUPPORTED', reason: 'Invalid protocol reply shape' })
  }
  if (scope.binding.mode === 'RAW_TERMINAL') {
    return scope.ptyIncarnationId !== null &&
      (!action.expectedIncarnationId || action.expectedIncarnationId === scope.ptyIncarnationId)
      ? Object.freeze({ kind: 'RAW_CURRENT' })
      : Object.freeze({ kind: 'UNSUPPORTED', reason: 'No matching current PTY incarnation' })
  }
  if (scope.semanticAdapterRequired || action.agentPrompt || action.resolvedLaunchDraft) {
    return Object.freeze({ kind: 'UNSUPPORTED', reason: 'Semantic adapter required' })
  }
  if (action.interrupt || text === '\x1b') {
    return !action.enter && snapshot.attachments.length === 0 &&
      (text === '' || text === '\x1b')
      ? Object.freeze({ kind: 'STOP_CANDIDATE' })
      : Object.freeze({ kind: 'UNSUPPORTED', reason: 'Mixed Stop and body input' })
  }
  if (!action.enter && snapshot.attachments.length === 0 && isConfirmedTerminalDraftClear(text)) {
    return Object.freeze({ kind: 'CLEAR' })
  }
  return Object.freeze({ kind: action.enter ? 'CHAT_SUBMIT' : 'CHAT_FRAGMENT', text })
}
