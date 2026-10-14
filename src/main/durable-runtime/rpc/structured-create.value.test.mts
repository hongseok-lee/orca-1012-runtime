import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { ReceiptRecord, ReceiptIdentity, MutationOutcome } from '../db/atomic.ts'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection.ts'
import { projectInitialStructuredCreateReceipt, projectInitialStructuredCreateOutcome } from './structured-create.ts'

if (process.env.ORCA_PUBLIC_STRUCTURED_CREATE_APPROVED !== 'root-source-reviewed') { throw new Error('Root source review required') }

await test('원 초기 receipt만 공개 빈 page로 변환하며 내부 관계 오류와 UNCERTAIN을 거절합니다', () => {
  const publicSessionId = `structured_${randomUUID().replaceAll('-', '_')}`, sessionId = randomUUID(), workspaceId = randomUUID()
  const identity: ReceiptIdentity = { key: { principalId: `pairing-sha256:${'a'.repeat(64)}`,
    sessionScope: JSON.stringify(['structured-session', publicSessionId]), method: 'agentSession.create', operationKey: 'synthetic-create' },
    payloadHash: 'b'.repeat(64) }
  const response = { version: 1, kind: 'STRUCTURED_SESSION_RESERVED', publicSessionId,
    alias: { publicSessionId, sessionId, workspaceId, provider: 'codex' },
    reservation: { sessionId, tabId: randomUUID(), operationId: randomUUID(), publicationEpoch: randomUUID(), snapshotVersion: 1,
      tab: { type: 'agent-session', id: structuredAgentSessionTabId(publicSessionId), title: 'Codex', sessionId: publicSessionId,
        agent: 'codex', isActive: true } },
    event: { eventId: randomUUID(), epoch: '1', sequence: '1' }, fence: 1, cursor: { epoch: '1', sequence: 1 } }
  const receipt: ReceiptRecord = { ...identity, response, recordedAt: new Date(0), intakeAt: null }
  const outcome: MutationOutcome = { status: 'COMMITTED', receipt, commitObservedAt: new Date(0), transactionDurationMs: 0 }
  const result = projectInitialStructuredCreateOutcome(outcome, identity, publicSessionId, workspaceId)
  assert.equal(result.ok, true)
  if (!result.ok) { throw new Error('Unexpected refusal') }
  assert.equal(result.replayed, false); assert.equal(result.value.sessionId, publicSessionId); assert.equal(result.fence, 1)
  assert.deepEqual(result.value.page, { sessionId: publicSessionId, epoch: '1', fence: 1, direction: 'tail', items: [],
    removedItemIds: [], submissions: [], window: { oldest: null, newest: null, nextCursor: result.cursor }, liveCursor: result.cursor,
    hasOlder: false, hasNewer: false })
  assert.deepEqual(result.value.unconfirmedClientMessageIds, [])
  for (const forbidden of ['providerSession', 'providerHandle', 'backgroundTasks', 'hostNow']) {
    assert.equal(Object.hasOwn(result.value, forbidden), false); assert.equal(Object.hasOwn(result.value.page, forbidden), false)
  }
  const replay = projectInitialStructuredCreateReceipt(receipt, identity, publicSessionId, workspaceId, true)
  assert.deepEqual(replay, { ...result, replayed: true })
  for (const mutate of [
    (value: typeof response) => { value.publicSessionId = 'wrong' },
    (value: typeof response) => { value.alias.sessionId = randomUUID() },
    (value: typeof response) => { value.alias.workspaceId = randomUUID() },
    (value: typeof response) => { value.reservation.tab.sessionId = 'wrong' },
    (value: typeof response) => { value.reservation.tab.agent = 'wrong' },
    (value: typeof response) => { value.reservation.snapshotVersion = Number.MAX_SAFE_INTEGER + 1 },
    (value: typeof response) => { value.event.epoch = '9007199254740992'; value.cursor.epoch = value.event.epoch },
    (value: typeof response) => { value.event.sequence = '2' },
    (value: typeof response) => { value.cursor.sequence = 2 },
    (value: typeof response) => { value.fence = 2 }
  ]) {
    const changed: typeof response = JSON.parse(JSON.stringify(response)); mutate(changed)
    assert.throws(() => projectInitialStructuredCreateReceipt({ ...receipt, response: changed }, identity, publicSessionId, workspaceId, false))
  }
  assert.throws(() => projectInitialStructuredCreateReceipt({ ...receipt, payloadHash: 'c'.repeat(64) }, identity, publicSessionId, workspaceId, true))
  assert.throws(() => projectInitialStructuredCreateOutcome({ status: 'UNCERTAIN', identity, transactionDurationMs: 0 },
    identity, publicSessionId, workspaceId), /STRUCTURED_CREATE_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY/)
})
