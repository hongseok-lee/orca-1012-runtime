import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DurableCodexDriver, type CodexColdLaunch } from './driver.ts'
import type { CodexAppServerConnection, CodexAppServerConnectionHandlers } from '../../../codex/codex-app-server-connection-types'
import type { ProviderBinding, ProviderColdRequest, ProviderDispatchRequest, ProviderEffectPermit,
  ProviderObservation, ProviderCancelTarget } from '../shared/contracts.ts'
import { inputPayloadHash, canonicalInputJson } from '../../input/canonical.ts'

// Synthetic fixtures exercise protocol parsing, not real COMMIT/authentication.
function fixturePermit() {
  let calls = 0
  const permit: ProviderEffectPermit = { invoke: async (_identity, effect) => { calls++; return effect() } }
  return { permit, get calls() { return calls } }
}
const claim = { visibility: 'TRANSACTION_LOCAL', commandId: 'fixture-command', identity: {},
  executorId: 'fixture-executor', executionToken: 'fixture-token', controllerTerm: '1' } as unknown as ProviderDispatchRequest['commandClaim']
function fixture() {
  let handlers: CodexAppServerConnectionHandlers = {}
  let launch: unknown
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const events: ProviderObservation[] = []
  let start: (params?: Record<string, unknown>) => unknown = () => ({ turn: { id: 'fixture-turn' } })
  let interrupt: () => unknown = () => ({})
  let terminateCalls = 0
  let nativeThread = 'fixture-thread'
  const connection: CodexAppServerConnection = {
    pid: 123, closed: false,
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: nativeThread, path: '/synthetic/rollout' } }
      if (method === 'turn/start') return start(params)
      if (method === 'turn/interrupt') return interrupt()
      return {}
    }, notify() {}, respond() {}, respondWithError() {}, close: async () => true
  }
  const driver = new DurableCodexDriver({
    open: async (value, next) => { launch = value; handlers = next; return connection },
    capture: async () => ({ synthetic: 'original-baseline' }),
    terminate: async () => { terminateCalls++; return true }, receiptWaitMs: 1,
    now: () => '2026-10-13T00:00:00.000Z'
  }, (event) => events.push(event))
  const binding = { sessionId: 'fixture-session', tabId: 'fixture-tab', terminalHandle: 'fixture-terminal',
    providerBindingRevision: '1', runtimeUnitId: 'fixture-unit', attemptId: 'fixture-attempt', podUid: 'fixture-pod',
    executionEpoch: '1', connectionInstanceId: driver.connectionInstanceId } as ProviderBinding
  const cold: ProviderColdRequest<CodexColdLaunch> = { mode: 'COLD', binding, native: { kind: 'NEW' },
    persistentHome: '/synthetic/home', checkout: '/synthetic/checkout',
    launch: { command: 'synthetic-not-executed', args: ['--dangerously-bypass-approvals-and-sandbox', ''], options: { model: '', effort: 'high' } } }
  return { driver, binding, cold, calls, events,
    get launch() { return launch }, get terminateCalls() { return terminateCalls },
    start: (value: typeof start) => { start = value }, interrupt: (value: typeof interrupt) => { interrupt = value },
    thread: (value: string) => { nativeThread = value },
    notify: (method: string, params: unknown) => handlers.onNotification?.(method, params),
    exit: () => handlers.onExit?.(new Error('synthetic exit')),
    ready: () => driver.cold(cold, claim, fixturePermit().permit) }
}
function request(kind = 'GENERAL', components?: unknown[]): ProviderDispatchRequest {
  const original = { text: 'independent synthetic input' }
  const payload = { version: 1, inputKind: kind, components: components ?? [{ inputId: 'fixture-input', inputSequence: '1',
    sender: 'fixture-device', operationKey: 'fixture-op', originalPayloadHash: inputPayloadHash(original), original, attachments: [] }] }
  const contextPayload = { completed: ['synthetic-completed'], cancelled: ['synthetic-cancelled'], unknown: ['synthetic-unknown'] }
  return { sealed: { messageId: 'fixture-message', sealedRevision: '1', payload, payloadHash: inputPayloadHash(payload as never) },
    context: { version: 1, sessionId: 'fixture-session', revision: '1', payload: contextPayload, hash: inputPayloadHash(contextPayload) },
    deliveryAttemptId: 'fixture-delivery', attachments: [], commandClaim: claim } as unknown as ProviderDispatchRequest
}
test('Cold is behind the one-use synthetic executor capability and preserves launch settings', async () => {
  const f = fixture(), permit = fixturePermit()
  assert.equal(f.calls.length, 0)
  const ready = await f.driver.cold(f.cold, claim, permit.permit)
  assert.equal(permit.calls, 1)
  assert.equal(ready.providerRef.nativeSessionRef, 'fixture-thread')
  assert.equal(ready.sessionId, f.binding.sessionId)
  assert.deepEqual(f.launch, { command: f.cold.launch.command, args: [...f.cold.launch.args, 'app-server'],
    cwd: f.cold.checkout, env: { CODEX_HOME: f.cold.persistentHome } })
  await assert.rejects(f.driver.dispatch(request(), permit.permit), /PERMIT/)
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 0)
})
test('TRANSACTION_LOCAL without an executor capability cannot invoke native Cold', async () => {
  const f = fixture()
  await assert.rejects(f.driver.cold(f.cold, claim, {} as ProviderEffectPermit), /PERMIT/)
  assert.equal(f.calls.length, 0)
})
test('Cold rejects foreign connection and mismatched resume identity', async () => {
  const f = fixture()
  await assert.rejects(f.driver.cold({ ...f.cold, binding: { ...f.binding, connectionInstanceId: 'other-connection' } }, claim, fixturePermit().permit), /MISMATCH/)
  assert.equal(f.calls.length, 0)
  const ref = { provider: 'codex', nativeSessionRef: 'expected-thread' } as never
  await assert.rejects(f.driver.cold({ ...f.cold, native: { kind: 'RESUME', providerRef: ref } }, claim, fixturePermit().permit), /MISMATCH/)
  assert.equal(f.calls[0].params?.threadId, 'expected-thread')
})
test('exact native receipt binds immutable admission and context proof to original lineage', async () => {
  const f = fixture(); await f.ready()
  const r = request(), permit = fixturePermit()
  const result = await f.driver.dispatch(r, permit.permit)
  assert.equal(result.state, 'ADMITTED')
  if (result.state !== 'ADMITTED') return
  assert.equal(result.admission.messageId, r.sealed.messageId)
  assert.equal(result.admission.deliveryAttemptId, r.deliveryAttemptId)
  assert.equal(result.admission.providerRef.nativeTurnId, 'fixture-turn')
  assert.equal(result.contextDelivery.contextHash, r.context.hash)
  assert.equal(result.contextDelivery.contextRevision, r.context.revision)
  assert.equal(result.contextDelivery.providerBindingRevision, f.binding.providerBindingRevision)
  assert.ok(Object.isFrozen(result.identity.binding) && Object.isFrozen(result.contextDelivery))
  const wire = f.calls.find(c => c.method === 'turn/start')?.params
  assert.equal(wire?.model, '')
  const text = (wire?.input as { text: string }[])[0].text
  assert.ok(text.indexOf(canonicalInputJson(r.context as never)) < text.indexOf(canonicalInputJson(r.sealed.payload)))
  assert.match(text, /do not automatically continue/)
  assert.match(text, /Do not repeat uncertain external effects/)
  assert.equal(f.events.filter(e => e.kind === 'ADMITTED').length, 1)
  assert.equal((await f.driver.dispatch(r, fixturePermit().permit)).state, 'ADMITTED')
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1)
})
test('write ACK and response loss remain UNKNOWN without admission/context proof or retry', async () => {
  for (const start of [() => ({}), () => { throw new Error('synthetic response loss') }]) {
    const f = fixture(); await f.ready(); f.start(start)
    const first = fixturePermit(), second = fixturePermit()
    assert.equal((await f.driver.dispatch(request(), first.permit)).state, 'UNKNOWN')
    assert.equal((await f.driver.dispatch(request(), second.permit)).state, 'UNKNOWN')
    assert.equal(first.calls, 1); assert.equal(second.calls, 0)
    assert.equal(f.events.filter(e => e.kind === 'ADMITTED').length, 0)
    assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1)
  }
})
test('late exact echo reconciles original UNKNOWN without a new provider call; foreign echoes do not', async () => {
  const f = fixture(); await f.ready(); f.start(() => ({}))
  const sent = await f.driver.dispatch(request(), fixturePermit().permit)
  if (sent.state !== 'UNKNOWN') throw new Error('synthetic UNKNOWN missing')
  f.notify('turn/started', { threadId: 'foreign-thread', turn: { id: 'foreign-turn' }, clientUserMessageId: sent.identity.nativeRequestId })
  f.notify('turn/started', { threadId: 'fixture-thread', turn: { id: 'unidentified-turn' } })
  assert.equal(f.events.filter(e => e.kind === 'ADMITTED').length, 0)
  f.notify('turn/started', { threadId: 'fixture-thread', turn: { id: 'late-original-turn' }, clientUserMessageId: sent.identity.nativeRequestId })
  assert.equal((await f.driver.dispatch(request(), fixturePermit().permit)).state, 'ADMITTED')
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1)
  f.exit()
  f.notify('turn/started', { threadId: 'fixture-thread', turn: { id: 'post-close-turn' }, clientUserMessageId: sent.identity.nativeRequestId })
  assert.equal(f.events.filter(e => e.kind === 'ADMITTED').length, 1)
})
test('unsupported channels and context-only input never wake a turn', async () => {
  const f = fixture(); await f.ready()
  for (const r of [request('COMMAND'), request('QUESTION_RESPONSE'), request('APPROVAL_RESPONSE'), request('GENERAL', [])]) {
    const permit = fixturePermit()
    assert.equal((await f.driver.dispatch(r, permit.permit)).state, 'UNSUPPORTED')
    assert.equal(permit.calls, 0)
  }
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 0)
})
test('materialized attachment bytes/hash and component order are preserved in one submission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-provider-fixture-'))
  try {
    const bytes = [Buffer.from([137,80,78,71,13,10,26,10,1]), Buffer.from([137,80,78,71,13,10,26,10,2])]
    const attachments = await Promise.all(bytes.map(async (b, i) => {
      const path = join(dir, `image-${i}`); await writeFile(path, b)
      return { inputId: `input-${i}`, position: '0', aliasPath: `alias-${i}`, contentHash: createHash('sha256').update(b).digest('hex'), path }
    }))
    const components = attachments.map((a, i) => { const original = { text: `ordered-${i}`, attachment: a.aliasPath }
      return { inputId: a.inputId, inputSequence: String(i), original, originalPayloadHash: inputPayloadHash(original),
        attachments: [{ position: a.position, aliasPath: a.aliasPath, contentHash: a.contentHash }] } })
    const r = { ...request('GENERAL', components), attachments }
    const f = fixture(); await f.ready()
    assert.equal((await f.driver.dispatch(r, fixturePermit().permit)).state, 'ADMITTED')
    const input = f.calls.find(c => c.method === 'turn/start')?.params?.input as { text?: string; url?: string }[]
    assert.ok(input[0].text!.indexOf('ordered-0') < input[0].text!.indexOf('ordered-1'))
    assert.equal(input[1].url, `data:image/png;base64,${bytes[0].toString('base64')}`)
    assert.equal(input[2].url, `data:image/png;base64,${bytes[1].toString('base64')}`)
    const g = fixture(); await g.ready()
    await writeFile(attachments[0].path, 'changed after materialization')
    await assert.rejects(g.driver.dispatch(r, fixturePermit().permit), /HASH_MISMATCH/)
    assert.equal(g.calls.filter(c => c.method === 'turn/start').length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('cancel ACK alone is unconfirmed; forged turn and connection cannot invoke interrupt', async () => {
  const f = fixture(); await f.ready()
  const result = await f.driver.dispatch(request(), fixturePermit().permit)
  if (result.state !== 'ADMITTED') throw new Error('fixture missing')
  const target: ProviderCancelTarget = { identity: result.identity, providerRef: result.admission.providerRef }
  assert.equal((await f.driver.cancel(target, claim, fixturePermit().permit)).state, 'UNCONFIRMED')
  const wrong = { ...target, providerRef: { ...target.providerRef, nativeTurnId: 'new-foreign-turn' } } as ProviderCancelTarget
  assert.deepEqual(await f.driver.cancel(wrong, claim, fixturePermit().permit), { state: 'UNCONFIRMED', requested: false })
  assert.equal(f.calls.filter(c => c.method === 'turn/interrupt').length, 1)
})
test('exact interrupted terminal plus verified descendants is required for stopped proof', async () => {
  const f = fixture(); await f.ready()
  const result = await f.driver.dispatch(request(), fixturePermit().permit)
  if (result.state !== 'ADMITTED') throw new Error('fixture missing')
  f.interrupt(() => { f.notify('turn/completed', { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'interrupted' } }); return {} })
  const stopped = await f.driver.cancel({ identity: result.identity, providerRef: result.admission.providerRef }, claim, fixturePermit().permit)
  assert.equal(stopped.state, 'OBSERVED')
  if (stopped.state === 'OBSERVED') assert.equal(stopped.stopped.targetMessageId, result.identity.messageId)
  assert.equal(f.terminateCalls, 1)
})
test('old target baseline never terminates descendants belonging to a later turn', async () => {
  const f = fixture(); await f.ready()
  const first = await f.driver.dispatch(request(), fixturePermit().permit)
  if (first.state !== 'ADMITTED') throw new Error('fixture missing')
  f.start(() => ({ turn: { id: 'new-turn' } }))
  const r = { ...request(), deliveryAttemptId: 'second-delivery' as ProviderDispatchRequest['deliveryAttemptId'] }
  await f.driver.dispatch(r, fixturePermit().permit)
  assert.deepEqual(await f.driver.cancel({ identity: first.identity, providerRef: first.admission.providerRef }, claim, fixturePermit().permit), { state: 'UNCONFIRMED', requested: false })
  assert.equal(f.terminateCalls, 0)
  assert.equal(f.calls.filter(c => c.method === 'turn/interrupt').length, 0)
})
test('native wire bytes hash includes the exact primary thread and request fields', async () => {
  const f = fixture(); await f.ready()
  const result = await f.driver.dispatch(request(), fixturePermit().permit)
  if (result.state !== 'ADMITTED') throw new Error('fixture admission missing')
  const actual = f.calls.find(c => c.method === 'turn/start')!.params!
  assert.equal(result.identity.submissionHash, createHash('sha256').update(JSON.stringify(actual)).digest('hex'))
  assert.equal(actual.threadId, result.admission.providerRef.nativeSessionRef)
  assert.equal(actual.clientUserMessageId, result.identity.nativeRequestId)
})
