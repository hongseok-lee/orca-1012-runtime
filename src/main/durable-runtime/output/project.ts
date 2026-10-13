import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { SendParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import type { AgentJournalRenderItem, AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { freezeJournalJson, jsonObject, journalSafeCounter, JournalReadError, type CommittedJournalPage } from './model.ts'

/** Receipt-only utility. Not a full wire snapshot and never overrides dispatch proof.
 * Non-input events are returned explicitly, not aliased or silently skipped. */
export function projectCommittedInputIdentity(page: CommittedJournalPage): Readonly<{
  items: readonly Readonly<AgentJournalRenderItem>[]
  submissions: readonly Readonly<AgentJournalSubmission>[]
  unprojectedEvents: CommittedJournalPage['events']
}> {
  const items: Readonly<AgentJournalRenderItem>[] = []
  const submissions: Readonly<AgentJournalSubmission>[] = []
  const byInput = new Map(page.inputs.map((input) => [input.inputId, input]))
  const unprojectedEvents = [] as CommittedJournalPage['events'][number][]
  for (const event of page.events) {
    if (event.body === null || typeof event.body !== 'object' || Array.isArray(event.body) ||
      jsonObject(event.body).kind !== 'INPUT_SUBMISSION') {
      unprojectedEvents.push(event)
      continue
    }
    const eventBody = jsonObject(event.body)
    const input = typeof eventBody.inputId === 'string' ? byInput.get(eventBody.inputId) : undefined
    if (!input || input.sessionId !== page.scope.sessionId) { throw new JournalReadError('JOURNAL_INPUT_MISMATCH') }
    if (input.submission && (input.submission.principal !== input.principal ||
      input.submission.clientMessageId !== input.operationKey ||
      input.submission.journalEpoch !== page.head.epoch ||
      input.submission.journalSequence !== String(event.sequence))) {
      throw new JournalReadError('JOURNAL_SUBMISSION_MISMATCH')
    }
    const envelope = jsonObject(input.original)
    if (envelope.version !== 1) { throw new JournalReadError('JOURNAL_INPUT_BODY_UNREADABLE') }
    const payload = jsonObject(envelope.payload)
    const parsed = SendParams.shape.body.safeParse(payload.body)
    if (!parsed.success) { throw new JournalReadError('JOURNAL_INPUT_BODY_UNREADABLE') }
    const body = freezeJournalJson(payload.body) as unknown as AgentJournalRenderItem['body']
    const own = input.submission !== null && input.submission.principal === page.scope.principal
    const observedAt = Date.parse(event.committedAt)
    if (!Number.isSafeInteger(observedAt)) { throw new JournalReadError('JOURNAL_TIME_UNREADABLE') }
    items.push(Object.freeze({ itemId: own ? agentJournalSubmissionKey(input.submission!.clientMessageId) : `input:${input.inputId}`,
      revision: 1, body, sequence: event.sequence, observedAt }))
    if (own) {
      const submission = input.submission!
      const submittedAt = Date.parse(submission.submittedAt)
      if (!Number.isSafeInteger(submittedAt)) { throw new JournalReadError('JOURNAL_TIME_UNREADABLE') }
      submissions.push(Object.freeze({ clientMessageId: submission.clientMessageId,
        fence: journalSafeCounter(submission.wireFence, true), payloadFingerprint: submission.wirePayloadFingerprint,
        dispatchState: 'pending', providerItemId: null, reason: null, submittedAt, resolvedAt: null }))
    }
  }
  return Object.freeze({ items: Object.freeze(items), submissions: Object.freeze(submissions),
    unprojectedEvents: Object.freeze(unprojectedEvents) })
}
