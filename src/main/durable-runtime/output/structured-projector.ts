import type { AgentJournalCursor, AgentJournalRenderItem, AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import { captureCatalogJson, captureCatalogParsed, type Immutable } from '../catalog/immutable.ts'
import { canonicalInputJson } from '../input/canonical.ts'
import { JournalReadError, jsonObject, snapshotJournalScope, type CommittedJournalEvent, type CommittedJournalPage, type VerifiedJournalReadScope } from './model.ts'
import { projectCommittedInputIdentity } from './project.ts'
// Read dependency: PR62 product 98b45ebb / source 7b9762aa, not yet accepted.
import { parseStructuredProviderEvent, type StructuredProviderLeafMutation } from './structured-provider-event.ts'

export type StructuredProjectionSnapshot = Readonly<{
  sessionId: string
  epoch: string
  cursor: Readonly<AgentJournalCursor>
  items: readonly Immutable<AgentJournalRenderItem>[]
  submissions: readonly Immutable<AgentJournalSubmission>[]
  unprojectedEvents: readonly Immutable<CommittedJournalEvent>[]
}>
export type StructuredJournalProjection = Readonly<{
  applyPage(page: CommittedJournalPage): StructuredProjectionSnapshot
  snapshot(): StructuredProjectionSnapshot
}>
type FoldState = {
  sequence: number
  headSequence: number
  items: Map<string, Immutable<AgentJournalRenderItem>>
  submissions: Map<string, Immutable<AgentJournalSubmission>>
  inputFacts: Map<string, string>
  providerIds: Set<string>
  tombstones: Map<string, number>
  settlements: Map<string, string>
  eventFacts: Map<string, string>
  sourceFacts: Map<string, string>
  unprojected: Immutable<CommittedJournalEvent>[]
}
function fail(code: string): never { throw new JournalReadError(`STRUCTURED_PROJECTOR_${code}`) }
function safeSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) { fail('CURSOR') }
}
function eventKind(event: Immutable<CommittedJournalEvent>): string | undefined {
  const body = event.body
  if (body === null || typeof body !== 'object' || Array.isArray(body)) { return undefined }
  const object = jsonObject(body)
  return typeof object.kind === 'string' ? object.kind : undefined
}
function jsonFact(value: unknown): string { return canonicalInputJson(captureCatalogJson(value)) }

/** Pure PG fold. The supplied scope is already verified; this factory issues no authority.
 * This snapshot is neither a complete public history page nor a provider acceptance proof. */
