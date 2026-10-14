import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES, MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS } from '../../native-chat/agent-session-journal/journal-row-schema.ts'
import { parseStructuredProviderEvent } from './structured-provider-event.ts'

// One value callback only. Synthetic provider data is not CLI/authentication evidence.
test('structured provider payload: real render shapes, strict envelope and detached capture', () => {
  const item = { kind: 'item', itemId: 'provider-item-1', revision: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'synthetic output' }] } }
  const tombstone = { kind: 'tombstone', itemId: 'provider-item-1', revision: 2 }
  const batch = { kind: 'lifecycle-batch', settlementId: 'provider-settlement-1', mutations: [item, tombstone] }
  const input = (mutation: unknown = item) => ({ version: 1, kind: 'STRUCTURED_PROVIDER_OUTPUT',
    publicSessionId: 'public_session_fixture', provider: 'claude', observedAt: '2026-10-14T13:33:00.000Z',
    source: { kind: 'PRODUCER' }, mutation })
  for (const mutation of [item, tombstone, batch]) {
    const original = input(mutation)
    const captured = parseStructuredProviderEvent(original)
    assert.deepEqual(JSON.parse(JSON.stringify(captured)), original)
    assert.notEqual(captured.mutation, mutation)
    assert.ok(Object.isFrozen(captured.mutation))
  }
  const native = { ...input(), provider: 'codex', source: { kind: 'NATIVE', lineage: 'original-thread', nativeEventId: 'original-event-17' } }
  assert.equal(parseStructuredProviderEvent(native).source.kind, 'NATIVE')
  const original = input(batch)
  const captured = parseStructuredProviderEvent(original)
  item.body.blocks[0].text = 'caller mutation'
  item.revision = 50
  batch.mutations.reverse()
  original.source.kind = 'changed'
  assert.equal(captured.source.kind, 'PRODUCER')
  assert.equal(captured.mutation.kind, 'lifecycle-batch')
  if (captured.mutation.kind === 'lifecycle-batch') {
    assert.equal(captured.mutation.mutations[0].kind, 'item')
    const first = captured.mutation.mutations[0]
    assert.equal(first.revision, 1)
    if (first.kind === 'item') { assert.equal(JSON.stringify(first.body).includes('synthetic output'), true) }
    assert.ok(Object.isFrozen(captured.mutation.mutations))
  }
  for (const value of [
    { ...input(), extra: true }, { ...input(), version: 2 }, { ...input(), kind: 'INPUT_OBSERVATION' },
    { ...input(), provider: 'other' }, { ...input(), publicSessionId: ' ' },
    { ...input(), observedAt: '2026-10-14T13:33:00Z' },
    { ...input(), source: { kind: 'PRODUCER', sequence: '1' } },
    { ...input(), source: { kind: 'NATIVE', lineage: '', nativeEventId: 'e' } },
    input({ ...tombstone, extra: true }), input({ ...tombstone, revision: 0 }),
    input({ ...tombstone, revision: 1.5 }), input({ ...tombstone, revision: Number.MAX_SAFE_INTEGER + 1 }),
    input({ ...tombstone, revision: Infinity }), input({ ...tombstone, itemId: '' }),
    input({ ...item, body: { kind: 'question', question: 'q', options: null, resolution: { state: 'pending', choice: null } } }),
    input({ kind: 'dispatch', dispatchId: 'd' }),
    input({ ...batch, settlementId: ' ' }), input({ ...batch, mutations: [batch] }),
    input({ ...batch, mutations: Array.from({ length: MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS + 1 }, () => tombstone) }),
    input({ ...batch, mutations: [{ ...item, body: { kind: 'message', role: 'assistant',
      blocks: [{ type: 'text', text: 'x'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES) }] } }] }),
    Object.assign(Object.create({ inherited: true }), input()),
    Object.defineProperty(input(), 'provider', { get: () => 'claude', enumerable: true })
  ]) { assert.throws(() => parseStructuredProviderEvent(value)) }
})
