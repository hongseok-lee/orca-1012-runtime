import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import * as Schema from '../../../shared/rpc-contract/structured-agent-session-params'
import {
  prepareStructuredWire, snapshotStructuredJson, structuredFenceToDecimal,
  structuredFenceToNumber, structuredCounterToNumber, resolveStructuredAuthority,
  checkStructuredCapabilities, projectStructuredDispatchState,
  projectStructuredMutationResult, projectStructuredCancellation
} from './index.ts'
import type {
  StructuredMethod, PreparedStructuredWire, VerifiedStructuredAuthentication,
  VerifiedStructuredTargetAccess, VerifiedStructuredSubmissionFacts,
  CommittedStructuredMutation, VerifiedStructuredCancellation
} from './index.ts'
import { pairedDeviceAttachmentPrincipal, fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as STRUCTURED,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CLAUDE,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY as PENDING
} from '../../../shared/protocol-version'

// Every branded value below is synthetic pure-test input, not authentication, COMMIT or native evidence.
const SESSION = 'public-session_non_uuid'
const DEVICE = '00000000-0000-0000-0000-000000000001'
const CAPS = [STRUCTURED, CLAUDE, PENDING]
function mutation(method: string, fields: Record<string, unknown>, fence: number | null = 1) {
  return {
    sessionId: SESSION, clientOperationId: 'original-operation-key', expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({ method, sessionId: SESSION, fields })
  }
}
function prepared(method: StructuredMethod, params: unknown, capabilities: readonly string[] = CAPS): PreparedStructuredWire {
  const result = prepareStructuredWire(method, params, capabilities)
  assert.equal(result.ok, true)
  return result.value
}
function send() {
  const body = { kind: 'message', role: 'user', blocks: [
    { type: 'text', text: 'synthetic first' },
    { type: 'image-ref', path: 'synthetic-alias/image' },
    { type: 'text', text: 'synthetic last' }
  ] }
  return { envelope: mutation('agentSession.send', { body }), body }
}

test('existing strict schemas and all original fingerprint methods preserve intent, attach and controls', () => {
  const intent = { worktree: 'id:workspace-selector', agent: 'claude' }
  const create = prepared('agentSession.create', { envelope: mutation('agentSession.create', intent, null), ...intent })
  assert.equal(create.mutation?.publicSessionId, SESSION)
  assert.equal(create.mutation?.sessionFence, null)
  assert.equal(create.target.kind, 'WORKTREE')
  assert.equal(create.params.agent, 'claude')
  const resume = { ...intent, resumeFrom: { providerSessionId: 'native-request-only' } }
  assert.equal(prepared('agentSession.create', { envelope: mutation('agentSession.create', resume, null), ...resume }).params.resumeFrom !== undefined, true)
  const attach = {
    location: { executionHostId: 'local', wslDistro: null, workspaceId: 'workspace-selector', workspaceKind: 'folder' },
    provider: 'claude', agent: 'claude', accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/synthetic/account' },
    runtimeKind: 'native', providerHandle: { kind: 'claude', sessionId: 'native-request-only', leafUuid: null }
  }
  const attached = prepared('agentSession.create', {
    ...attach, envelope: mutation('agentSession.attach', { ...attach, expectedRuntimeFence: null }, null)
  })
  assert.equal(attached.mutation?.fingerprintMethod, 'agentSession.attach')
  assert.equal(attached.target.kind, 'WORKSPACE_LOCATION')
  const cases: [StructuredMethod, string, Record<string, unknown>][] = [
    ['agentSession.cancel', 'agentSession.cancel', { turnId: 'original-native-turn', scope: 'background-tasks', taskId: 'original-task' }],
    ['agentSession.respondToQuestion', 'agentSession.respondTo:question', { itemId: 'question-item', expectedRevision: 2, optionId: 'option-1' }],
    ['agentSession.respondToApproval', 'agentSession.respondTo:approval', { itemId: 'approval-item', expectedRevision: 3, optionId: 'option-2' }],
    ['agentSession.setOption', 'agentSession.setOption', { key: 'model', value: '' }],
    ['agentSession.conversationCommand', 'agentSession.conversationCommand', { command: 'compact' }],
    ['agentSession.rewind', 'agentSession.rewind', { itemId: 'original-item', expectedEpoch: 'original-epoch' }]
  ]
  for (const [method, fingerprintMethod, fields] of cases) {
    const value = prepared(method, { envelope: mutation(fingerprintMethod, fields), ...fields })
    assert.equal(value.mutation?.fingerprintMethod, fingerprintMethod)
    assert.equal(value.mutation?.wireFingerprint, mutation(fingerprintMethod, fields).payloadFingerprint)
    assert.equal(JSON.stringify(value.mutation?.semanticBody), JSON.stringify(fields))
  }
  const handoff = { direction: 'to-native', mode: 'after-turn' }
  const value = prepared('agentSession.requestHandoff', {
    envelope: mutation('agentSession.requestHandoff', { ...handoff, action: 'start' }), ...handoff
  })
  assert.equal(value.mutation?.semanticBody.action, 'start')
  assert.equal(value.mutation?.handoffOperationFingerprint,
    mutation('agentSession.requestHandoff.operation', { direction: handoff.direction }).payloadFingerprint)
  assert.equal(prepared('agentSession.createSupport', intent).mutation, null)
  assert.equal(prepared('agentSession.history', { sessionId: SESSION, direction: 'tail', limit: 200 }).mutation, null)
  assert.equal(prepared('agentSession.subscribe', { sessionId: SESSION }).mutation, null)
  assert.throws(() => prepared('agentSession.send', { ...send(), clientId: 'forged-caller' }))
  assert.throws(() => prepared('agentSession.create', { envelope: mutation('agentSession.create', intent, null), ...intent, resumeFrom: { providerSessionId: 'native', transcriptPath: '/synthetic/forbidden' } }))
})

