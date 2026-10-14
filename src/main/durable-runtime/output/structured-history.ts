import type { PoolClient } from 'pg'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { AgentSessionHistoryRequest, AgentSessionHistoryResult } from '../../../shared/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session-wire'
import { captureCatalogParsed } from '../catalog/immutable.ts'
import { parseStructuredProviderEvent } from './structured-provider-event.ts'
import { jsonObject, JournalReadError, snapshotJournalScope, type CommittedJournalPage, type VerifiedJournalReadScope } from './model.ts'
import { readCommittedSessionJournalInTransaction } from './read.ts'
import { buildStructuredHistoryPage, type StructuredHistoryRowEffect } from './structured-history-page.ts'
// PR64 d54795b3 read dependency. No local copy or activation before merge/review.
import { createStructuredJournalProjection } from './structured-projector.ts'

export type StructuredHistoryIdentity = Readonly<{
  agentId: string
  provider: 'claude' | 'codex'
  epoch: string
  headSequence: number
  fence: number
}>
/** Internal fold of already authorized, original PG pages; no authority issuer. */
export function createStructuredHistoryFold(scope: VerifiedJournalReadScope, original: StructuredHistoryIdentity) {
  const fixed = snapshotJournalScope(scope), identity = captureCatalogParsed(original)
  const projection = createStructuredJournalProjection(fixed, identity.epoch)
  const effects: StructuredHistoryRowEffect[] = []
  function applyPage(page: CommittedJournalPage): void {
    if (page.head.epoch !== identity.epoch || page.head.sequence !== identity.headSequence) {
      throw new JournalReadError('STRUCTURED_HISTORY_UNREADABLE')
    }
    for (const event of page.events) {
      const body = jsonObject(event.body)
      if (body.kind === 'INPUT_SUBMISSION' || body.kind === 'STRUCTURED_PROVIDER_OUTPUT') { continue }
      if (body.kind !== 'STRUCTURED_SESSION_CREATED') { throw new JournalReadError('STRUCTURED_HISTORY_UNPROJECTED_EVENT') }
      if (body.version !== 1 || body.publicSessionId !== fixed.publicSessionId || body.sessionId !== fixed.sessionId ||
        body.workspaceId !== fixed.workspaceId || body.agentId !== identity.agentId || body.provider !== identity.provider ||
        typeof body.runtimeUnitId !== 'string' || typeof body.tabId !== 'string') {
        throw new JournalReadError('STRUCTURED_HISTORY_UNREADABLE')
      }
      logicalId('runtime-unit', body.runtimeUnitId); logicalId('tab', body.tabId)
      jsonObject(body.originalCreate)
    }
    const originals = new Map(page.inputs.map(input => [input.inputId, input]))
    const nextEffects: StructuredHistoryRowEffect[] = []
    for (const event of page.events) {
      const body = jsonObject(event.body), itemIds: string[] = [], clientMessageIds: string[] = []
      if (body.kind === 'INPUT_SUBMISSION') {
        const input = typeof body.inputId === 'string' ? originals.get(body.inputId) : undefined
        if (!input) { throw new JournalReadError('STRUCTURED_HISTORY_UNREADABLE') }
        const own = input.submission !== null && input.submission.principal === fixed.principal
        itemIds.push(own ? agentJournalSubmissionKey(input.submission!.clientMessageId) : `input:${input.inputId}`)
        if (own) { clientMessageIds.push(input.submission!.clientMessageId) }
      } else if (body.kind === 'STRUCTURED_PROVIDER_OUTPUT') {
        const output = parseStructuredProviderEvent(event.body)
        if (output.provider !== identity.provider) { throw new JournalReadError('STRUCTURED_HISTORY_UNREADABLE') }
        const mutation = output.mutation
        itemIds.push(...(mutation.kind === 'lifecycle-batch' ? mutation.mutations.map(child => child.itemId) : [mutation.itemId]))
      }
      nextEffects.push(Object.freeze({ sequence: event.sequence, itemIds: Object.freeze(itemIds), clientMessageIds: Object.freeze(clientMessageIds) }))
    }
    projection.applyPage(page)
    effects.push(...nextEffects)
  }
  return Object.freeze({ applyPage, finish: (request: AgentSessionHistoryRequest): AgentSessionHistoryResult =>
    buildStructuredHistoryPage(projection.snapshot(), effects, request, identity.fence) })
}
/** Same caller-owned RR client for identity, every raw page, and original input lookup. */
export async function readStructuredHistoryInTransaction(client: PoolClient, scope: VerifiedJournalReadScope,
  originalIdentity: StructuredHistoryIdentity, originalRequest: AgentSessionHistoryRequest): Promise<AgentSessionHistoryResult> {
  const identity = captureCatalogParsed(originalIdentity), request = captureCatalogParsed(originalRequest)
  const fixed = snapshotJournalScope(scope), fold = createStructuredHistoryFold(fixed, identity)
  let cursor = { epoch: identity.epoch, sequence: 0 }
  for (;;) {
    const page = await readCommittedSessionJournalInTransaction(client, fixed, { cursor, limit: AGENT_SESSION_HISTORY_MAX_LIMIT })
    if (page.kind === 'RESET') { throw new JournalReadError('STRUCTURED_HISTORY_UNREADABLE') }
    fold.applyPage(page)
    cursor = { ...page.cursor }
    if (!page.hasMore) { break }
  }
  return fold.finish(request)
}
