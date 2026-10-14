import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { freezeJournalJson, type CommittedJournalPage, type VerifiedJournalReadScope } from './model.ts'
import { createStructuredHistoryFold } from './structured-history.ts'
import { buildStructuredHistoryPage } from './structured-history-page.ts'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from '../../native-chat/agent-session-wire/agent-session-history-page-bounds.ts'
import type { StructuredProjectionSnapshot } from './structured-projector.ts'

// Read dependency: corrected PR64 product d4399f7705b2d6110ebbf5aeb2ce2f69316c23c6.
// One value callback; the private scope assertion is a fixture premise, not an issuer.
test('값1 실제 fold와 history의 sequence·cursor·byte 경계 및 원문 보존', () => {
  const scope = { principal: fingerprintAttachmentPrincipal('a'.repeat(64)),
    publicSessionId: `structured_${randomUUID().replaceAll('-', '_')}`,
    sessionId: logicalId('session', randomUUID()), workspaceId: logicalId('workspace', randomUUID()) } as VerifiedJournalReadScope
  const agentId = randomUUID(), observedAt = '2026-10-14T17:00:00.000Z'
  const created = { kind: 'STRUCTURED_SESSION_CREATED', version: 1, publicSessionId: scope.publicSessionId,
    sessionId: scope.sessionId, workspaceId: scope.workspaceId, agentId, provider: 'codex',
    runtimeUnitId: randomUUID(), tabId: randomUUID(), originalCreate: { worktree: 'synthetic', agent: 'codex' } }
  const item = (itemId: string, revision = 1, text = itemId) => ({ kind: 'item', itemId, revision,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] } })
  const output = (mutation: unknown) => ({ kind: 'STRUCTURED_PROVIDER_OUTPUT', version: 1,
    publicSessionId: scope.publicSessionId, provider: 'codex', observedAt, source: { kind: 'PRODUCER' }, mutation })
  const bodies = [created, output(item('old')), output({ kind: 'lifecycle-batch', settlementId: 'batch-one',
    mutations: [item('batch-a'), item('batch-b')] }), output(item('old', 2, 'late revision')),
    output({ kind: 'tombstone', itemId: 'batch-a', revision: 2 }), created]
  function page(values: readonly unknown[], first: number, head: number, hasMore = false): CommittedJournalPage {
    return { kind: 'PAGE', scope, head: { epoch: '0', sequence: head },
      cursor: { epoch: '0', sequence: first + values.length - 1 }, hasMore,
      events: values.map((body, offset) => ({ eventId: randomUUID(), sourceKey: `synthetic:${first + offset}`,
        sequence: first + offset, body: freezeJournalJson(body), committedAt: observedAt })), inputs: [] }
  }
  const first = page(bodies.slice(0, 3), 1, 6, true), second = page(bodies.slice(3), 4, 6)
  const original = JSON.stringify([first, second])
  const fold = createStructuredHistoryFold(scope, { agentId, provider: 'codex', epoch: '0', headSequence: 6, fence: 17 })
  fold.applyPage(first)
  // The batch is selected as one creation-sequence group even with limit 1.
  const initial = fold.finish({ sessionId: scope.publicSessionId, direction: 'tail', limit: 1 })
  assert.equal(initial.ok, true)
  assert.deepEqual(initial.page.items.map(value => value.itemId), ['batch-a', 'batch-b'])
  assert.deepEqual(initial.page.items.map(value => value.sequence), [3, 3])
  const before = fold.finish({ sessionId: scope.publicSessionId, direction: 'before', cursor: { epoch: '0', sequence: 3 }, limit: 1 })
  assert.deepEqual(before.page.items.map(value => value.itemId), ['old'])
  fold.applyPage(second)
  const after = fold.finish({ sessionId: scope.publicSessionId, direction: 'after', cursor: { epoch: '0', sequence: 3 }, limit: 1 })
  assert.equal(after.page.items[0].itemId, 'old'); assert.equal(after.page.items[0].sequence, 2)
  assert.equal(after.page.items[0].revision, 2); assert.equal(after.page.window.nextCursor.sequence, 4)
  assert.equal(after.page.hasNewer, true); assert.equal(after.page.fence, 17); assert.equal(after.page.epoch, '0')
  const removed = fold.finish({ sessionId: scope.publicSessionId, direction: 'after', cursor: { epoch: '0', sequence: 4 }, limit: 1 })
  assert.deepEqual(removed.page.removedItemIds, ['batch-a']); assert.equal(removed.page.window.nextCursor.sequence, 5)
  const metadata = fold.finish({ sessionId: scope.publicSessionId, direction: 'after', cursor: { epoch: '0', sequence: 5 }, limit: 1 })
  assert.deepEqual(metadata.page.items, []); assert.deepEqual(metadata.page.removedItemIds, [])
  assert.equal(metadata.page.window.nextCursor.sequence, 6); assert.equal(metadata.page.hasNewer, false)
  const empty = fold.finish({ sessionId: scope.publicSessionId, direction: 'after', cursor: { epoch: '0', sequence: 6 } })
  assert.deepEqual(empty.page.items, []); assert.equal(empty.page.window.nextCursor.sequence, 6)
  for (const [cursor, reason] of [[{ epoch: '1', sequence: 0 }, 'epoch_changed'], [{ epoch: '0', sequence: 7 }, 'cursor_ahead']] as const) {
    const reset = fold.finish({ sessionId: scope.publicSessionId, direction: 'after', cursor })
    assert.equal(reset.ok, false); if (reset.ok) { throw new Error('Expected actual bounded tail reset') }
    assert.equal(reset.reset, reason); assert.equal(reset.page.direction, 'tail')
    assert.deepEqual(reset.page.items.map(value => value.itemId), ['old', 'batch-b'])
    assert.equal(reset.page.liveCursor?.sequence, 6); assert.equal(reset.page.fence, 17)
  }
  const large = 'x'.repeat(HISTORY_PAGE_CONTENT_BUDGET_BYTES + 1000)
  const snapshot: StructuredProjectionSnapshot = { sessionId: scope.publicSessionId, epoch: '0', cursor: { epoch: '0', sequence: 2 },
    items: [{ itemId: 'large', revision: 1, sequence: 1, observedAt: Date.parse(observedAt),
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: large }] } }], submissions: [], unprojectedEvents: [] }
  const beforeBytes = JSON.stringify(snapshot)
  const bounded = buildStructuredHistoryPage(snapshot, [{ sequence: 1, itemIds: ['large'], clientMessageIds: [] }],
    { sessionId: scope.publicSessionId, direction: 'after', cursor: { epoch: '0', sequence: 0 } }, 17)
  assert.equal(bounded.ok, true); assert.equal(bounded.page.items[0].body.kind, 'status')
  assert.equal(bounded.page.window.nextCursor.sequence, 1); assert.equal(JSON.stringify(snapshot), beforeBytes)
  const hugeRemoval = buildStructuredHistoryPage({ ...snapshot, items: [] },
    [{ sequence: 1, itemIds: [large], clientMessageIds: [] }],
    { sessionId: scope.publicSessionId, direction: 'after', cursor: { epoch: '0', sequence: 0 } }, 17)
  assert.equal(hugeRemoval.ok, false); if (!hugeRemoval.ok) { assert.equal(hugeRemoval.reset, 'cursor_compacted') }
  // Shrinking keeps the first raw row and never advances over an undelivered removal.
  const shrunk = buildStructuredHistoryPage({ ...snapshot, items: [] }, [
    { sequence: 1, itemIds: [], clientMessageIds: [] }, { sequence: 2, itemIds: [large], clientMessageIds: [] }],
    { sessionId: scope.publicSessionId, direction: 'after', cursor: { epoch: '0', sequence: 0 }, limit: 2 }, 17)
  assert.equal(shrunk.ok, true); assert.equal(shrunk.page.window.nextCursor.sequence, 1); assert.equal(shrunk.page.hasNewer, true)
  for (const [body, code] of [[{ kind: 'INPUT_OBSERVATION', version: 1 }, 'STRUCTURED_HISTORY_UNPROJECTED_EVENT'],
    [{ ...created, version: 2 }, 'STRUCTURED_HISTORY_UNREADABLE'],
    [{ ...created, workspaceId: randomUUID() }, 'STRUCTURED_HISTORY_UNREADABLE']] as const) {
    const invalid = createStructuredHistoryFold(scope, { agentId, provider: 'codex', epoch: '0', headSequence: 1, fence: 17 })
    assert.throws(() => invalid.applyPage(page([body], 1, 1)), { code })
  }
  assert.equal(JSON.stringify([first, second]), original)
})
