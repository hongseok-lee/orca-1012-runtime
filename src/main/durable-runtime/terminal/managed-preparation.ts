import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { assertTerminalInputWithinLimit } from '../../../shared/terminal-input'
import { inputPayloadHash, inputScopeKey } from '../input/canonical.ts'
import type { JsonValue, ReceiptIdentity } from '../db/atomic.ts'
import { snapshotTerminalScope, snapshotTerminalAttachments } from './ingress'
import { immutableTerminalJson, snapshotDraftAttachments } from './durable-codec'
import { terminalCounter, TerminalDraftStoreError } from './durable-contracts'
import type { ManagedTerminalIngressRequest, TerminalIngressOrigin } from './durable-contracts'
import type { TerminalIngressSnapshot } from './types'

export function prepareManagedTerminalIngress(request: ManagedTerminalIngressRequest) {
  const input = request.snapshot
  const scope = snapshotTerminalScope(input.scope)
  terminalCounter(scope.binding.floorGeneration)
  terminalCounter(scope.draftRevision)
  const isCurrent = input.isCurrent.bind(input)
  const action = Object.freeze({ ...input.action,
    resolvedLaunchDraft: input.action.resolvedLaunchDraft
      ? Object.freeze({ ...input.action.resolvedLaunchDraft }) : undefined })
  const snapshot: TerminalIngressSnapshot = Object.freeze({ scope, source: input.source, action,
    inputBytes: input.inputBytes === null ? null : Object.freeze([...input.inputBytes]),
    attachments: snapshotTerminalAttachments(input.attachments),
    isCurrent })
  if (!['UNARY', 'BINARY'].includes(snapshot.source) ||
    (snapshot.source === 'BINARY') !== (snapshot.inputBytes !== null) ||
    snapshot.inputBytes?.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new TerminalDraftStoreError('TERMINAL_WIRE_SOURCE')
  }
  assertTerminalInputWithinLimit(action.text)
  if (action.resolvedLaunchDraft) {
    assertTerminalInputWithinLimit(action.resolvedLaunchDraft.text)
  }
  const origin = snapshotTerminalOrigin(request.origin)
  if (origin.kind === 'UNARY' && snapshot.source !== 'UNARY') {
    throw new TerminalDraftStoreError('TERMINAL_BINARY_NOT_RPC_ID')
  }
  if (origin.kind === 'INGRESS' && origin.ingressIdentity !== scope.ingressId) {
    throw new TerminalDraftStoreError('TERMINAL_ORIGINAL_INGRESS')
  }
  const authority = Object.freeze({ principal: request.authority.principal,
    sessionId: logicalId('session', request.authority.sessionId),
    scope: Object.freeze({ ...request.authority.scope }) })
  if (authority.principal !== scope.binding.principalId || authority.sessionId !== scope.binding.sessionId ||
    authority.scope.kind !== 'TERMINAL' || authority.scope.terminalHandle !== scope.binding.logicalHandle) {
    throw new TerminalDraftStoreError('TERMINAL_AUTHORITY_SCOPE')
  }
  const attachments = snapshotDraftAttachments(request.attachments)
  if (attachments.length !== snapshot.attachments.length ||
    attachments.some((ref, i) => ref.attachmentId !== snapshot.attachments[i].attachmentId)) {
    throw new TerminalDraftStoreError('TERMINAL_ATTACHMENT_ORDER')
  }
  const sessionFence = counter('session-fence', request.sessionFence)
  const expectedFloorRevision = terminalCounter(request.expectedFloorRevision)
  const authorizeOrigin = request.authorization.assertAuthenticatedOrigin.bind(request.authorization)
  const authorize = (): void => {
    if (authorizeOrigin(scope, origin) !== undefined) {
      throw new TerminalDraftStoreError('TERMINAL_ASYNC_AUTHORIZATION')
    }
  }
  const operationKey = JSON.stringify(origin.kind === 'UNARY'
    ? ['UNARY', origin.authenticatedConnectionIncarnation, origin.rpcRequestId]
    : ['INGRESS', origin.authenticatedConnectionIncarnation, origin.ingressIdentity])
  // Credential-free input semantics only: no floor/draft revision, mutable fence or ACK sequence.
  const wire = immutableTerminalJson({ version: 1, source: snapshot.source,
    terminal: scope.binding.logicalHandle,
    action: { text: action.text, enter: action.enter, interrupt: action.interrupt,
      inputKind: action.inputKind ?? null, expectedIncarnationId: action.expectedIncarnationId ?? null,
      agentPrompt: action.agentPrompt, resolvedLaunchDraft: action.resolvedLaunchDraft
        ? { ...action.resolvedLaunchDraft } : null },
    inputBytes: snapshot.inputBytes === null ? null : [...snapshot.inputBytes],
    attachments: attachments.map((ref) => ({ ...ref })) })
  const identity: ReceiptIdentity = Object.freeze({
    key: Object.freeze({ principalId: authority.principal, sessionScope: inputScopeKey(authority),
      method: 'terminal.send', operationKey }), payloadHash: inputPayloadHash(wire)
  })
  return Object.freeze({ snapshot, origin, authority, sessionFence, expectedFloorRevision,
    attachments, authorize, wire, identity })
}

function snapshotTerminalOrigin(value: TerminalIngressOrigin): TerminalIngressOrigin {
  if (!value.authenticatedConnectionIncarnation) {
    throw new TerminalDraftStoreError('TERMINAL_CONNECTION_IDENTITY')
  }
  if (value.kind === 'UNARY' && typeof value.rpcRequestId === 'string' && value.rpcRequestId) {
    return Object.freeze({ kind: 'UNARY', authenticatedConnectionIncarnation: value.authenticatedConnectionIncarnation,
      rpcRequestId: value.rpcRequestId })
  }
  if (value.kind === 'INGRESS' && typeof value.ingressIdentity === 'string' && value.ingressIdentity) {
    return Object.freeze({ kind: 'INGRESS', authenticatedConnectionIncarnation: value.authenticatedConnectionIncarnation,
      ingressIdentity: value.ingressIdentity })
  }
  throw new TerminalDraftStoreError('TERMINAL_ORIGINAL_INGRESS')
}

export type PreparedManagedTerminalIngress = ReturnType<typeof prepareManagedTerminalIngress>

export function requireCurrentTerminalIngress(prepared: PreparedManagedTerminalIngress): void {
  prepared.authorize()
  if (!prepared.snapshot.isCurrent()) {
    throw new TerminalDraftStoreError('TERMINAL_STALE_CONNECTION')
  }
}

export function terminalIntakePayload(
  prepared: PreparedManagedTerminalIngress,
  text: string,
  chunks: JsonValue
): JsonValue {
  return immutableTerminalJson({ version: 1, text, chunks, wire: prepared.wire,
    originalIngressId: prepared.snapshot.scope.ingressId })
}
