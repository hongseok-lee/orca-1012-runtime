import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { logicalId, counter } from '../../../../shared/durable-runtime/identity.ts'
import { inputPayloadHash } from '../../input/canonical.ts'
import type { CommandClaim } from '../../runtime/gateway/types.ts'
import type { PodUid } from '../../runtime/runtime-evidence.ts'
import type {
  ProviderDispatchRequest, ProviderEffectPermit, ProviderObservation
} from '../shared/contracts.ts'
import { ClaudeDurableProvider } from './driver.ts'
import type {
  ClaudeColdRequest, ClaudeProtocolConnection, ClaudeProtocolHandlers, OpenClaudeTransport
} from './transport.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function bounded<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('FIXTURE_COLD_DID_NOT_SETTLE')), 500)
    promise.then((value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) })
  })
}
function syntheticCold(open: OpenClaudeTransport) {
  const id = <K extends string>(kind: K) => logicalId(kind, randomUUID())
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Synthetic fixture reference, never authenticated workload identity.
  const podUid = 'cold-focus-pod' as PodUid
  const cold: ClaudeColdRequest = { mode: 'COLD', native: { kind: 'NEW' },
    persistentHome: '/synthetic/home', checkout: '/synthetic/checkout',
    launch: { executable: '/synthetic/cli', args: [], options: {}, env: { HOME: '/synthetic/home' } },
    binding: { sessionId: id('session'), tabId: id('tab'), terminalHandle: 'cold-focus-terminal',
      runtimeUnitId: id('runtime-unit'), attemptId: id('attempt'), podUid,
      providerBindingRevision: counter('row:provider-binding', '1'),
      executionEpoch: counter('execution-epoch', '1'), connectionInstanceId: randomUUID() } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Synthetic TRANSACTION_LOCAL lineage; this shape supplies no authenticated permit.
  const claim = { visibility: 'TRANSACTION_LOCAL', commandId: id('runtime-command'),
    executionToken: id('runtime-command-execution'), executorId: 'cold-focus-executor',
    controllerTerm: counter('controller-term', '1'), identity: { command: 'ensureAttempt',
      inputHash: 'cold-focus-hash', originalEnvelope: { operationId: id('operation'),
        controllerTerm: counter('controller-term', '1'), stepRevision: counter('step-revision', '1'),
        executionEpoch: counter('execution-epoch', '1'), intentRevision: counter('intent-revision', '1'),
        podTarget: 'EXISTING_POD', expectedPodUid: podUid } } } as CommandClaim
  const original = { payload: { text: 'synthetic independent input' }, inputKind: 'GENERAL' }
  const payload = { version: 1, inputKind: 'GENERAL', components: [{ inputId: id('input'),
    original, originalPayloadHash: inputPayloadHash(original), attachments: [] }] }
  const context = { version: 1, sessionId: cold.binding.sessionId, contextRevision: '1', records: [], facts: [] }
  const dispatch: ProviderDispatchRequest = { sealed: { messageId: id('message'),
    sealedRevision: counter('message-revision', '1'), payload, payloadHash: inputPayloadHash(payload) },
    deliveryAttemptId: id('delivery-attempt'), commandClaim: claim, attachments: [],
    context: { version: 1, sessionId: cold.binding.sessionId, revision: counter('context-revision', '1'),
      payload: context, hash: inputPayloadHash(context) } }
  const observations: ProviderObservation[] = []
  let opens = 0
  const driver = new ClaudeDurableProvider(async (request, handlers) => {
    opens++; return open(request, handlers)
  }, (event) => observations.push(event))
  const permit = (): ProviderEffectPermit => ({ async invoke(_identity, effect) { return effect() } })
  return { driver, cold, claim, dispatch, observations, permit, opens: () => opens }
}
function unhandledTracker() {
  const errors: unknown[] = []
  const listener = (reason: unknown) => { errors.push(reason) }
  process.on('unhandledRejection', listener)
  return { errors, close: () => process.off('unhandledRejection', listener) }
}
function connection() {
  let writes = 0
  const transport: ClaudeProtocolConnection = { closed: false,
    async send() { writes++ }, async interrupt() { throw new Error('UNEXPECTED_INTERRUPT') } }
  return { transport, writes: () => writes }
}

test('cold focus: deadline covers delayed opening and late connection cannot publish readiness', async () => {
  const errors = unhandledTracker()
  const opening = deferred<ClaudeProtocolConnection>()
  const opened = connection()
  let handlers: ClaudeProtocolHandlers | undefined
  const f = syntheticCold(async (_request, callbacks) => {
    handlers = callbacks
    callbacks.onMessage({ type: 'system', subtype: 'init', session_id: 'synthetic-native' })
    return opening.promise
  })
  try {
    const rejected = assert.rejects(bounded(f.driver.cold(f.cold, f.claim, f.permit(), 10)), /UNCONFIRMED/)
    await rejected
    assert.equal(f.opens(), 1)
    await assert.rejects(f.driver.cold(f.cold, f.claim, f.permit()), /ALREADY_ACQUIRED/)
    opening.resolve(opened.transport)
    await nextTurn()
    assert.ok(handlers)
    handlers.onMessage({ type: 'system', subtype: 'init', session_id: 'synthetic-native' })
    await assert.rejects(f.driver.dispatch(f.dispatch, f.permit()), /NOT_READY/)
    await assert.rejects(f.driver.cold(f.cold, f.claim, f.permit()), /ALREADY_ACQUIRED/)
    await nextTurn()
    assert.equal(f.opens(), 1); assert.equal(opened.writes(), 0)
    assert.deepEqual(f.observations, []); assert.deepEqual(errors.errors, [])
  } finally { errors.close() }
})

test('cold focus: early fault rejects pending open promptly without an unhandled rejection', async () => {
  const errors = unhandledTracker()
  const opening = deferred<ClaudeProtocolConnection>()
  const f = syntheticCold(async (_request, callbacks) => {
    callbacks.onFault()
    return opening.promise
  })
  try {
    await assert.rejects(bounded(f.driver.cold(f.cold, f.claim, f.permit(), 10_000)), /UNCONFIRMED/)
    opening.reject(new Error('SYNTHETIC_LATE_OPEN_FAILURE'))
    await nextTurn()
    await assert.rejects(f.driver.dispatch(f.dispatch, f.permit()), /NOT_READY/)
    await assert.rejects(f.driver.cold(f.cold, f.claim, f.permit()), /ALREADY_ACQUIRED/)
    assert.equal(f.opens(), 1)
    assert.deepEqual(f.observations, []); assert.deepEqual(errors.errors, [])
  } finally { errors.close() }
})

test('cold focus: denied-before-effect clears starting and allows only a fresh permit retry', async () => {
  const denial = deferred<void>()
  const opened = connection()
  const f = syntheticCold(async (_request, callbacks) => {
    callbacks.onMessage({ type: 'system', subtype: 'init', session_id: 'synthetic-native' })
    return opened.transport
  })
  const denied: ProviderEffectPermit = { async invoke() {
    await denial.promise; throw new Error('SYNTHETIC_COMMIT_NOT_CONFIRMED')
  } }
  const rejected = assert.rejects(bounded(f.driver.cold(f.cold, f.claim, denied)), /COMMIT_NOT_CONFIRMED/)
  await assert.rejects(f.driver.cold(f.cold, f.claim, f.permit()), /ALREADY_ACQUIRED/)
  assert.equal(f.opens(), 0)
  denial.resolve()
  await rejected
  await assert.rejects(f.driver.cold(f.cold, f.claim, denied), /PERMIT_UNAVAILABLE/)
  assert.equal(f.opens(), 0)
  const ready = await bounded(f.driver.cold(f.cold, f.claim, f.permit()))
  assert.equal(ready.sessionId, f.cold.binding.sessionId)
  assert.equal(ready.providerRef.nativeSessionRef, 'synthetic-native')
  assert.equal(f.opens(), 1); assert.equal(opened.writes(), 0)
  assert.deepEqual(f.observations, [])
})

test('hosted cold: a NEW session with its own --session-id is ready on open, and a different init id faults it', async () => {
  let handlers: ClaudeProtocolHandlers | undefined
  const opened = connection()
  const f = syntheticCold(async (_request, callbacks) => { handlers = callbacks; return opened.transport })
  const cold: ClaudeColdRequest = { ...f.cold, launch: { ...f.cold.launch, options: { sessionId: 'preset-native' } } }
  const ready = await bounded(f.driver.cold(cold, f.claim, f.permit(), 200))
  assert.equal(ready.providerRef.nativeSessionRef, 'preset-native')
  assert.equal(f.driver.ownsReadyBinding(ready), false, 'connection id of this fixture driver is its own random id')
  assert.ok(handlers)
  handlers.onMessage({ type: 'system', subtype: 'init', session_id: 'other-native' })
  await assert.rejects(f.driver.dispatch(f.dispatch, f.permit()), /NOT_READY/)
})

test('hosted adopt: a re-attached session observes the native receipt of its own dispatch', async () => {
  let handlers: ClaudeProtocolHandlers | undefined
  const sent: Record<string, unknown>[] = []
  const transport: ClaudeProtocolConnection = { closed: false,
    async send(message) { sent.push(message) }, async interrupt() { throw new Error('UNEXPECTED_INTERRUPT') } }
  const f = syntheticCold(async () => { throw new Error('UNEXPECTED_COLD') })
  const observations: ProviderObservation[] = []
  const driver = new ClaudeDurableProvider(async () => { throw new Error('UNEXPECTED_COLD') }, event => observations.push(event),
    f.cold.binding.connectionInstanceId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: synthetic native reference for the fixture binding.
  const binding = { ...f.cold.binding, providerRef: { provider: 'claude', nativeSessionRef: 'adopted-native' } } as Parameters<typeof driver.adopt>[0]
  await driver.adopt(binding, async callbacks => { handlers = callbacks; return transport })
  assert.equal(driver.ownsReadyBinding(binding), true)
  const result = await driver.dispatch(f.dispatch, f.permit())
  assert.equal(result.state, 'PENDING')
  assert.equal(sent.length, 1)
  assert.ok(handlers)
  handlers.onMessage({ ...sent[0] })
  assert.deepEqual(observations.map(item => item.kind), ['ADMITTED'])
  handlers.onMessage({ type: 'system', subtype: 'init', session_id: 'other-native' })
  assert.equal(driver.ownsReadyBinding(binding), false)
})
