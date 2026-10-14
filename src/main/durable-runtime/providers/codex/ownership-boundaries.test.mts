import assert from 'node:assert/strict'
import test from 'node:test'
import { DurableCodexDriver, type CodexColdLaunch } from './driver.ts'
import { CodexConnectionBusyError } from './protocol.ts'
import type { CodexAppServerConnection, CodexAppServerConnectionHandlers } from '../../../codex/codex-app-server-connection-types'
import type { ProviderBinding, ProviderColdRequest, ProviderDispatchRequest, ProviderEffectPermit, ProviderCancelTarget } from '../shared/contracts.ts'
import { inputPayloadHash } from '../../input/canonical.ts'

// 작성만 한 합성 fixture입니다. 실제 executor의 COMMIT/auth 증거가 아닙니다.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function permit(): ProviderEffectPermit {
  return { invoke: async (_identity, effect) => effect() }
}
const claim = { visibility: 'TRANSACTION_LOCAL', commandId: 'synthetic-command', identity: {},
  executorId: 'synthetic-executor', executionToken: 'synthetic-token', controllerTerm: '1' } as unknown as ProviderDispatchRequest['commandClaim']
function fixture(openWait?: Promise<void>) {
  let handlers: CodexAppServerConnectionHandlers = {}
  let openCalls = 0
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const terminations: { pid: number; baseline: unknown }[] = []
  let start: (params: Record<string, unknown> | undefined, count: number) => unknown = (_params, count) => ({ turn: { id: `synthetic-turn-${count}` } })
  let stopResult = true
  const connection: CodexAppServerConnection = {
    pid: 12, closed: false,
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/start' || method === 'thread/resume') {return { thread: { id: 'synthetic-thread', path: '/synthetic/rollout' } }}
      if (method === 'turn/start') {return start(params, calls.filter(call => call.method === 'turn/start').length)}
      return {}
    }, notify() {}, respond() {}, respondWithError() {}, close: async () => true
  }
  const driver = new DurableCodexDriver({
    open: async (_launch, next) => { openCalls++; handlers = next; if (openWait) {await openWait;} return connection },
    capture: async () => Object.freeze({ beforeTurn: calls.filter(call => call.method === 'turn/start').length }),
    terminate: async (pid, baseline) => { terminations.push({ pid, baseline }); return stopResult },
    receiptWaitMs: 1
  }, () => {})
  const binding = { sessionId: 'synthetic-session', tabId: 'synthetic-tab', terminalHandle: 'synthetic-terminal',
    providerBindingRevision: '1', runtimeUnitId: 'synthetic-unit', attemptId: 'synthetic-attempt', podUid: 'synthetic-pod',
    executionEpoch: '1', connectionInstanceId: driver.connectionInstanceId } as ProviderBinding
  const cold: ProviderColdRequest<CodexColdLaunch> = { mode: 'COLD', binding, native: { kind: 'NEW' },
    persistentHome: '/synthetic/home', checkout: '/synthetic/checkout',
    launch: { command: 'synthetic-not-executed', args: [], options: {} } }
  return { driver, cold, calls, terminations,
    get openCalls() { return openCalls },
    start: (value: typeof start) => { start = value },
    stopResult: (value: boolean) => { stopResult = value },
    notify: (method: string, params: unknown) => handlers.onNotification?.(method, params),
    ready: () => driver.cold(cold, claim, permit()) }
}
function request(suffix = 'first'): ProviderDispatchRequest {
  const original = { text: `synthetic independent input ${suffix}` }
  const payload = { version: 1, inputKind: 'GENERAL', components: [{ inputId: `input-${suffix}`,
    inputSequence: '1', original, originalPayloadHash: inputPayloadHash(original), attachments: [] }] }
  const contextPayload = { historical: 'synthetic recovery context' }
  return { sealed: { messageId: `message-${suffix}`, sealedRevision: '1', payload, payloadHash: inputPayloadHash(payload) },
    context: { version: 1, sessionId: 'synthetic-session', revision: '1', payload: contextPayload, hash: inputPayloadHash(contextPayload) },
    deliveryAttemptId: `delivery-${suffix}`, attachments: [], commandClaim: claim } as unknown as ProviderDispatchRequest
}

test('지연된 open 동시 호출은 transport 하나만 만들고 거절된 permit은 연결을 예약하지 않습니다.', async () => {
  const wait = deferred<void>(), f = fixture(wait.promise)
  const denied: ProviderEffectPermit = { invoke: async () => { throw new Error('SYNTHETIC_PERMIT_DENIED') } }
  await assert.rejects(f.driver.cold(f.cold, claim, denied), /SYNTHETIC_PERMIT_DENIED/)
  assert.equal(f.openCalls, 0)
  const opening = f.ready()
  await assert.rejects(f.ready(), /CODEX_CONNECTION_ALREADY_USED/)
  assert.equal(f.openCalls, 1)
  wait.resolve(undefined)
  const ready = await opening
  assert.equal(ready.connectionInstanceId, f.driver.connectionInstanceId)
  assert.equal(ready.providerRef.nativeSessionRef, 'synthetic-thread')
  assert.equal(ready.sessionId, f.cold.binding.sessionId)
  assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 1)
})

