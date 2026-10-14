import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import type { CommittedJournalEvent, OriginalInputComponent, VerifiedJournalReadScope, FrozenJson } from './model.ts'
import { createStructuredJournalProjection } from './structured-projector.ts'

// Synthetic read scope only: this callback is not authentication/PG/provider evidence.
if (process.env.ORCA_STRUCTURED_PROJECTOR_APPROVED !== 'root-source-reviewed') {
  throw new Error('Root source review is required before the first value callback')
}
test('PG 입력과 provider 출력은 별도 identity로 fold하며 revision·batch·불변 snapshot·실패 원자성을 보존합니다', () => {
  const rawScope = { principal: fingerprintAttachmentPrincipal('a'.repeat(64)), publicSessionId: 'public_projection_fixture',
    sessionId: logicalId('session', randomUUID()), workspaceId: logicalId('workspace', randomUUID()) }
  // Test-only data supplies the existing opaque scope type; no production issuer is installed.
  const scope = { ...rawScope } as VerifiedJournalReadScope
  const epoch = '0', firstTime = '2026-10-14T16:00:00.000Z', laterTime = '2026-10-14T16:00:01.000Z'
  const message = () => ({ kind: 'message' as const, role: 'user' as const, blocks: [{ type: 'text' as const, text: 'same original text' }] })
  function input(clientMessageId: string, sequence: number, principal = scope.principal) {
    const body = message(), inputId = randomUUID(), messageId = randomUUID()
    return { inputId, messageId, sessionId: scope.sessionId, inputSequence: String(sequence), principal,
      operationKey: clientMessageId, originalPayloadHash: 'b'.repeat(64), attachments: [],
      original: { version: 1, sessionId: scope.sessionId, scope: ['session', scope.sessionId], method: 'agentSession.send',
        operationKey: clientMessageId, inputKind: 'GENERAL', sessionFence: '1', payload: { body }, attachments: [] },
      submission: { principal, clientMessageId, wirePayloadFingerprint: 'c'.repeat(64), wireFence: '1',
        journalEpoch: epoch, journalSequence: String(sequence), submittedAt: firstTime } }
  }
  function event(sequence: number, body: FrozenJson): CommittedJournalEvent {
    return { eventId: randomUUID(), sourceKey: `synthetic-source:${randomUUID()}`, sequence, body, committedAt: firstTime }
  }
  function inputEvent(component: OriginalInputComponent, sequence: number) {
    return event(sequence, { kind: 'INPUT_SUBMISSION', inputId: component.inputId, messageId: component.messageId })
  }
  function provider(sequence: number, mutation: FrozenJson, observedAt = firstTime) {
    return event(sequence, { version: 1, kind: 'STRUCTURED_PROVIDER_OUTPUT', publicSessionId: scope.publicSessionId,
      provider: 'claude', observedAt, source: { kind: 'PRODUCER' }, mutation })
  }
  const item = (itemId: string, revision: number, body: FrozenJson = message()) => ({ kind: 'item', itemId, revision, body })
  const tombstone = (itemId: string, revision: number) => ({ kind: 'tombstone', itemId, revision })
  function page(events: CommittedJournalEvent[], head = events.at(-1)?.sequence ?? 0, inputs: OriginalInputComponent[] = []) {
    const sequence = events.at(-1)?.sequence ?? 0
    return { kind: 'PAGE' as const, scope: { ...scope }, head: { epoch, sequence: head },
      cursor: { epoch, sequence }, hasMore: sequence < head, events, inputs }
  }
  const projection = createStructuredJournalProjection(rawScope as VerifiedJournalReadScope, epoch)
  const empty = projection.snapshot()
  assert.equal(empty.sessionId, scope.publicSessionId); assert.equal(empty.cursor.sequence, 0)
  rawScope.publicSessionId = 'caller_changed_scope'
  const one = input('first-input', 2), two = input('second-input', 3)
  const providerBody = message(), originalUnknown = { kind: 'STRUCTURED_SESSION_CREATED', version: 1, detail: ['original'] }
  const firstEvents = [event(1, originalUnknown), inputEvent(one, 2), inputEvent(two, 3), provider(4, item('provider-user', 1, providerBody))]
  const first = projection.applyPage(page(firstEvents, 6, [one, two]))
  const centralIds = [agentJournalSubmissionKey('first-input'), agentJournalSubmissionKey('second-input')]
  assert.deepEqual(first.items.map(x => x.itemId), [...centralIds, 'provider-user'])
  assert.equal(first.submissions.length, 2)
  assert.ok(first.submissions.every(x => x.dispatchState === 'pending' && x.providerItemId === null))
  assert.ok(first.items.every(x => JSON.stringify(x.body) === JSON.stringify(message())))
  assert.deepEqual(first.unprojectedEvents.map(x => x.sequence), [1])
  assert.equal(empty.items.length, 0)
  providerBody.blocks[0].text = 'changed by caller'; one.original.payload.body.blocks[0].text = 'changed input'
  originalUnknown.detail.push('changed'); firstEvents.reverse()
  assert.ok(first.items.every(x => JSON.stringify(x.body).includes('same original text')))
  assert.equal(JSON.stringify(first.unprojectedEvents).includes('changed'), false)
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.items)); assert.ok(Object.isFrozen(first.items[0].body))
  assert.equal(Reflect.set(first.cursor, 'sequence', 999), false)
  const revised = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'provider revision' }] }
  const batch = { kind: 'lifecycle-batch', settlementId: 'settlement-original-order',
    mutations: [item('batch-z-first', 1), item('batch-a-second', 1)] }
  const second = projection.applyPage(page([provider(5, item('provider-user', 3, revised), laterTime),
    provider(6, item('provider-user', 2)), provider(7, item('provider-user', 3)), provider(8, batch, laterTime)], 9))
  const revisedItem = second.items.find(x => x.itemId === 'provider-user')
  assert.equal(revisedItem?.revision, 3); assert.equal(revisedItem?.sequence, 4)
  assert.equal(revisedItem?.observedAt, Date.parse(firstTime)); assert.ok(JSON.stringify(revisedItem?.body).includes('provider revision'))
  assert.deepEqual(second.items.filter(x => x.sequence === 8).map(x => x.itemId), ['batch-z-first', 'batch-a-second'])
  assert.ok(second.items.filter(x => x.sequence === 8).every(x => x.observedAt === Date.parse(laterTime)))
  assert.equal(first.items.find(x => x.itemId === 'provider-user')?.revision, 1)
  const third = projection.applyPage(page([provider(9, tombstone('provider-user', 4)), provider(10, item('provider-user', 3))], 11))
  assert.equal(third.items.some(x => x.itemId === 'provider-user'), false)
  const otherEvent = event(13, { kind: 'INPUT_OBSERVATION', version: 1, payload: { marker: ['preserve'] } })
  const fourth = projection.applyPage(page([provider(11, item('provider-user', 5), laterTime), provider(12, batch), otherEvent], 20))
  assert.equal(fourth.items.find(x => x.itemId === 'provider-user')?.sequence, 11)
  assert.ok(fourth.items.filter(x => x.itemId.startsWith('batch-')).every(x => x.sequence === 8))
  assert.deepEqual(fourth.unprojectedEvents.map(x => x.sequence), [1, 13])
  assert.ok(fourth.submissions.every(x => x.dispatchState === 'pending' && x.providerItemId === null))
  const stable = projection.snapshot(), stableJson = JSON.stringify(stable)
  const rejectUnchanged = (candidate: ReturnType<typeof page>, pattern: RegExp) => {
    assert.throws(() => projection.applyPage(candidate), pattern)
    assert.equal(projection.snapshot(), stable); assert.equal(JSON.stringify(projection.snapshot()), stableJson)
  }
  rejectUnchanged(page([provider(14, { kind: 'lifecycle-batch', settlementId: 'atomic-collision',
    mutations: [item('must-not-leak', 1), item(centralIds[0], 99)] })], 20), /INPUT_PROVIDER_ID_COLLISION/)
  rejectUnchanged(page([provider(14, tombstone(centralIds[1], 99))], 20), /INPUT_PROVIDER_ID_COLLISION/)
  rejectUnchanged(page([provider(14, { ...batch, mutations: [item('different-settlement-body', 1)] })], 20), /SETTLEMENT_BODY_CONFLICT/)
  rejectUnchanged(page([provider(15, item('gap', 1))], 20), /GAP/)
  const badEpoch = page([provider(14, item('epoch', 1))], 20); badEpoch.head.epoch = '1'
  rejectUnchanged(badEpoch, /EPOCH/)
  const badCursorEpoch = page([provider(14, item('cursor-epoch', 1))], 20); badCursorEpoch.cursor.epoch = '1'
  rejectUnchanged(badCursorEpoch, /EPOCH/)
  for (const key of ['publicSessionId', 'sessionId', 'workspaceId', 'principal'] as const) {
    const other = page([provider(14, item('scope', 1))], 20)
    // Mutate a plain fixture copy; this is not a verified scope issuer.
    Object.assign(other.scope, { [key]: `foreign-${key}` })
    rejectUnchanged(other, /SCOPE/)
  }
  const badOutput = provider(14, item('foreign-output', 1));
  const foreignBody = { version: 1, kind: 'STRUCTURED_PROVIDER_OUTPUT', publicSessionId: 'foreign_public_session',
    provider: 'claude', observedAt: firstTime, source: { kind: 'PRODUCER' }, mutation: item('foreign-output', 1) }
  rejectUnchanged(page([{ ...badOutput, body: foreignBody }], 20), /OUTPUT_SCOPE/)
  rejectUnchanged(page([provider(14, item('head-backward', 1))], 19), /CURSOR/)
  const badCursor = page([provider(14, item('cursor-disagrees', 1))], 20); badCursor.cursor.sequence = 15
  rejectUnchanged(badCursor, /CURSOR/)
  const badMore = page([provider(14, item('hasMore', 1))], 20); badMore.hasMore = false
  rejectUnchanged(badMore, /CURSOR/)
  const repeatedIdentity = { ...otherEvent, sequence: 14, body: { kind: 'CHANGED_ORIGINAL_EVENT_BODY' } }
  rejectUnchanged(page([repeatedIdentity], 20), /EVENT_BODY_CONFLICT/)
  assert.throws(() => Reflect.apply(projection.applyPage, null, [{ kind: 'RESET', reason: 'epoch_changed' }]), /PAGE_REQUIRED/)
  assert.equal(projection.snapshot(), stable)
  const reverse = createStructuredJournalProjection(scope, epoch), reverseInput = input('reverse-order', 2)
  reverse.applyPage(page([provider(1, item(agentJournalSubmissionKey('reverse-order'), 1))]))
  const reverseBefore = reverse.snapshot()
  assert.throws(() => reverse.applyPage(page([inputEvent(reverseInput, 2)], 2, [reverseInput])), /INPUT_PROVIDER_ID_COLLISION/)
  assert.equal(reverse.snapshot(), reverseBefore); assert.equal(reverse.snapshot().submissions.length, 0)
  const foreignPrincipal = fingerprintAttachmentPrincipal('d'.repeat(64)), foreignInput = input('foreign-input', 1, foreignPrincipal)
  const foreign = createStructuredJournalProjection(scope, epoch)
  const foreignSnapshot = foreign.applyPage(page([inputEvent(foreignInput, 1)], 1, [foreignInput]))
  assert.equal(foreignSnapshot.items[0].itemId, `input:${foreignInput.inputId}`); assert.equal(foreignSnapshot.submissions.length, 0)
  const priorTombstone = createStructuredJournalProjection(scope, epoch)
  priorTombstone.applyPage(page([provider(1, tombstone(`input:${foreignInput.inputId}`, 2))]))
  assert.throws(() => priorTombstone.applyPage(page([inputEvent(foreignInput, 2)], 2,
    [{ ...foreignInput, submission: { ...foreignInput.submission, journalSequence: '2' } }])), /INPUT_PROVIDER_ID_COLLISION/)
})
