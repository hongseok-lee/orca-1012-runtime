import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { logicalId, counter } from '../../../../shared/durable-runtime/identity.ts'
import type { JsonValue } from '../../db/atomic.ts'
import { inputPayloadHash } from '../../input/canonical.ts'
import type { CommandClaim } from '../../runtime/gateway/types.ts'
import type { PodUid, ProviderRef } from '../../runtime/runtime-evidence.ts'
import type {
  ProviderBinding, ProviderDispatchRequest, ProviderEffectPermit, ProviderObservation,
  ProviderSubmissionIdentity
} from '../shared/contracts.ts'
import { invokeProviderEffect } from '../shared/effect-boundary.ts'
import { renderRecoverySubmission } from '../shared/recovery-renderer.ts'
import { ClaudeDurableProvider } from './driver.ts'
import type { ClaudeColdRequest, ClaudeProtocolHandlers } from './transport.ts'

const id = <K extends string>(kind: K) => logicalId(kind, randomUUID())
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function fixture(bindingRevision = '1') {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Synthetic fixture identity only; not workload authentication or actual provider evidence.
  const podUid = 'fixture-pod' as PodUid
  const binding: ProviderBinding = { sessionId: id('session'), tabId: id('tab'),
    terminalHandle: 'fixture-terminal', providerBindingRevision: counter('row:provider-binding', bindingRevision),
    runtimeUnitId: id('runtime-unit'), attemptId: id('attempt'), podUid,
    executionEpoch: counter('execution-epoch', '3'), connectionInstanceId: randomUUID() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Synthetic original gateway lineage; visibility deliberately stays TRANSACTION_LOCAL.
  const commandClaim = { visibility: 'TRANSACTION_LOCAL', commandId: id('runtime-command'),
    executionToken: id('runtime-command-execution'), executorId: 'fixture-executor', controllerTerm: counter('controller-term', '4'),
    identity: { command: 'dispatchInput', inputHash: 'fixture-hash', originalEnvelope: {
      operationId: id('operation'), controllerTerm: counter('controller-term', '4'),
      stepRevision: counter('step-revision', '1'), executionEpoch: counter('execution-epoch', '3'),
      intentRevision: counter('intent-revision', '2'), podTarget: 'EXISTING_POD', expectedPodUid: podUid } } } as CommandClaim
  const cold: ClaudeColdRequest = { mode: 'COLD', binding, native: { kind: 'NEW' },
    persistentHome: '/fixture/home', checkout: '/fixture/checkout', launch: {
      executable: '/fixture/cli', args: ['--dangerously-skip-permissions', '--model', ''],
      options: { model: '', extraArgs: { 'replay-user-messages': null } }, env: { HOME: '/fixture/home' } } }
  const payload: JsonValue = { version: 1, sessionId: binding.sessionId, contextRevision: '2',
    records: [{ body: 'cancelled historical request', kind: 'CANCEL' }],
    facts: [{ state: 'UNKNOWN', cancelRevision: '1' }, { state: 'COMPLETED' }] }
  const original: JsonValue = { payload: { text: 'new independent input' }, inputKind: 'GENERAL' }
  const sealedPayload: JsonValue = { version: 1, inputKind: 'GENERAL', components: [{
    inputId: id('input'), inputSequence: '1', sender: 'fixture-user', operationKey: 'fixture-op',
    original, originalPayloadHash: inputPayloadHash(original), attachments: [] }] }
  const request: ProviderDispatchRequest = {
    sealed: { messageId: id('message'), sealedRevision: counter('message-revision', '5'),
      payload: sealedPayload, payloadHash: inputPayloadHash(sealedPayload) },
    deliveryAttemptId: id('delivery-attempt'), context: { version: 1, sessionId: binding.sessionId,
      revision: counter('context-revision', '2'), payload, hash: inputPayloadHash(payload) },
    attachments: [], commandClaim }
  const observations: ProviderObservation[] = []
  const writes: Record<string, unknown>[] = []
  let handlers!: ClaudeProtocolHandlers
  let seenCold: ClaudeColdRequest | undefined
  let interrupts = 0
  let failWrite = false
  let afterWrite: (() => void) | undefined
  let beforeInterrupt: (() => void) | undefined
  const nativeSession = 'fixture-native-session'
  const connection = { closed: false,
    async send(wire: Record<string, unknown>) {
      writes.push(wire); afterWrite?.()
      if (failWrite) throw new Error('synthetic write uncertainty')
    },
    async interrupt() { interrupts++; beforeInterrupt?.(); return {} } }
  const provider = new ClaudeDurableProvider(async (input, callbacks) => {
    seenCold = input; handlers = callbacks
    callbacks.onMessage({ type: 'system', subtype: 'init', session_id: nativeSession, uuid: 'init-uuid' })
    return connection
  }, (observation) => observations.push(observation))
  let effectCalls = 0
  function permit(): ProviderEffectPermit {
    return { async invoke(_identity, effect) { effectCalls++; return effect() } }
  }
  function receipt(index = 0, overrides: Record<string, unknown> = {}) {
    const wire = writes[index]
    assert.ok(wire)
    return { type: 'user', session_id: nativeSession, uuid: `native-user-${index}`,
      user_message_uuid: wire.uuid, parent_tool_use_id: null, message: wire.message, ...overrides }
  }
  function terminal(index = 0, overrides: Record<string, unknown> = {}) {
    return { type: 'result', subtype: 'success', session_id: nativeSession,
      uuid: `result-${index}`, user_message_uuid: writes[index]?.uuid,
      turn_uuid: `native-user-${index}`, ...overrides }
  }
  return { provider, binding, cold, commandClaim, request, observations, writes, permit, receipt, terminal,
    emit: (frame: Record<string, unknown>) => handlers.onMessage(frame),
    fault: () => handlers.onFault(), getCold: () => seenCold,
    interrupts: () => interrupts, effectCalls: () => effectCalls,
    failWrites: () => { failWrite = true }, onWrite: (run: () => void) => { afterWrite = run },
    onInterrupt: (run: () => void) => { beforeInterrupt = run } }
}
async function ready(f: ReturnType<typeof fixture>) {
  return f.provider.cold(f.cold, f.commandClaim, f.permit())
}
function identity(result: Awaited<ReturnType<ClaudeDurableProvider['dispatch']>>): ProviderSubmissionIdentity {
  assert.notEqual(result.state, 'UNSUPPORTED')
  assert.ok('identity' in result)
  return result.identity
}
function admitted(f: ReturnType<typeof fixture>) {
  const event = f.observations.find((item) => item.kind === 'ADMITTED')
  assert.ok(event?.kind === 'ADMITTED')
  return event
}

test('fixture: actual init, logical identity and explicit blank settings remain distinct', async () => {
  const f = fixture()
  const binding = await ready(f)
  assert.equal(binding.sessionId, f.binding.sessionId)
  assert.equal(binding.providerRef.nativeSessionRef, 'fixture-native-session')
  assert.notEqual(binding.providerRef.nativeSessionRef, binding.sessionId)
  assert.deepEqual(f.getCold()?.launch, f.cold.launch)
  assert.equal(f.getCold()?.launch.options.model, '')
  assert.ok(Object.isFrozen(binding))
})
test('fixture: PID/transport opening without native init never becomes ready', async () => {
  const f = fixture()
  const driver = new ClaudeDurableProvider(async () => ({ closed: false,
    async send() {}, async interrupt() {} }), () => {})
  await assert.rejects(driver.cold(f.cold, f.commandClaim, f.permit(), 10), /UNCONFIRMED/)
  await assert.rejects(driver.dispatch(f.request, f.permit()), /NOT_READY/)
})
test('fixture: wrong native resume identity is rejected without replacing logical binding', async () => {
  const f = fixture()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Synthetic expected native resume identity; no actual account/session is resumed.
  const providerRef = { provider: 'claude', nativeSessionRef: 'other-native-session' } as ProviderRef
  await assert.rejects(f.provider.cold({ ...f.cold, native: { kind: 'RESUME', providerRef } },
    f.commandClaim, f.permit()), /IDENTITY_MISMATCH/)
  assert.equal(f.writes.length, 0)
})
test('fixture: write success alone yields no admission/context proof; exact receipt does', async () => {
  const f = fixture(); await ready(f)
  const result = await f.provider.dispatch(f.request, f.permit())
  assert.equal(result.state, 'PENDING'); assert.equal(f.observations.length, 0)
  f.emit(f.receipt())
  const event = admitted(f)
  assert.deepEqual(event.identity, identity(result))
  assert.equal(event.admission.deliveryAttemptId, f.request.deliveryAttemptId)
  assert.equal(event.contextDelivery.contextHash, f.request.context.hash)
  assert.equal(event.contextDelivery.providerBindingRevision, f.binding.providerBindingRevision)
  assert.equal(event.admission.providerRef.nativeTurnId, 'native-user-0')
  assert.ok(Object.isFrozen(event.contextDelivery))
})
test('fixture: wrong session/request, body mismatch and weak text matches create no proof', async () => {
  const f = fixture(); await ready(f); await f.provider.dispatch(f.request, f.permit())
  f.emit(f.receipt(0, { session_id: 'other-session' }))
  f.emit(f.receipt(0, { user_message_uuid: 'other-request' }))
  f.emit(f.receipt(0, { user_message_uuid: undefined, uuid: 'unmatched-native-user' }))
  f.emit(f.receipt(0, { message: { role: 'user', content: [{ type: 'text', text: 'different' }] } }))
  assert.equal(f.observations.length, 0)
})
test('fixture: lost write outcome stays UNKNOWN and used permit is never retried', async () => {
  const f = fixture(); await ready(f); f.failWrites()
  const permit = f.permit()
  assert.equal((await f.provider.dispatch(f.request, permit)).state, 'UNKNOWN')
  await assert.rejects(f.provider.dispatch(f.request, permit), /UNSETTLED|PERMIT|ALREADY_SUBMITTED/)
  assert.equal(f.writes.length, 1); assert.equal(f.effectCalls(), 2)
  f.emit(f.receipt()); assert.equal(admitted(f).identity.contextHash, f.request.context.hash)
})
test('fixture: transport loss does not imply provider target/child stop', async () => {
  const f = fixture(); await ready(f); await f.provider.dispatch(f.request, f.permit())
  f.fault(); assert.equal(f.observations[0]?.kind, 'UNKNOWN')
  assert.equal(f.observations.some((item) => item.kind === 'TARGET_STOPPED'), false)
})
test('fixture: old connection observations preserve old binding and never admit new connection', async () => {
  const old = fixture('1'); const current = fixture('2')
  await ready(old); await ready(current)
  await old.provider.dispatch(old.request, old.permit())
  await current.provider.dispatch(current.request, current.permit())
  old.emit(old.receipt())
  assert.equal(admitted(old).identity.binding.providerBindingRevision, '1')
  assert.equal(current.observations.length, 0)
  current.emit(old.receipt()); assert.equal(current.observations.length, 0)
})
test('fixture: interrupt ACK stays unconfirmed; exact aborted terminal supplies target proof only', async () => {
  const f = fixture(); await ready(f); const result = await f.provider.dispatch(f.request, f.permit())
  f.emit(f.receipt())
  const target = { identity: identity(result), providerRef: admitted(f).admission.providerRef }
  assert.deepEqual(await f.provider.cancel(target, f.commandClaim, f.permit()),
    { state: 'UNCONFIRMED', requested: true })
  f.emit(f.terminal(0, { turn_uuid: 'different-turn', terminal_reason: 'aborted_streaming' }))
  assert.equal(f.observations.some((item) => item.kind === 'TARGET_STOPPED'), false)
  f.emit(f.terminal(0, { terminal_reason: 'aborted_streaming', is_error: true }))
  const observed = await f.provider.cancel(target, f.commandClaim, f.permit())
  assert.equal(observed.state, 'OBSERVED'); assert.equal(f.interrupts(), 1)
  if (observed.state === 'OBSERVED') assert.equal(observed.stopped.targetMessageId, f.request.sealed.messageId)
})
test('fixture: a completed old turn cannot interrupt a new turn', async () => {
  const f = fixture(); await ready(f); const first = await f.provider.dispatch(f.request, f.permit())
  f.emit(f.receipt()); const target = { identity: identity(first), providerRef: admitted(f).admission.providerRef }
  f.emit(f.terminal())
  await f.provider.dispatch({ ...f.request, deliveryAttemptId: id('delivery-attempt') }, f.permit())
  assert.deepEqual(await f.provider.cancel(target, f.commandClaim, f.permit()),
    { state: 'UNCONFIRMED', requested: false })
  assert.equal(f.interrupts(), 0)
})
test('fixture: settled delivery is not resubmitted and completion retains actual native lineage', async () => {
  const f = fixture(); await ready(f); await f.provider.dispatch(f.request, f.permit())
  f.emit(f.receipt()); f.emit(f.terminal())
  const completion = f.observations.find((item) => item.kind === 'COMPLETED')
  assert.equal(completion?.providerRef?.nativeTurnId, 'native-user-0')
  assert.equal(completion?.nativeEventId, 'result-0')
  await assert.rejects(f.provider.dispatch(f.request, f.permit()), /ALREADY_SUBMITTED/)
  assert.equal(f.writes.length, 1)
})
test('fixture: frozen context tuple survives caller mutation while a request is in flight', async () => {
  const f = fixture(); await ready(f)
  const originalHash = f.request.context.hash
  const response = f.provider.dispatch(f.request, f.permit())
  Object.assign(f.request.context, { hash: 'changed', revision: '99' })
  await response; f.emit(f.receipt())
  assert.equal(admitted(f).contextDelivery.contextHash, originalHash)
  assert.equal(admitted(f).contextDelivery.contextRevision, '2')
})
test('fixture: unsupported channels and context-only input make zero provider calls', async () => {
  const f = fixture(); await ready(f)
  for (const inputKind of ['COMMAND', 'QUESTION_RESPONSE', 'APPROVAL_RESPONSE', 'RAW_BYTES']) {
    const payload: JsonValue = { version: 1, inputKind, components: [] }
    const result = await f.provider.dispatch({ ...f.request, sealed: { ...f.request.sealed,
      payload, payloadHash: inputPayloadHash(payload) } }, f.permit())
    assert.equal(result.state, 'UNSUPPORTED')
  }
  const payload: JsonValue = { version: 1, inputKind: 'GENERAL', components: [] }
  assert.equal((await f.provider.dispatch({ ...f.request, sealed: { ...f.request.sealed,
    payload, payloadHash: inputPayloadHash(payload) } }, f.permit())).state, 'UNSUPPORTED')
  assert.equal(f.writes.length, 0); assert.equal(f.effectCalls(), 1)
})
test('fixture: transaction-local claim and a denied executor boundary cause no transport effect', async () => {
  const f = fixture(); await ready(f)
  const denied: ProviderEffectPermit = { async invoke() { throw new Error('COMMIT_NOT_CONFIRMED') } }
  await assert.rejects(f.provider.dispatch(f.request, denied), /COMMIT_NOT_CONFIRMED/)
  assert.equal(f.writes.length, 0)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Deliberate wrong capability shape in a synthetic negative fixture.
  await assert.rejects(f.provider.dispatch(f.request, f.commandClaim as unknown as ProviderEffectPermit), /PERMIT_UNAVAILABLE/)
  assert.equal(f.writes.length, 0)
})
test('fixture: the executor callback and the permit itself can each be used only once', async () => {
  const f = fixture(); let calls = 0
  const permit: ProviderEffectPermit = { async invoke(_identity, run) {
    const first = await run(); await assert.rejects(run(), /ALREADY_INVOKED/); return first
  } }
  const effectIdentity = { kind: 'COLD' as const, binding: f.binding, commandClaim: f.commandClaim }
  await invokeProviderEffect(permit, effectIdentity, async () => { calls++; return true })
  await assert.rejects(invokeProviderEffect(permit, effectIdentity, async () => true), /PERMIT_UNAVAILABLE/)
  assert.equal(calls, 1)
})
test('fixture: actual Claude wire keeps image order/hash and a single trailing context-before-input text', async () => {
  const f = fixture(); await ready(f)
  const root = process.env.ORCA_P111_FIXTURE_ROOT
  assert.ok(root, 'Owned fixture directory is required')
  await mkdir(root, { recursive: true })
  const bytes = [Buffer.from('synthetic image A'), Buffer.from('synthetic image B')]
  const attachments = await Promise.all(bytes.map(async (content, index) => {
    const path = `${root}/image-${index}.png`; await writeFile(path, content, { mode: 0o600 })
    return { inputId: `input-${index}`, position: '0', aliasPath: `synthetic/${index}`, contentHash: hash(content), path }
  }))
  const components = attachments.map((attachment, index) => {
    const original: JsonValue = { payload: { text: `new component ${index}` }, inputKind: 'GENERAL' }
    return { inputId: attachment.inputId, inputSequence: String(index + 1), sender: 'fixture', operationKey: null,
      original, originalPayloadHash: inputPayloadHash(original), attachments: [{ position: attachment.position,
        aliasPath: attachment.aliasPath, contentHash: attachment.contentHash }] }
  })
  const payload = { version: 1, inputKind: 'GENERAL', components }
  const request = { ...f.request, attachments, sealed: { ...f.request.sealed,
    payload, payloadHash: inputPayloadHash(payload) } }
  await f.provider.dispatch(request, f.permit())
  const wire = f.writes[0]; assert.ok(wire)
  const message = wire.message; assert.ok(message && typeof message === 'object' && 'content' in message)
  const content = message.content; assert.ok(Array.isArray(content)); assert.equal(content.length, 3)
  assert.equal(content[0].source.data, bytes[0]?.toString('base64'))
  assert.equal(content[1].source.data, bytes[1]?.toString('base64'))
  assert.equal(content[2].type, 'text')
  const text = content[2].text; assert.ok(typeof text === 'string')
  assert.ok(text.indexOf('Recovery context (JSON)') < text.indexOf('Independent new GENERAL input'))
  assert.ok(text.indexOf('new component 0') < text.indexOf('new component 1'))
  assert.deepEqual(renderRecoverySubmission(request.context, request.sealed).sealed.payload, payload)
  f.emit(f.receipt()); assert.equal(admitted(f).identity.sealedPayloadHash, request.sealed.payloadHash)
})