test('retryUnknown does not alter send identity, canonical semantic body or original attachment order', () => {
  const raw = send()
  assert.equal(Schema.SendParams.safeParse(raw).success, true)
  const first = prepared('agentSession.send', raw)
  const retry = prepared('agentSession.send', { ...raw, retryUnknown: true })
  assert.equal(first.mutation?.wireFingerprint, retry.mutation?.wireFingerprint)
  assert.equal(JSON.stringify(first.mutation?.semanticBody), JSON.stringify(retry.mutation?.semanticBody))
  assert.equal(JSON.stringify(first.params.body), JSON.stringify(raw.body))
  assert.equal(first.mutation?.clientMessageId, raw.envelope.clientOperationId)
  assert.equal(Object.hasOwn(retry.mutation!.semanticBody, 'retryUnknown'), false)
  const conflict = prepareStructuredWire('agentSession.send', { ...raw, envelope: { ...raw.envelope, payloadFingerprint: '0'.repeat(64) } }, CAPS)
  assert.equal(conflict.ok, false)
  if (!conflict.ok) {
    assert.equal(conflict.refusal.code, 'agent_session_operation_conflict')
  }
})

test('non-UUID public IDs remain public and decimal counters never round or substitute an epoch', () => {
  assert.equal(Schema.SessionId.parse(SESSION), SESSION)
  for (const fence of [1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(structuredFenceToNumber(structuredFenceToDecimal(fence)), fence)
  }
  for (const fence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => structuredFenceToDecimal(fence), { code: 'STRUCTURED_INVALID_FENCE' })
  }
  for (const sequence of ['01', '-1', '1.5', '9007199254740992']) {
    assert.throws(() => structuredCounterToNumber(sequence), { code: 'STRUCTURED_UNREADABLE_COUNTER' })
  }
  assert.equal(structuredCounterToNumber('0'), 0)
  const raw = send()
  assert.throws(() => prepared('agentSession.send', { ...raw, envelope: { ...raw.envelope, expectedRuntimeFence: null } }))
  assert.throws(() => prepared('agentSession.send', { ...raw, envelope: { ...raw.envelope, expectedRuntimeFence: Number.MAX_SAFE_INTEGER + 1 } }))
  assert.throws(() => prepared('agentSession.history', { sessionId: SESSION, direction: 'after', cursor: { epoch: 'original-epoch', sequence: Number.MAX_SAFE_INTEGER + 1 } }))
})

