import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexProtocolSession, type CodexNativeReceipt } from './protocol.ts'
import type { CodexAppServerConnection, CodexAppServerConnectionHandlers } from '../../../codex/codex-app-server-connection-types'

function fixture() {
  let handlers: CodexAppServerConnectionHandlers = {}
  const calls: { method: string; params: Record<string, unknown> | undefined }[] = []
  let opened: unknown
  let start: (params?: Record<string, unknown>) => unknown | Promise<unknown> = () => ({ turn: { id: 'native-turn-1' } })
  let interrupt: () => unknown | Promise<unknown> = () => ({})
  const connection: CodexAppServerConnection = {
    pid: 12, closed: false,
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/start' || method === 'thread/resume') {return opened ?? { thread: { id: 'native-thread', path: '/fixture/rollout.jsonl' } }}
      if (method === 'turn/start') {return start(params)}
      if (method === 'turn/interrupt') {return interrupt()}
      return {}
    },
    notify() {}, respond() {}, respondWithError() {}, close: async () => true
  }
  let launch: unknown
  const session = new CodexProtocolSession({
    open: async (input, next) => { launch = input; handlers = next; return connection },
    capture: async () => ({ fixture: 'baseline' }), terminate: async () => true,
    now: () => '2026-10-13T00:00:00.000Z', receiptWaitMs: 1
  })
  return {
    session, calls,
    get launch() { return launch },
    opened: (value: unknown) => { opened = value },
    start: (value: typeof start) => { start = value },
    interrupt: (value: typeof interrupt) => { interrupt = value },
    notify: (method: string, params: unknown) => handlers.onNotification?.(method, params)
  }
}
const cold = { command: 'fixture-only', args: ['--dangerously-bypass-approvals-and-sandbox'], cwd: '/fixture/checkout', codexHome: '/fixture/home', resumeThreadId: null }
const submission = { clientMessageId: 'message-1', input: [{ type: 'text' as const, text: 'deterministic fixture input' }], options: { effort: 'high' } }

