import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { projectTerminalNativeHistory } from './terminal-native-projector.ts'
import { freezeJournalJson, type OriginalInputComponent, type CommittedJournalEvent } from './model.ts'
import { canonicalInputJson, prepareInputRequest } from '../input/canonical.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key.ts'
import type { JsonValue } from '../db/atomic.ts'

// Pure committed-history control. No DB, provider, native turn or authenticated RPC.
test('original UNKNOWN adds one platform status without changing the user body or cursor', () => {
  const sessionId = logicalId('session', randomUUID()), inputId = randomUUID(), messageId = randomUUID()
  const deliveryAttemptId = randomUUID(), eventId = randomUUID(), principal = fingerprintAttachmentPrincipal('a'.repeat(64))
  const operationKey = JSON.stringify(['UNARY', 'fixture-connection', 'fixture-request'])
  const text = '  original request α\n', terminalHandle = 'fixture:terminal', ingress = 'fixture-ingress'
  const request = prepareInputRequest({authority: {principal, sessionId, scope: {kind: 'TERMINAL', terminalHandle}},
    method: 'terminal.send', operationKey, inputKind: 'GENERAL', sessionFence: counter('session-fence', '1'),
    payload: {version: 1, text, originalIngressId: ingress, chunks: [{ingressId: ingress, text, attachments: []}],
      wire: {version: 1, source: 'UNARY', terminal: terminalHandle,
        action: {text, enter: true, interrupt: false, inputKind: null, expectedIncarnationId: null,
          agentPrompt: false, resolvedLaunchDraft: null}, inputBytes: null, attachments: []}}, attachments: []})
  const input: OriginalInputComponent = {inputId, messageId, sessionId, inputSequence: '1', principal, operationKey,
    originalPayloadHash: request.identity.payloadHash, original: freezeJournalJson(request.original), attachments: [], submission: null}
  const submission: CommittedJournalEvent = {eventId: randomUUID(), sequence: 1,
    sourceKey: JSON.stringify(['v1', sessionId, 'producer', 'INPUT_SUBMISSION', sessionId, 'durable-input-v1', '1']),
    committedAt: '2026-10-17T07:00:00.000Z', body: freezeJournalJson({kind: 'INPUT_SUBMISSION', inputId, messageId})}
  const evidenceRef = 'fixture:original-owner-lost'
  const unknown: CommittedJournalEvent = {eventId, sequence: 2,
    sourceKey: JSON.stringify(['v1', sessionId, 'native', 'INPUT_UNKNOWN', 'platform', deliveryAttemptId, evidenceRef]),
    committedAt: '2026-10-17T07:01:00.000Z', body: freezeJournalJson({kind: 'INPUT_OBSERVATION', state: 'UNKNOWN',
      messageId, deliveryAttemptId, evidenceRef, reasonCode: 'INPUT_OWNER_LOST'})}
  const originalBefore = JSON.stringify(input), before = projectTerminalNativeHistory(sessionId, [submission], [input])
  const after = projectTerminalNativeHistory(sessionId, [submission, unknown], [input])
  assert.equal(after.messages.length, 2)
  assert.deepEqual(after.messages[0], before.messages[0])
  assert.equal(after.messages[0].message.role, 'user')
  assert.deepEqual(after.messages[0].message.blocks, [{type: 'text', text}])
  assert.equal(after.messages[1].message.id, agentJournalItemKey({provider: 'orca',
    clientMessageId: `terminal-input-unknown:${sessionId}:${eventId}`}))
  assert.equal(after.messages[1].message.role, 'system')
  assert.deepEqual(after.messages[1].message.blocks, [{type: 'text', text: 'Delivery unconfirmed.', tone: 'warning'}])
  assert.equal(after.messages[1].offset, Buffer.byteLength(canonicalInputJson(submission.body as JsonValue), 'utf8') + 1)
  assert.equal(after.lifecycle, undefined)
  assert.deepEqual(projectTerminalNativeHistory(sessionId, [submission, unknown], [input]), after)
  assert.equal(JSON.stringify(input), originalBefore)
  assert.throws(() => projectTerminalNativeHistory(sessionId, [submission, unknown], [{...input, sessionId: randomUUID()}]), /TERMINAL_HISTORY_INPUT/)
  assert.throws(() => projectTerminalNativeHistory(sessionId, [submission, {...unknown,
    body: freezeJournalJson({...unknown.body as Record<string, JsonValue>, messageId: randomUUID()})}], [input]), /TERMINAL_HISTORY_INPUT_OBSERVATION/)
  assert.throws(() => projectTerminalNativeHistory(sessionId, [submission, {...unknown,
    sourceKey: JSON.stringify(['v1', sessionId, 'native', 'INPUT_UNKNOWN', 'platform', randomUUID(), evidenceRef])}], [input]), /TERMINAL_HISTORY_INPUT_OBSERVATION/)
})
