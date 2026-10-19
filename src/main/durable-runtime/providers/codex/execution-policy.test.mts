import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { DurableCodexDriver, type CodexColdLaunch } from './driver.ts'
import type { CodexExecutionPolicyObservation } from './execution-policy.ts'
import { codexTurnStartParams } from './protocol-types.ts'
import { captureInitialCodexNativePolicy, captureManagedCodexNativePolicy } from '../../runtime/initial-codex-native-policy.ts'
import { inputPayloadHash } from '../../input/canonical.ts'
import type { CodexAppServerConnection, CodexAppServerConnectionHandlers } from '../../../codex/codex-app-server-connection-types'
import type { ProviderBinding, ProviderColdRequest, ProviderDispatchRequest, ProviderEffectPermit, ReadyProviderBinding } from '../shared/contracts.ts'

// In-memory protocol fixtures, not claims of actual native execution or PG ownership.
function fixture() {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  let closes = 0, restricted = false, refused = false, applyTurnPolicy = true
  const observations: CodexExecutionPolicyObservation[] = []
  let handlers: CodexAppServerConnectionHandlers = {}
  const native = captureManagedCodexNativePolicy({
    agentDefaultArgs: { codex: '--model argv-model' }, agentDefaultEnv: { codex: { CUSTOM: 'keep' } },
    nativeChatSessionOptions: { codex: { model: 'selected-model', valuesByModel: { 'selected-model': { effort: 'high' } } } }
  })
  const connection: CodexAppServerConnection = {
    pid: 10, closed: false,
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'thread/start' || method === 'thread/resume') {
        if (refused) { throw new Error('FIXTURE_ADMIN_REFUSAL') }
        return { thread: { id: 'same-native-thread' }, approvalPolicy: restricted ? 'on-request' : 'never',
          sandbox: { type: restricted ? 'readOnly' : 'dangerFullAccess' } }
      }
      // Native settings are applied after the queued-operation response.
      setImmediate(() => {
        if (applyTurnPolicy) { restricted = false }
        handlers.onNotification?.('turn/started', { threadId: 'same-native-thread', turn: { id: 'native-turn' } })
      })
      return { turn: { id: 'native-turn' } }
    }, notify() {}, respond() {}, respondWithError() {}, async close() { closes++; return true }
  }
  const driver = new DurableCodexDriver({ open: async (_launch, next) => { handlers = next; return connection }, attach: async next => { handlers = next; return connection },
    onExecutionPolicyObservation: observation => observations.push(observation) }, () => {})
  const binding = { sessionId: 'session', tabId: 'tab', terminalHandle: 'terminal', providerBindingRevision: '1',
    runtimeUnitId: 'unit', attemptId: 'attempt', podUid: 'pod', executionEpoch: '1', connectionInstanceId: driver.connectionInstanceId } as ProviderBinding
  const cold: ProviderColdRequest<CodexColdLaunch> = { mode: 'COLD', binding, native: { kind: 'NEW' },
    checkout: '/fixture/checkout', persistentHome: '/fixture/home', launch: { command: 'not-executed', args: native.args,
      options: native.options, env: native.env, executionPolicy: native.executionPolicy } }
  return { driver, binding, cold, native, calls, observations, ignoreTurnPolicy: () => { applyTurnPolicy = false }, closes: () => closes,
    restricted: () => { restricted = true }, refused: () => { refused = true } }
}
const claim = { visibility: 'TRANSACTION_LOCAL', commandId: 'command', identity: {}, executorId: 'executor',
  executionToken: 'token', controllerTerm: '1' } as unknown as ProviderDispatchRequest['commandClaim']
function permit(): ProviderEffectPermit { return { invoke: async (_identity, effect) => effect() } }
function request(): ProviderDispatchRequest {
  const original = { text: 'one input' }
  const payload = { version: 1, inputKind: 'GENERAL', components: [{ inputId: 'input', inputSequence: '1', sender: 'device',
    operationKey: 'op', originalPayloadHash: inputPayloadHash(original), original, attachments: [] }] }
  const contextPayload = { completed: [], cancelled: [], unknown: [] }
  return { sealed: { messageId: 'message', sealedRevision: '1', payload, payloadHash: inputPayloadHash(payload as never) },
    context: { version: 1, sessionId: 'session', revision: '1', payload: contextPayload, hash: inputPayloadHash(contextPayload) },
    deliveryAttemptId: 'delivery', attachments: [], commandClaim: claim } as unknown as ProviderDispatchRequest
}

