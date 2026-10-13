import type { AttachmentPrincipal } from '../attachments/types.ts'
import { assertAttachmentPrincipal } from '../attachments/types.ts'
import { logicalId, counter, type SessionId, type WorkspaceId } from '../../../shared/durable-runtime/identity.ts'
import type { JsonValue } from '../db/atomic.ts'
import { canonicalInputJson } from '../input/canonical.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'

declare const verifiedReadScope: unique symbol

/** Issued by the upper authenticated/authorized boundary, which is not wired here.
 * There is deliberately no payload/string-to-verified-authority factory. */
export type VerifiedJournalReadScope = Readonly<{
  [verifiedReadScope]: true
  principal: AttachmentPrincipal
  publicSessionId: string
  sessionId: SessionId
  workspaceId: WorkspaceId
}>
export type JournalReadRequest = Readonly<{ cursor?: Readonly<AgentJournalCursor>; limit?: number }>
export type FrozenJson = null | boolean | number | string | readonly FrozenJson[] | { readonly [key: string]: FrozenJson }
export type CommittedJournalEvent = Readonly<{
  eventId: string
  sourceKey: string
  sequence: number
  body: FrozenJson
  committedAt: string
}>
export type OriginalInputComponent = Readonly<{
  inputId: string
  messageId: string
  sessionId: string
  inputSequence: string
  principal: string
  operationKey: string
  originalPayloadHash: string
  original: FrozenJson
  attachments: readonly Readonly<{ position: string; aliasPath: string; contentHash: string }>[]
  submission: Readonly<{
    principal: string
    clientMessageId: string
    wirePayloadFingerprint: string
    wireFence: string
    journalEpoch: string
    journalSequence: string
    submittedAt: string
  }> | null
}>
export type CommittedJournalPage = Readonly<{
  kind: 'PAGE'
  scope: VerifiedJournalReadScope
  head: Readonly<AgentJournalCursor>
  cursor: Readonly<AgentJournalCursor>
  hasMore: boolean
  events: readonly CommittedJournalEvent[]
  inputs: readonly OriginalInputComponent[]
}>
export type JournalResetReason = 'epoch_changed' | 'cursor_ahead' | 'cursor_compacted' | 'journal_gap'
export type CommittedJournalRead = CommittedJournalPage | Readonly<{
  kind: 'RESET'
  reason: JournalResetReason
  head: Readonly<AgentJournalCursor>
  requestedCursor: Readonly<AgentJournalCursor>
}>
export class JournalReadError extends DurableDatabaseError {
  constructor(code: string) {
    super(code)
    this.name = 'JournalReadError'
  }
}

/** Clone JSON without trimming strings, reordering arrays, or dropping unknown fields. */
export function freezeJournalJson(value: unknown): FrozenJson {
  let copy: JsonValue
  try {
    copy = JSON.parse(canonicalInputJson(value as JsonValue)) as JsonValue
  } catch {
    throw new JournalReadError('JOURNAL_JSON_UNREADABLE')
  }
  function freeze(item: JsonValue): FrozenJson {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) { freeze(child) }
      Object.freeze(item)
    }
    return item as FrozenJson
  }
  return freeze(copy)
}
export function jsonObject(value: FrozenJson): Readonly<Record<string, FrozenJson>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JournalReadError('JOURNAL_FORMAT_UNREADABLE')
  }
  return value as Readonly<Record<string, FrozenJson>>
}
export function journalSafeCounter(value: string, positive = false): number {
  let decimal: string
  try { decimal = counter('sequence:journal', value) } catch { throw new JournalReadError('JOURNAL_COUNTER_UNREADABLE') }
  const number = Number(decimal)
  if (!Number.isSafeInteger(number) || (positive && number === 0)) {
    throw new JournalReadError('JOURNAL_COUNTER_UNREADABLE')
  }
  return number
}
export function snapshotJournalScope(scope: VerifiedJournalReadScope): VerifiedJournalReadScope {
  const { principal, publicSessionId, sessionId, workspaceId } = scope
  assertAttachmentPrincipal(principal)
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(publicSessionId)) {
    throw new JournalReadError('JOURNAL_SCOPE_INVALID')
  }
  logicalId('session', sessionId)
  logicalId('workspace', workspaceId)
  // Syntax validation does not authenticate. Only the upper issuer may supply the brand.
  return Object.freeze({ principal, publicSessionId, sessionId, workspaceId }) as VerifiedJournalReadScope
}
