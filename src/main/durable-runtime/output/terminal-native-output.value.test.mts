import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { CodexProtocolSession, type CodexNativeNotification } from '../providers/codex/protocol.ts'
import type { CodexAppServerConnectionHandlers, CodexAppServerConnection } from '../../codex/codex-app-server-connection-types.ts'
import { createTerminalCodexOutput } from './terminal-codex-output.ts'
import { projectTerminalNativeHistory } from './terminal-native-projector.ts'
import { terminalCodexPayload, parseTerminalCodexEvent } from './terminal-codex-event.ts'
import type { ReadyProviderBinding } from '../providers/shared/contracts.ts'
import type { CommittedJournalEvent } from './model.ts'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key.ts'

// Synthetic native HTTP/PG-independent controls. No real inference or workload proof is asserted.
const sessionId = randomUUID()
function binding(connectionId: string): ReadyProviderBinding {
  return {sessionId, tabId: randomUUID(), terminalHandle: 'fixture:owned-terminal', providerBindingRevision: '1',
    runtimeUnitId: randomUUID(), attemptId: randomUUID(), podUid: 'fixture-pod', executionEpoch: '1',
    connectionInstanceId: connectionId, providerRef: {provider: 'codex', nativeSessionRef: 'fixture-native-thread'}} as ReadyProviderBinding
}
function event(sequence: number, method: string, params: CodexNativeNotification['params']): CodexNativeNotification {
  return {connectionId: 'fixture-original-connection', sequence: String(sequence), method, params, observedAt: '2026-10-17T04:00:00.000Z'}
}
function journal(events: CodexNativeNotification[]): CommittedJournalEvent[] {
  const original = binding('fixture-original-connection')
  return events.map((notification, index) => ({eventId: randomUUID(), sourceKey: `fixture:${index}`,
    sequence: index + 1, body: terminalCodexPayload(original, notification), committedAt: notification.observedAt}))
}

test('raw protocol callback owns original bytes/sequence and NFS spool precedes READY/PG', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-terminal-output-'))
  chmodSync(root, 0o700)
  let queries = 0
  const pool = {query: async () => { queries++; throw new Error('PG_MUST_NOT_RUN_BEFORE_READY') }} as unknown as Pool
  const output = createTerminalCodexOutput({pool, spoolDirectory: root, current: () => null})
  let handlers: CodexAppServerConnectionHandlers = {}
  const captured: CodexNativeNotification[] = []
  const connection: CodexAppServerConnection = {pid: 0, closed: false,
    async request() { return {thread: {id: 'fixture-native-thread'}} }, notify() {}, respond() {}, respondWithError() {}, async close() { return true }}
  const deps = {open: async (_input: unknown, next: CodexAppServerConnectionHandlers) => {handlers = next; return connection},
    onNativeNotification(raw: CodexNativeNotification) {captured.push(raw); output.onNativeNotification(raw)}}
  const protocol = new CodexProtocolSession(deps)
  deps.onNativeNotification = () => { throw new Error('CALLER_MUTATION_MUST_NOT_REPLACE_CALLBACK') }
  try {
    await protocol.open({command: 'synthetic-only', args: [], cwd: '/fixture', codexHome: '/fixture', resumeThreadId: null})
    const payload = {threadId: 'fixture-native-thread', turnId: 'turn-original', item: {id: 'native-item', type: 'agentMessage', text: '원 출력 α'}}
    handlers.onNotification?.('item/completed', payload)
    payload.item.text = 'changed by caller'
    assert.equal(captured[0].sequence, '1')
    assert.equal((captured[0].params as typeof payload).item.text, '원 출력 α')
    output.onNativeNotification(captured[0])
    await output.drain()
    assert.equal(queries, 0)
    assert.deepEqual(output.snapshot(), {closed: false, failed: false, spooled: 1, pending: 1, committed: 0})
    const lines = readFileSync(path.join(root, 'codex-notifications.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]).record.notification.params.item.text, '원 출력 α')
    assert.throws(() => output.onNativeNotification({...captured[0], method: 'different'}), /SOURCE_CONFLICT/)
    await output.close()
    const reopened = createTerminalCodexOutput({pool, spoolDirectory: root, current: () => null})
    assert.equal(reopened.snapshot().pending, 1)
    await reopened.close()
  } finally { rmSync(root, {recursive: true, force: true}) }
})

test('COMMITTED original Codex items/deltas replay through the existing translator with native IDs', () => {
  const rows = journal([
    event(1, 'turn/started', {threadId: 'fixture-native-thread', turn: {id: 'turn-original'}}),
    event(2, 'item/started', {threadId: 'fixture-native-thread', turnId: 'turn-original', item: {id: 'item-original', type: 'agentMessage', text: ''}}),
    event(3, 'item/agentMessage/delta', {threadId: 'fixture-native-thread', turnId: 'turn-original', itemId: 'item-original', delta: '실제 원본 형식의 '}),
    event(4, 'item/agentMessage/delta', {threadId: 'fixture-native-thread', turnId: 'turn-original', itemId: 'item-original', delta: 'α 출력'}),
    event(5, 'item/completed', {threadId: 'fixture-native-thread', turnId: 'turn-original', item: {id: 'item-original', type: 'agentMessage', text: '실제 원본 형식의 α 출력'}}),
    event(6, 'turn/completed', {threadId: 'fixture-native-thread', turn: {id: 'turn-original', status: 'completed'}})
  ])
  const history = projectTerminalNativeHistory(sessionId, rows, [])
  const assistant = history.filter(row => row.message.role === 'assistant')
  assert.equal(assistant.length, 1)
  assert.deepEqual(assistant[0].message.blocks, [{type: 'text', text: '실제 원본 형식의 α 출력'}])
  assert.equal(assistant[0].message.id, agentJournalItemKey({provider: 'codex', threadId: 'fixture-native-thread', turnId: 'turn-original', ordinal: 0}))
  assert.deepEqual(projectTerminalNativeHistory(sessionId, rows, []), history)
  assert.equal(projectTerminalNativeHistory(sessionId, [], []).length, 0)
})

test('malformed/cross-connection output and unsafe spool ownership fail explicitly', () => {
  assert.throws(() => terminalCodexPayload(binding('other'), event(1, 'item/completed', {})), /CONNECTION/)
  assert.throws(() => parseTerminalCodexEvent({kind: 'TERMINAL_CODEX_NOTIFICATION'}), /FORMAT/)
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-terminal-output-unsafe-'))
  try {
    chmodSync(root, 0o755)
    assert.throws(() => createTerminalCodexOutput({pool: {} as Pool, spoolDirectory: root, current: () => null}), /SPOOL_OWNER/)
  } finally { rmSync(root, {recursive: true, force: true}) }
})