test('managed cold/new and cold/resume propagate policy into the exact digested turn while preserving picks', async () => {
  assert.deepEqual(captureInitialCodexNativePolicy({ agentDefaultArgs: { codex: '' } }).args, [])
  for (const resume of [false, true]) {
    const f = fixture()
    const cold = resume ? { ...f.cold, native: { kind: 'RESUME' as const,
      providerRef: { provider: 'codex' as const, nativeSessionRef: 'same-native-thread' as never } } } : f.cold
    await f.driver.cold(cold, claim, permit())
    const thread = f.calls[0]
    assert.equal(thread.method, resume ? 'thread/resume' : 'thread/start')
    assert.equal(thread.params?.approvalPolicy, 'never')
    assert.equal(thread.params?.sandbox, 'danger-full-access')
    assert.equal(f.native.env.CUSTOM, 'keep')
    const result = await f.driver.dispatch(request(), permit())
    assert.equal(result.state, 'ADMITTED')
    if (result.state !== 'ADMITTED') { throw new Error('fixture receipt absent') }
    const actual = f.calls.find(c => c.method === 'turn/start')!.params!
    assert.equal(actual.approvalPolicy, 'never')
    assert.deepEqual(actual.sandboxPolicy, { type: 'dangerFullAccess' })
    assert.equal(actual.model, 'selected-model'); assert.equal(actual.effort, 'high')
    assert.equal(result.identity.submissionHash, createHash('sha256').update(JSON.stringify(actual)).digest('hex'))
    await f.driver.dispatch(request(), permit())
    assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1)
  }
})

test('adoption resumes the same native identity with policy and keeps it on the next turn', async () => {
  const f = fixture()
  const binding = { ...f.binding, providerRef: { provider: 'codex', nativeSessionRef: 'same-native-thread' } } as ReadyProviderBinding
  await f.driver.adopt(binding, f.cold.checkout, f.native.options, f.native.executionPolicy)
  assert.deepEqual(f.calls[0], { method: 'thread/resume', params: { threadId: 'same-native-thread', cwd: f.cold.checkout,
    excludeTurns: true, approvalPolicy: 'never', sandbox: 'danger-full-access' } })
  await f.driver.dispatch(request(), permit())
  assert.deepEqual(f.calls[1].params?.sandboxPolicy, { type: 'dangerFullAccess' })
  assert.equal(f.closes(), 0)
})

test('cold mismatch or native refusal cannot dispatch or terminate a healthy host; options cannot replace policy', async () => {
  for (const adopt of [false, true]) {
    const f = fixture()
    f.refused()
    const binding = { ...f.binding, providerRef: { provider: 'codex', nativeSessionRef: 'same-native-thread' } } as ReadyProviderBinding
    await assert.rejects(adopt ? f.driver.adopt(binding, f.cold.checkout, {}, f.native.executionPolicy)
      : f.driver.cold(f.cold, claim, permit()), /FIXTURE_ADMIN_REFUSAL/)
    assert.equal(f.driver.ownsReadyBinding(binding), false)
    await assert.rejects(f.driver.dispatch(request(), permit()), /BINDING/)
    assert.equal(f.closes(), 0)
    assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 0)
  }
  const f = fixture(); f.restricted()
  await assert.rejects(f.driver.cold(f.cold, claim, permit()), /CODEX_EXECUTION_POLICY_MISMATCH/)
  assert.equal(f.closes(), 0)
  assert.throws(() => codexTurnStartParams('same-native-thread', { clientMessageId: 'input', input: [],
    options: { approvalPolicy: 'on-request' }, executionPolicy: f.native.executionPolicy }), /OPTION_CONFLICT/)
})

test('loaded-thread resume mismatch stays explicit; normal turn override is read back and failure blocks only later input', async () => {
  for (const apply of [false, true]) {
    const f = fixture(); f.restricted()
    if (!apply) { f.ignoreTurnPolicy() }
    const binding = { ...f.binding, providerRef: { provider: 'codex', nativeSessionRef: 'same-native-thread' } } as ReadyProviderBinding
    await f.driver.adopt(binding, f.cold.checkout, f.native.options, f.native.executionPolicy)
    assert.equal(f.observations[0].state, 'AWAITING_TURN_OVERRIDE')
    assert.equal(f.observations[0].approvalPolicy, 'on-request')
    assert.equal((await f.driver.dispatch(request(), permit())).state, 'ADMITTED')
    assert.equal(f.observations[1].stage, 'TURN')
    assert.equal(f.observations[1].state, apply ? 'CONFIRMED' : 'MISMATCH')
    await f.driver.dispatch(request(), permit())
    assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1)
    assert.equal(f.closes(), 0)
    if (!apply) {
      await assert.rejects(f.driver.dispatch({ ...request(), deliveryAttemptId: 'another-delivery' as never }, permit()), /CODEX_EXECUTION_POLICY_UNCONFIRMED/)
      assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1)
    }
  }
})