test('caller strings do not authenticate and exact principal, method and workspace authorization stay separate', () => {
  const request = prepared('agentSession.send', send())
  const principal = pairedDeviceAttachmentPrincipal(DEVICE)
  const auth = { kind: 'PAIRED_DEVICE', pairedDeviceId: DEVICE } as unknown as VerifiedStructuredAuthentication
  const access = { principal, method: request.method, target: request.target } as unknown as VerifiedStructuredTargetAccess
  assert.throws(() => resolveStructuredAuthority(request, null, access), { code: 'STRUCTURED_AUTH_REQUIRED' })
  assert.throws(() => resolveStructuredAuthority(request, { clientId: DEVICE, callerKey: DEVICE, connectionId: DEVICE } as unknown as VerifiedStructuredAuthentication, access), { code: 'STRUCTURED_AUTH_REQUIRED' })
  assert.throws(() => resolveStructuredAuthority(request, auth, null), { code: 'STRUCTURED_TARGET_DENIED' })
  assert.throws(() => resolveStructuredAuthority(request, auth, { ...access, principal: pairedDeviceAttachmentPrincipal('00000000-0000-0000-0000-000000000002') }), { code: 'STRUCTURED_TARGET_DENIED' })
  assert.throws(() => resolveStructuredAuthority(request, auth, { ...access, method: 'agentSession.cancel' }), { code: 'STRUCTURED_TARGET_DENIED' })
  assert.throws(() => resolveStructuredAuthority(request, auth, { ...access, target: { kind: 'SESSION', publicSessionId: 'different-public-id' } }), { code: 'STRUCTURED_TARGET_DENIED' })
  assert.equal(resolveStructuredAuthority(request, auth, access).principal, principal)
  const intent = { worktree: 'id:workspace-original', agent: 'claude' }
  const create = prepared('agentSession.create', { envelope: mutation('agentSession.create', intent, null), ...intent })
  assert.throws(() => resolveStructuredAuthority(create, auth, {
    ...access, method: create.method, target: { kind: 'WORKTREE', publicSessionId: SESSION, worktree: 'id:workspace-other' }
  }), { code: 'STRUCTURED_TARGET_DENIED' })
  for (const kind of ['UNARY_CREDENTIAL_FINGERPRINT', 'EXPLICIT_TRUSTED_LOCAL'] as const) {
    const fingerprint = 'a'.repeat(64)
    const synthetic = { kind, authenticatedCallerFingerprint: fingerprint } as unknown as VerifiedStructuredAuthentication
    const grant = { ...access, principal: fingerprintAttachmentPrincipal(fingerprint) }
    assert.equal(resolveStructuredAuthority(request, synthetic, grant).principal, grant.principal)
  }
})

test('first-await caller mutation is isolated and descriptor snapshots never invoke getter, Proxy or Date conversion', async () => {
  const raw = send()
  const caps: string[] = [...CAPS]
  const original = JSON.stringify(raw.body)
  const request = prepared('agentSession.send', raw, caps)
  await Promise.resolve()
  raw.body.blocks[0].text = 'changed after await'
  raw.envelope.clientOperationId = 'different-key'
  caps.splice(0)
  assert.equal(JSON.stringify(request.params.body), original)
  assert.equal(request.mutation?.operationKey, 'original-operation-key')
  assert.equal(request.capabilities.length, 3)
  assert.equal(Object.isFrozen(request.params.body), true)
  assert.throws(() => Object.assign(request.mutation!.semanticBody, { altered: true }))
  let effects = 0
  const getter = Object.defineProperty({}, 'body', { enumerable: true, get() { effects++; return send().body } })
  assert.throws(() => snapshotStructuredJson(getter), { code: 'STRUCTURED_NON_JSON' })
  const proxy = new Proxy({}, { getPrototypeOf() { effects++; return Object.prototype } })
  assert.throws(() => snapshotStructuredJson(proxy), { code: 'STRUCTURED_NON_JSON' })
  const date = new Date('2026-10-13T00:00:00Z')
  date.toJSON = () => { effects++; return 'changed' }
  assert.throws(() => snapshotStructuredJson(date), { code: 'STRUCTURED_NON_JSON' })
  const sparse: unknown[] = []
  sparse.length = 2
  assert.throws(() => snapshotStructuredJson(sparse), { code: 'STRUCTURED_NON_JSON' })
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  assert.throws(() => snapshotStructuredJson(cycle), { code: 'STRUCTURED_NON_JSON' })
  assert.equal(effects, 0)
})

