import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { freezeJournalJson, journalSafeCounter, type VerifiedJournalReadScope, type CommittedJournalPage } from './model.ts'
import { projectCommittedInputIdentity } from './project.ts'
import { readCommittedSessionJournal } from './read.ts'

const sessionId = logicalId('session', '00000000-0000-0000-0000-000000000001')
const workspaceId = logicalId('workspace', '00000000-0000-0000-0000-000000000002')
const principal = fingerprintAttachmentPrincipal('a'.repeat(64))
const other = fingerprintAttachmentPrincipal('b'.repeat(64))
// Fixture-only assertions do not authenticate or supply runtime authority.
const scope = { sessionId, workspaceId, publicSessionId: 'session_fixture', principal } as VerifiedJournalReadScope
function page(entries: readonly { id: string; principal: string; key: string; structured?: boolean }[]): CommittedJournalPage {
  const body = { kind: 'message', role: 'user', blocks: [
    { type: 'text', text: '  original text \n' }, { type: 'image-ref', path: '/immutable/second' },
    { type: 'image-ref', path: '/immutable/first' }
  ] }
  return {
    kind: 'PAGE', scope, head: { epoch: '0', sequence: entries.length }, cursor: { epoch: '0', sequence: entries.length }, hasMore: false,
    events: entries.map((entry, index) => ({ eventId: entry.id, sourceKey: 'fixture-only', sequence: index + 1,
      body: freezeJournalJson({ kind: 'INPUT_SUBMISSION', inputId: entry.id }), committedAt: '2026-10-13T00:00:00Z' })),
    inputs: entries.map((entry, index) => ({ inputId: entry.id, messageId: sessionId, sessionId, inputSequence: String(index + 1),
      principal: entry.principal, operationKey: entry.key, originalPayloadHash: 'c'.repeat(64),
      original: freezeJournalJson({ version: 1, payload: { body } }), attachments: [],
      submission: entry.structured === false ? null : { principal: entry.principal, clientMessageId: entry.key,
        wirePayloadFingerprint: 'd'.repeat(64), wireFence: '1', journalEpoch: '0', journalSequence: String(index + 1),
        submittedAt: '2026-10-13T00:00:00Z' } }))
  }
}
test('same principal retry keeps the exact original orca key and pending receipt', () => {
  const input = page([{ id: sessionId, principal, key: 'original:operation/%' }])
  const first = projectCommittedInputIdentity(input)
  const retry = projectCommittedInputIdentity(input)
  assert.equal(first.items[0].itemId, agentJournalSubmissionKey('original:operation/%'))
  assert.deepEqual(retry, first)
  assert.equal(first.submissions[0].dispatchState, 'pending')
  assert.equal(first.submissions[0].providerItemId, null)
})
test('other principal same key and legacy inputs keep bodies with opaque Input keys', () => {
  const projected = projectCommittedInputIdentity(page([
    { id: sessionId, principal, key: 'same-key' },
    { id: workspaceId, principal: other, key: 'same-key' },
    { id: '00000000-0000-0000-0000-000000000003', principal, key: 'legacy', structured: false }
  ]))
  assert.deepEqual(projected.items.map((item) => item.itemId), [agentJournalSubmissionKey('same-key'), `input:${workspaceId}`,
    'input:00000000-0000-0000-0000-000000000003'])
  assert.equal(projected.submissions.length, 1)
  assert.deepEqual(projected.items[0].body, projected.items[1].body)
  const body = projected.items[1].body
  assert.equal(body.kind, 'message')
  if (body.kind === 'message') {
    assert.deepEqual(body.blocks, [{ type: 'text', text: '  original text \n' },
      { type: 'image-ref', path: '/immutable/second' }, { type: 'image-ref', path: '/immutable/first' }])
    assert.ok(Object.isFrozen(body.blocks))
  }
})
test('different operations with identical bodies are not merged', () => {
  const result = projectCommittedInputIdentity(page([
    { id: sessionId, principal, key: 'op-one' }, { id: workspaceId, principal, key: 'op-two' }
  ]))
  assert.equal(result.items.length, 2)
  assert.notEqual(result.items[0].itemId, result.items[1].itemId)
  assert.deepEqual(result.items[0].body, result.items[1].body)
})
test('unsafe counters and unknown input bodies refuse projection; unknown raw kinds stay explicit', () => {
  assert.equal(journalSafeCounter('9007199254740991'), Number.MAX_SAFE_INTEGER)
  assert.throws(() => journalSafeCounter('9007199254740992'), { code: 'JOURNAL_COUNTER_UNREADABLE' })
  const original = page([{ id: sessionId, principal, key: 'op' }])
  assert.throws(() => projectCommittedInputIdentity({ ...original, inputs: [{ ...original.inputs[0],
    original: freezeJournalJson({ version: 2, payload: { body: { kind: 'future' } } }) }] }), { code: 'JOURNAL_INPUT_BODY_UNREADABLE' })
  const event = { ...original.events[0], body: freezeJournalJson({ kind: 'FUTURE_KIND', version: 99, original: ' preserved ' }) }
  const result = projectCommittedInputIdentity({ ...original, events: [event], inputs: [] })
  assert.equal(result.items.length, 0)
  assert.deepEqual(result.unprojectedEvents, [event])
})
test('scope/cursor/limit and pool receiver are fixed before the first await', async () => {
  let release!: (client: PoolClient) => void
  const checkout = new Promise<PoolClient>((resolve) => { release = resolve })
  const queries: { sql: string; values: unknown[] }[] = []
  const client = {
    async query(sql: string, values: unknown[] = []) {
      queries.push({ sql, values })
      if (sql.includes('structured_session_aliases')) { return { rowCount: 1, rows: [{ session_id: sessionId,
        workspace_id: workspaceId, journal_epoch: '0', head: '0' }] } }
      if (sql.includes('min(seq)')) { return { rowCount: 1, rows: [{ first: null }] } }
      return { rowCount: 0, rows: [] }
    }, release() {}
  } as unknown as PoolClient
  const callerScope = { ...scope }
  const request = { cursor: { epoch: '0', sequence: 0 }, limit: 1 }
  const pool = { connect() { assert.equal(this, pool); return checkout } } as unknown as Pool
  const read = readCommittedSessionJournal(pool, callerScope, request)
  callerScope.principal = other
  callerScope.publicSessionId = 'changed_alias'
  request.cursor.epoch = '99'
  request.cursor.sequence = 9
  request.limit = 200
  pool.connect = () => { throw new Error('replacement must not be called') }
  release(client)
  const result = await read
  assert.equal(result.kind, 'PAGE')
  if (result.kind === 'PAGE') {
    assert.equal(result.scope.principal, principal)
    assert.deepEqual(result.cursor, { epoch: '0', sequence: 0 })
  }
  assert.equal(queries.find((query) => query.sql.includes('structured_session_aliases'))!.values[0], 'session_fixture')
  assert.equal(queries.find((query) => query.sql.includes('ORDER BY seq'))!.values[4], 1)
  assert.equal(queries[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
})
