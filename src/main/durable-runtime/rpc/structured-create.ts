import type { AgentSessionAttachResult, AgentSessionHistoryPage, AgentSessionMutationResult } from '../../../shared/agent-session-wire.ts'
import { isAgentSessionId } from '../../../shared/agent-session-record.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection.ts'
import type { JsonValue, MutationOutcome, ReceiptIdentity, ReceiptRecord } from '../db/atomic.ts'
import { captureCatalogJson } from '../catalog/immutable.ts'
import { structuredCounterToNumber } from '../structured/counters.ts'
import { CatalogReadError } from './config.ts'

function invalidReceipt(): never { throw new CatalogReadError('STRUCTURED_CREATE_RECEIPT_INVALID') }
function object(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { invalidReceipt() }
  return value
}
function uuid(kind: string, value: JsonValue): string {
  if (typeof value !== 'string') { invalidReceipt() }
  try { return logicalId(kind, value) } catch { return invalidReceipt() }
}

/** Original committed receipt only. This page describes creation, not current history. */
export function projectInitialStructuredCreateReceipt(
  receipt: ReceiptRecord, identity: ReceiptIdentity, publicSessionId: string, replayed: boolean
): AgentSessionMutationResult<AgentSessionAttachResult> {
  if (!isAgentSessionId(publicSessionId) || receipt.payloadHash !== identity.payloadHash ||
      receipt.key.principalId !== identity.key.principalId || receipt.key.sessionScope !== identity.key.sessionScope ||
      receipt.key.method !== 'agentSession.create' || receipt.key.method !== identity.key.method ||
      receipt.key.operationKey !== identity.key.operationKey ||
      receipt.key.sessionScope !== JSON.stringify(['structured-session', publicSessionId])) { invalidReceipt() }
  const response = object(captureCatalogJson(receipt.response))
  const alias = object(response.alias), reservation = object(response.reservation)
  const event = object(response.event), cursor = object(response.cursor), tab = object(reservation.tab)
  if (response.version !== 1 || response.kind !== 'STRUCTURED_SESSION_RESERVED' ||
      response.publicSessionId !== publicSessionId || alias.publicSessionId !== publicSessionId ||
      response.fence !== 1 || cursor.sequence !== 1 || event.sequence !== '1' ||
      typeof event.epoch !== 'string' || cursor.epoch !== event.epoch ||
      alias.sessionId !== reservation.sessionId || (alias.provider !== 'claude' && alias.provider !== 'codex') ||
      tab.type !== 'agent-session' || tab.id !== structuredAgentSessionTabId(publicSessionId) ||
      tab.sessionId !== publicSessionId || tab.agent !== alias.provider || typeof tab.title !== 'string' ||
      typeof tab.isActive !== 'boolean' || !Number.isSafeInteger(reservation.snapshotVersion) ||
      typeof reservation.snapshotVersion !== 'number' || reservation.snapshotVersion < 0) { invalidReceipt() }
  uuid('session', alias.sessionId); uuid('workspace', alias.workspaceId)
  uuid('tab', reservation.tabId); uuid('operation', reservation.operationId)
  uuid('event', event.eventId); uuid('publication-epoch', reservation.publicationEpoch)
  structuredCounterToNumber(event.epoch, 1)
  for (const key of ['providerHandle', 'nativeSessionId', 'ptyId', 'incarnationId', 'terminal', 'terminalHandle', 'leafId', 'paneKey']) {
    if (Object.hasOwn(tab, key)) { invalidReceipt() }
  }
  const originalCursor = { epoch: event.epoch, sequence: 1 }
  const page: AgentSessionHistoryPage = { sessionId: publicSessionId, epoch: event.epoch, fence: 1, direction: 'tail',
    items: [], removedItemIds: [], submissions: [], window: { oldest: null, newest: null, nextCursor: originalCursor },
    liveCursor: originalCursor, hasOlder: false, hasNewer: false }
  return { ok: true, replayed, fence: 1, cursor: originalCursor,
    value: { sessionId: publicSessionId, fence: 1, page, unconfirmedClientMessageIds: [] } }
}

export function projectInitialStructuredCreateOutcome(
  outcome: MutationOutcome, identity: ReceiptIdentity, publicSessionId: string
): AgentSessionMutationResult<AgentSessionAttachResult> {
  if (outcome.status === 'UNCERTAIN') {
    throw new CatalogReadError('STRUCTURED_CREATE_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY')
  }
  return projectInitialStructuredCreateReceipt(outcome.receipt, identity, publicSessionId, outcome.status === 'REPLAYED')
}