test('actual method readiness and separate Claude/pending negotiation do not advertise missing adapters', () => {
  const request = prepared('agentSession.send', send())
  assert.equal(checkStructuredCapabilities(request, { provider: 'claude', methods: {} }).eligible, false)
  assert.equal(checkStructuredCapabilities(request, { provider: 'claude', methods: { 'agentSession.send': { implemented: false, ready: true } } }).eligible, false)
  const readiness = { provider: 'claude' as const, methods: { 'agentSession.send': { implemented: true, ready: true } } }
  assert.equal(checkStructuredCapabilities(prepared('agentSession.send', send(), []), readiness).eligible, false)
  assert.equal(checkStructuredCapabilities(prepared('agentSession.send', send(), [STRUCTURED]), readiness).eligible, false)
  assert.deepEqual(checkStructuredCapabilities(prepared('agentSession.send', send(), [STRUCTURED, CLAUDE]), readiness), { eligible: true, pendingResultsNegotiated: false })
  assert.deepEqual(checkStructuredCapabilities(request, readiness), { eligible: true, pendingResultsNegotiated: true })
})

test('accepted projection requires original native tuple; transaction-local data does not replace observed COMMIT', () => {
  const original = { messageId: 'message', deliveryAttemptId: 'delivery', attemptId: 'attempt', podUid: 'pod', executionEpoch: '1' }
  const nativeAdmission = { ...original, kind: 'PROVIDER_ADMISSION', source: 'PROVIDER_PROTOCOL', evidenceRef: 'synthetic-native-receipt', observedAt: '2026-10-13T00:00:00Z', providerRef: { provider: 'claude', nativeSessionRef: 'synthetic-native-session' } }
  const synthetic = (state: string, proof: unknown) => ({ state, original, nativeAdmission: proof }) as unknown as VerifiedStructuredSubmissionFacts
  assert.equal(projectStructuredDispatchState(synthetic('PENDING', null)), 'pending')
  assert.equal(projectStructuredDispatchState(synthetic('UNKNOWN', null)), 'unknown')
  assert.equal(projectStructuredDispatchState(synthetic('REJECTED', null)), 'rejected')
  assert.throws(() => projectStructuredDispatchState(synthetic('ACCEPTED', null)), { code: 'STRUCTURED_ADMISSION_UNVERIFIED' })
  assert.throws(() => projectStructuredDispatchState(synthetic('ACCEPTED', { ...nativeAdmission, deliveryAttemptId: 'different' })), { code: 'STRUCTURED_ADMISSION_UNVERIFIED' })
  assert.equal(projectStructuredDispatchState(synthetic('ACCEPTED', nativeAdmission)), 'accepted')
  const committed = { replayed: false, fence: structuredFenceToDecimal(1), epoch: 'original-epoch', sequence: '1', value: { pending: true } } as unknown as CommittedStructuredMutation<{ pending: boolean }>
  const result = projectStructuredMutationResult(committed)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.cursor.sequence, 1)
    assert.equal(result.fence, 1)
  }
  assert.throws(() => projectStructuredMutationResult({ ...committed, sequence: '9007199254740992' }), { code: 'STRUCTURED_UNREADABLE_COUNTER' })
  // Brands are upper-boundary obligations; this fixture does not issue a real proof or COMMIT.
})

test('requested cancellation keeps original native turn and never confirms a request or expands background scope', () => {
  const facts = { requestedTurnId: 'original-native-turn', observedTurnId: null, outcome: 'REQUESTED', confirmedScope: 'root-turn' } as unknown as VerifiedStructuredCancellation
  assert.deepEqual(projectStructuredCancellation(facts, 'root-turn'), { turnId: 'original-native-turn', cancelled: false })
  assert.throws(() => projectStructuredCancellation({ ...facts, observedTurnId: 'message-id-substitute', outcome: 'CONFIRMED' }, 'root-turn'), { code: 'STRUCTURED_CANCEL_TARGET_MISMATCH' })
  assert.throws(() => projectStructuredCancellation({ ...facts, confirmedScope: 'background-task' }, 'root-turn'), { code: 'STRUCTURED_CANCEL_TARGET_MISMATCH' })
  assert.equal(projectStructuredCancellation({ ...facts, outcome: 'CONFIRMED', observedTurnId: 'original-native-turn' }, 'root-turn').cancelled, true)
})