export function createStructuredJournalProjection(
  scope: VerifiedJournalReadScope, epoch: string
): StructuredJournalProjection {
  const fixedScope = snapshotJournalScope(scope)
  const fixedEpoch = counter('journal-epoch', epoch)
  let state: FoldState = { sequence: 0, headSequence: 0, items: new Map(), submissions: new Map(),
    inputFacts: new Map(), providerIds: new Set(), tombstones: new Map(), settlements: new Map(),
    eventFacts: new Map(), sourceFacts: new Map(), unprojected: [] }
  function render(next: FoldState): StructuredProjectionSnapshot {
    return Object.freeze({ sessionId: fixedScope.publicSessionId, epoch: fixedEpoch,
      cursor: Object.freeze({ epoch: fixedEpoch, sequence: next.sequence }),
      // Stable sort retains the original mutation order inside a shared sequence.
      items: Object.freeze([...next.items.values()].sort((a, b) => a.sequence - b.sequence)),
      submissions: Object.freeze([...next.submissions.values()].sort((a, b) => a.submittedAt - b.submittedAt)),
      unprojectedEvents: Object.freeze([...next.unprojected]) })
  }
  let snapshot = render(state)
  function applyPage(input: CommittedJournalPage): StructuredProjectionSnapshot {
    const page = captureCatalogParsed(input)
    if (page.kind !== 'PAGE') { fail('PAGE_REQUIRED') }
    const actual = page.scope
    if (actual.principal !== fixedScope.principal || actual.publicSessionId !== fixedScope.publicSessionId ||
        actual.sessionId !== fixedScope.sessionId || actual.workspaceId !== fixedScope.workspaceId) { fail('SCOPE') }
    if (page.head.epoch !== fixedEpoch || page.cursor.epoch !== fixedEpoch) { fail('EPOCH') }
    safeSequence(page.head.sequence); safeSequence(page.cursor.sequence)
    if (page.head.sequence < state.headSequence || page.cursor.sequence < state.sequence ||
        page.cursor.sequence > page.head.sequence || typeof page.hasMore !== 'boolean' ||
        page.hasMore !== (page.cursor.sequence < page.head.sequence)) { fail('CURSOR') }
    let expected = state.sequence
    for (const event of page.events) {
      safeSequence(event.sequence)
      if (event.sequence !== expected + 1 || event.sequence > page.head.sequence) { fail('GAP') }
      if (typeof event.eventId !== 'string' || !event.eventId || typeof event.sourceKey !== 'string' || !event.sourceKey) {
        fail('EVENT_IDENTITY')
      }
      expected = event.sequence
    }
    if (expected !== page.cursor.sequence || (page.hasMore && page.events.length === 0)) { fail('CURSOR') }
    // Validate/decode original inputs through the existing mapper, without extra quotas.
    const inputs = projectCommittedInputIdentity(page)
    const bySequence = new Map(inputs.items.map(item => [item.sequence, item]))
    const components = new Map(page.inputs.map(component => [component.inputId, component]))
    const next: FoldState = { sequence: page.cursor.sequence, headSequence: page.head.sequence,
      items: new Map(state.items), submissions: new Map(state.submissions), inputFacts: new Map(state.inputFacts),
      providerIds: new Set(state.providerIds), tombstones: new Map(state.tombstones), settlements: new Map(state.settlements),
      eventFacts: new Map(state.eventFacts), sourceFacts: new Map(state.sourceFacts), unprojected: [...state.unprojected] }
    function leaf(mutation: StructuredProviderLeafMutation, sequence: number, observedAt: number): void {
      const { itemId, revision } = mutation
      if (next.inputFacts.has(itemId)) { fail('INPUT_PROVIDER_ID_COLLISION') }
      next.providerIds.add(itemId)
      const existing = next.items.get(itemId), tombstone = next.tombstones.get(itemId)
      if ((existing && revision <= existing.revision) || (tombstone !== undefined && revision <= tombstone)) { return }
      if (mutation.kind === 'tombstone') {
        next.tombstones.set(itemId, revision); next.items.delete(itemId)
        return
      }
      next.items.set(itemId, captureCatalogParsed({ itemId, revision, body: mutation.body,
        sequence: existing?.sequence ?? sequence, observedAt: existing?.observedAt ?? observedAt }))
      next.tombstones.delete(itemId)
    }
    for (const event of page.events) {
      const eventFact = jsonFact(event)
      for (const [index, id] of [[next.eventFacts, event.eventId], [next.sourceFacts, event.sourceKey]] as const) {
        const previous = index.get(id)
        if (previous !== undefined) { fail(previous === eventFact ? 'EVENT_REPEATED' : 'EVENT_BODY_CONFLICT') }
        index.set(id, eventFact)
      }
      const kind = eventKind(event)
      if (kind === 'INPUT_SUBMISSION') {
        const item = bySequence.get(event.sequence)
        if (!item || event.body === null || typeof event.body !== 'object' || Array.isArray(event.body)) { fail('INPUT') }
        const inputId = jsonObject(event.body).inputId
        const component = typeof inputId === 'string' ? components.get(inputId) : undefined
        if (!component) { fail('INPUT') }
        if (next.providerIds.has(item.itemId)) { fail('INPUT_PROVIDER_ID_COLLISION') }
        const fact = jsonFact(component), previous = next.inputFacts.get(item.itemId)
        if (previous !== undefined && previous !== fact) { fail('INPUT_BODY_CONFLICT') }
        if (previous === undefined) {
          next.inputFacts.set(item.itemId, fact); next.items.set(item.itemId, captureCatalogParsed(item))
        }
      } else if (kind === 'STRUCTURED_PROVIDER_OUTPUT') {
        const output = parseStructuredProviderEvent(event.body)
        if (output.publicSessionId !== fixedScope.publicSessionId) { fail('OUTPUT_SCOPE') }
        const observedAt = Date.parse(output.observedAt)
        if (!Number.isSafeInteger(observedAt)) { fail('OUTPUT_TIME') }
        const mutation = output.mutation
        if (mutation.kind === 'lifecycle-batch') {
          const fact = jsonFact(mutation), previous = next.settlements.get(mutation.settlementId)
          if (previous !== undefined) {
            if (previous !== fact) { fail('SETTLEMENT_BODY_CONFLICT') }
            continue
          }
          for (const child of mutation.mutations) { leaf(child, event.sequence, observedAt) }
          next.settlements.set(mutation.settlementId, fact)
        } else { leaf(mutation, event.sequence, observedAt) }
      } else { next.unprojected.push(event) }
    }
    for (const submission of inputs.submissions) {
      const previous = next.submissions.get(submission.clientMessageId)
      if (previous && jsonFact(previous) !== jsonFact(submission)) { fail('SUBMISSION_BODY_CONFLICT') }
      if (!previous) { next.submissions.set(submission.clientMessageId, captureCatalogParsed(submission)) }
    }
    const published = render(next)
    // No committed state, prior snapshot, or caller object was mutated above.
    state = next; snapshot = published
    return snapshot
  }
  return Object.freeze({ applyPage, snapshot: () => snapshot })
}