test('미종료 turn과 응답 유실은 다음 delivery를 거절하고 정확한 원 terminal만 연결을 해제합니다.', async () => {
  for (const lost of [false, true]) {
    const f = fixture(); await f.ready()
    if (lost) {f.start(() => { throw new Error('SYNTHETIC_RESPONSE_LOST') })}
    const first = await f.driver.dispatch(request(), permit())
    if (first.state !== 'ADMITTED' && first.state !== 'UNKNOWN') {throw new Error('합성 원 identity가 없습니다.')}
    const checkBusy = (error: unknown) => {
      assert.ok(error instanceof CodexConnectionBusyError)
      assert.equal(error.reason, lost ? 'TURN_UNVERIFIABLE' : 'TURN_ACTIVE')
      assert.equal(error.scope.connectionId, f.driver.connectionInstanceId)
      assert.equal(error.scope.clientMessageId, first.identity.nativeRequestId)
      assert.equal(error.scope.turnId, lost ? null : 'synthetic-turn-1')
      return true
    }
    await assert.rejects(f.driver.dispatch(request('second'), permit()), checkBusy)
    const lookup = await f.driver.dispatch(request(), permit())
    assert.equal(lookup.state, first.state)
    assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1)
    f.notify('turn/completed', { threadId: 'other-thread', turn: { id: 'synthetic-turn-1', status: 'completed' } })
    f.notify('turn/completed', { threadId: 'synthetic-thread', turn: { id: 'other-turn', status: 'completed' } })
    await assert.rejects(f.driver.dispatch(request('second'), permit()), checkBusy)
    if (lost) {f.notify('turn/started', { threadId: 'synthetic-thread', turn: { id: 'synthetic-turn-1' }, clientUserMessageId: first.identity.nativeRequestId })}
    f.notify('turn/completed', { threadId: 'synthetic-thread', turn: { id: 'synthetic-turn-1', status: 'completed' } })
    f.start((_params, count) => ({ turn: { id: `synthetic-turn-${count}` } }))
    const second = await f.driver.dispatch(request('second'), permit())
    assert.equal(second.state, 'ADMITTED')
    if (second.state === 'ADMITTED') {assert.equal(second.admission.providerRef.nativeTurnId, 'synthetic-turn-2')}
    assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 2)
  }
})

test('먼저 확인한 원 descendants 종료는 늦은 terminal과 결합하며 새 turn이나 연결에 재사용하지 않습니다.', async () => {
  const f = fixture(); await f.ready()
  const first = await f.driver.dispatch(request(), permit())
  if (first.state !== 'ADMITTED') {throw new Error('합성 수락이 없습니다.')}
  const target: ProviderCancelTarget = { identity: first.identity, providerRef: first.admission.providerRef }
  const cancelPermit = permit()
  assert.deepEqual(await f.driver.cancel(target, claim, cancelPermit), { state: 'UNCONFIRMED', requested: true })
  assert.equal(f.terminations.length, 1)
  const originalBaseline = f.terminations[0].baseline
  f.notify('turn/completed', { threadId: 'synthetic-thread', turn: { id: 'other-turn', status: 'interrupted' } })
  assert.deepEqual(await f.driver.cancel(target, claim, cancelPermit), { state: 'UNCONFIRMED', requested: false })
  f.notify('turn/completed', { threadId: 'synthetic-thread', turn: { id: 'synthetic-turn-1', status: 'interrupted' } })
  const observed = await f.driver.cancel(target, claim, cancelPermit)
  assert.equal(observed.state, 'OBSERVED')
  if (observed.state === 'OBSERVED') {
    assert.equal(observed.requested, false)
    assert.equal(observed.stopped.targetMessageId, first.identity.messageId)
    assert.equal(observed.stopped.providerRef.nativeTurnId, 'synthetic-turn-1')
  }
  const second = await f.driver.dispatch(request('second'), permit())
  if (second.state !== 'ADMITTED') {throw new Error('합성 새 수락이 없습니다.')}
  assert.equal((await f.driver.cancel(target, claim, cancelPermit)).state, 'OBSERVED')
  assert.equal(f.terminations.length, 1)
  assert.equal(f.calls.filter(call => call.method === 'turn/interrupt').length, 1)
  f.stopResult(false)
  const secondTarget = { identity: second.identity, providerRef: second.admission.providerRef }
  assert.equal((await f.driver.cancel(secondTarget, claim, permit())).state, 'UNCONFIRMED')
  assert.equal(f.terminations.length, 2)
  assert.notEqual(f.terminations[1].baseline, originalBaseline)
  f.notify('turn/completed', { threadId: 'synthetic-thread', turn: { id: 'synthetic-turn-2', status: 'interrupted' } })
  assert.equal((await f.driver.cancel(secondTarget, claim, permit())).state, 'UNCONFIRMED')
  const other = fixture(); await other.ready()
  await other.driver.dispatch(request(), permit())
  assert.notEqual(other.driver.connectionInstanceId, f.driver.connectionInstanceId)
  assert.deepEqual(await other.driver.cancel(target, claim, cancelPermit), { state: 'UNCONFIRMED', requested: false })
  assert.equal(other.terminations.length, 0)
  assert.equal(other.calls.filter(call => call.method === 'turn/interrupt').length, 0)
  assert.equal(f.calls.filter(call => call.method === 'turn/interrupt').length, 2)
})
