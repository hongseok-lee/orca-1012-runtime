import test from 'node:test'
import assert from 'node:assert/strict'
import { borrowTerminalRuntimeReader } from './terminal-runtime-reader.ts'
import type { ReadyTerminalInputPort } from '../input/runtime-input-types.ts'

function fixture() {
  const calls: string[] = []
  let response: () => Promise<unknown> = async () => ({ live: true })
  const terminal = { supported: () => true, request: async (method: string) => { calls.push(method); return response() } }
  const original = { binding: { sessionId: 'session', tabId: 'tab', terminalHandle: 'handle',
    providerBindingRevision: '1', runtimeUnitId: 'unit', attemptId: 'attempt', podUid: 'pod',
    executionEpoch: '1', connectionInstanceId: 'connection' },
    context: { controller: { scope: 'scope', owner: 'owner', term: '1' } }, terminal } as unknown as ReadyTerminalInputPort
  let port: ReadyTerminalInputPort | null = original
  return { calls, original, lookup: () => port, replace: (next: ReadyTerminalInputPort | null) => { port = next },
    respond: (next: typeof response) => { response = next } }
}

test('read-only observation uses the held control; no owner never starts an Agent', async () => {
  const f = fixture()
  let authorized = 0
  const reader = borrowTerminalRuntimeReader('session', f.lookup, async () => { authorized++ })
  await reader.status(); await reader.read('incarnation', 0)
  assert.deepEqual(f.calls, ['PTY_STATUS', 'PTY_READ'])
  assert.equal(authorized, 4)
  assert.deepEqual(Object.keys(reader).sort(), ['read', 'status'])
  f.replace(null)
  await assert.rejects(reader.status(), /TERMINAL_RUNTIME_UNAVAILABLE/)
  assert.throws(() => borrowTerminalRuntimeReader('session', f.lookup, async () => {}), /TERMINAL_RUNTIME_UNAVAILABLE/)
  assert.equal(f.calls.length, 2)
})

test('replacement during authorization cannot send to either old or new execution', async () => {
  const f = fixture()
  const reader = borrowTerminalRuntimeReader('session', f.lookup, async () => {
    f.replace({ ...f.original, binding: { ...f.original.binding, connectionInstanceId: 'replacement' } })
  })
  await assert.rejects(reader.read('incarnation', 0), /TERMINAL_RUNTIME_UNAVAILABLE/)
  assert.deepEqual(f.calls, [])
})

test('ownership loss while a read is in flight discards its response', async () => {
  const f = fixture()
  const reader = borrowTerminalRuntimeReader('session', f.lookup, async () => {})
  f.respond(async () => { f.replace(null); return { bytes: 'old-output' } })
  await assert.rejects(reader.read('incarnation', 0), /TERMINAL_RUNTIME_UNAVAILABLE/)
  assert.deepEqual(f.calls, ['PTY_READ'])
})