test('native readiness preserves explicit launch settings, native identity and path', async () => {
  const f = fixture()
  const ready = await f.session.open({ ...cold, args: [] })
  assert.equal(ready.threadId, 'native-thread')
  assert.equal(ready.historyPath, '/fixture/rollout.jsonl')
  assert.deepEqual(f.launch, { command: 'fixture-only', args: ['app-server'], cwd: cold.cwd, env: { CODEX_HOME: cold.codexHome } })
})
test('resume is exact and wrong native thread is refused without dispatch', async () => {
  const f = fixture()
  f.opened({ thread: { id: 'other-thread' } })
  await assert.rejects(f.session.open({ ...cold, resumeThreadId: 'expected-thread', resumePath: '/fixture/saved.jsonl' }), /MISMATCH/)
  assert.deepEqual(f.calls[0].params, { threadId: 'expected-thread', cwd: cold.cwd, path: '/fixture/saved.jsonl', excludeTurns: true })
  assert.equal(f.calls.filter((call) => call.method === 'turn/start').length, 0)
})
test('write-only ACK yields no receipt and retry does not call provider again', async () => {
  const f = fixture()
  await f.session.open(cold)
  f.start(() => ({}))
  const first = await f.session.dispatch(submission)
  assert.equal(first.effect, 'UNKNOWN')
  assert.equal((await f.session.dispatch(submission)).effect, 'UNKNOWN')
  assert.equal(f.calls.filter((call) => call.method === 'turn/start').length, 1)
})
test('response loss stays UNKNOWN and same request never retries', async () => {
  const f = fixture()
  await f.session.open(cold)
  f.start(() => { throw new Error('fixture lost response') })
  assert.equal((await f.session.dispatch(submission)).effect, 'UNKNOWN')
  await f.session.dispatch(submission)
  assert.equal(f.calls.filter((call) => call.method === 'turn/start').length, 1)
})
test('native response owns exact immutable request tuple', async () => {
  const f = fixture()
  await f.session.open(cold)
  const result = await f.session.dispatch(submission)
  assert.equal(result.effect, 'ADMITTED')
  if (result.effect !== 'ADMITTED') {return}
  assert.equal(result.receipt.clientMessageId, submission.clientMessageId)
  assert.equal(result.receipt.threadId, 'native-thread')
  assert.equal(result.receipt.turnId, 'native-turn-1')
  assert.ok(Object.isFrozen(result.receipt))
  assert.ok(f.session.ownsReceipt(result.receipt))
  assert.equal(f.session.ownsReceipt({ ...result.receipt }), false)
})
test('only exact primary thread and client echo admits notification-before-response', async () => {
  const f = fixture()
  await f.session.open(cold)
  f.start(() => {
    f.notify('turn/started', { threadId: 'wrong-thread', turn: { id: 'wrong-turn' }, clientUserMessageId: 'message-1' })
    f.notify('turn/started', { threadId: 'native-thread', turn: { id: 'old-turn' } })
    f.notify('turn/started', { threadId: 'native-thread', turn: { id: 'actual-turn' }, clientUserMessageId: 'message-1' })
    return {}
  })
  const result = await f.session.dispatch(submission)
  assert.equal(result.effect, 'ADMITTED')
  if (result.effect === 'ADMITTED') {assert.equal(result.receipt.turnId, 'actual-turn')}
})
test('interrupt ACK alone is not terminal proof and forged receipt cannot cancel', async () => {
  const f = fixture()
  await f.session.open(cold)
  const sent = await f.session.dispatch(submission)
  assert.equal(sent.effect, 'ADMITTED')
  if (sent.effect !== 'ADMITTED') {return}
  const stopped = await f.session.interrupt(sent.receipt)
  assert.equal(stopped.acknowledged, true)
  assert.equal(stopped.terminal, null)
  const forged = await f.session.interrupt({ ...sent.receipt } as CodexNativeReceipt)
  assert.equal(forged.requested, false)
  assert.equal(f.calls.filter((call) => call.method === 'turn/interrupt').length, 1)
})
test('terminal observation and descendants scope refer only to the original turn', async () => {
  const f = fixture()
  await f.session.open(cold)
  const sent = await f.session.dispatch(submission)
  if (sent.effect !== 'ADMITTED') {throw new Error('fixture admission missing')}
  f.interrupt(() => {
    f.notify('turn/completed', { threadId: 'native-thread', turn: { id: 'wrong-turn', status: 'interrupted' } })
    f.notify('turn/completed', { threadId: 'native-thread', turn: { id: sent.receipt.turnId, status: 'interrupted' } })
    return {}
  })
  const stopped = await f.session.interrupt(sent.receipt)
  assert.equal(stopped.terminal?.turnId, sent.receipt.turnId)
  assert.equal(stopped.terminal?.terminalStatus, 'interrupted')
  assert.equal(stopped.descendantsStopped, true)
})
test('options cannot replace native targeting fields', async () => {
  const f = fixture()
  await f.session.open(cold)
  await assert.rejects(f.session.dispatch({ ...submission, options: { threadId: 'injected-thread' } }), /UNSUPPORTED_OPTION/)
  assert.equal(f.calls.filter((call) => call.method === 'turn/start').length, 0)
})

test('Stop waits for the exact terminal notification arriving after its ACK', async () => {
  const f = fixture()
  await f.session.open(cold)
  const sent = await f.session.dispatch(submission)
  if (sent.effect !== 'ADMITTED') { throw new Error('fixture admission missing') }
  f.interrupt(() => {
    setTimeout(() => f.notify('turn/completed', {threadId: 'native-thread', turn: {id: sent.receipt.turnId, status: 'interrupted'}}), 5)
    return {}
  })
  const stopped = await f.session.interrupt(sent.receipt)
  assert.equal(stopped.terminal?.terminalStatus, 'interrupted')
  assert.equal(stopped.descendantsStopped, true)
  assert.equal(f.calls.filter(call => call.method === 'turn/interrupt').length, 1)
})
