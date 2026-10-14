import { Buffer } from 'node:buffer'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isAdmissibleAgentJournalItemBody } from '../../../shared/agent-session-journal-schemas'
import type { AgentJournalRenderItem, AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage, AgentSessionHistoryRequest, AgentSessionHistoryResult } from '../../../shared/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session-wire'
import { resolveHistoryLimit } from '../../native-chat/agent-session-wire/agent-session-history-page'
import { boundHistoryItemsByBytes, HISTORY_PAGE_CONTENT_BUDGET_BYTES, historyEntryBytes,
  newestWholeSequenceGroups, oversizedHistoryItem, submissionBytesByItemId } from '../../native-chat/agent-session-wire/agent-session-history-page-bounds'
import { captureCatalogJson, captureCatalogParsed } from '../catalog/immutable.ts'
import { JournalReadError } from './model.ts'
// Read dependency only: PR64 d54795b3, not merged in this source base.
import type { StructuredProjectionSnapshot } from './structured-projector.ts'

export type StructuredHistoryRowEffect = Readonly<{
  sequence: number
  itemIds: readonly string[]
  clientMessageIds: readonly string[]
}>
/** Wire pages only. No native row, provider handle, acceptance or authority is manufactured. */
export function buildStructuredHistoryPage(
  input: StructuredProjectionSnapshot, raw: readonly StructuredHistoryRowEffect[],
  originalRequest: AgentSessionHistoryRequest, fence: number
): AgentSessionHistoryResult {
  const snapshot = captureCatalogParsed(input), request = captureCatalogParsed(originalRequest)
  if (!Number.isSafeInteger(fence) || fence < 0 || snapshot.sessionId !== request.sessionId) {
    throw new JournalReadError('STRUCTURED_HISTORY_UNREADABLE')
  }
  const items: AgentJournalRenderItem[] = snapshot.items.map(item => {
    const body = captureCatalogJson(item.body)
    if (!isAdmissibleAgentJournalItemBody(body)) { throw new JournalReadError('STRUCTURED_HISTORY_UNREADABLE') }
    return { itemId: item.itemId, revision: item.revision, sequence: item.sequence, observedAt: item.observedAt, body }
  })
  const submissions: AgentJournalSubmission[] = snapshot.submissions.map(submission => ({ ...submission }))
  const epoch = snapshot.epoch, liveCursor = { ...snapshot.cursor }
  const bytes = submissionBytesByItemId(submissions)
  function page(direction: AgentSessionHistoryPage['direction'], selected: AgentJournalRenderItem[],
    removedItemIds: string[], selectedSubmissions: AgentJournalSubmission[], nextCursor: typeof liveCursor,
    hasOlder: boolean, hasNewer: boolean): AgentSessionHistoryPage {
    const oldest = selected[0], newest = selected.at(-1)
    return { sessionId: snapshot.sessionId, epoch, fence, direction, items: selected,
      removedItemIds, submissions: selectedSubmissions, window: {
        oldest: oldest ? { epoch, sequence: oldest.sequence } : null,
        newest: newest ? { epoch, sequence: newest.sequence } : null, nextCursor },
      liveCursor, hasOlder, hasNewer }
  }
  function overlapping(selected: readonly AgentJournalRenderItem[]) {
    const ids = new Set(selected.map(item => item.itemId))
    return submissions.filter(s => ids.has(agentJournalSubmissionKey(s.clientMessageId)))
  }
  function backward(direction: 'tail' | 'before', before: number | undefined, limit: number) {
    const older = before === undefined ? items : items.filter(item => item.sequence < before)
    const window = newestWholeSequenceGroups(older, limit)
    const bounded = boundHistoryItemsByBytes(window, 'newest', bytes, HISTORY_PAGE_CONTENT_BUDGET_BYTES)
    return page(direction, bounded.items, [], overlapping(bounded.items),
      { epoch, sequence: bounded.items[0]?.sequence ?? before ?? 0 },
      older.length > window.length || bounded.dropped > 0, older.length < items.length)
  }
  function reset(reason: Extract<AgentSessionHistoryResult, { ok: false }>['reset']): AgentSessionHistoryResult {
    return { ok: false, reset: reason, fence, page: backward('tail', undefined, AGENT_SESSION_HISTORY_MAX_LIMIT) }
  }
  const cursor = request.direction === 'tail' ? undefined : request.cursor
  if (cursor && (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0)) {
    throw new JournalReadError('STRUCTURED_HISTORY_UNREADABLE')
  }
  if (cursor && cursor.epoch !== epoch) { return reset('epoch_changed') }
  if (cursor && cursor.sequence > liveCursor.sequence) { return reset('cursor_ahead') }
  const limit = resolveHistoryLimit(request.limit)
  if (request.direction !== 'after') {
    return { ok: true, page: backward(request.direction, cursor?.sequence, limit) }
  }
  if (!cursor) { return reset('cursor_ahead') }
  // One event is one atomic window unit, even when it holds multiple mutations.
  const available = raw.filter(row => row.sequence > cursor.sequence)
  let rows = available.slice(0, limit)
  const live = new Map(items.map(item => [item.itemId, item]))
  function touched(window: readonly StructuredHistoryRowEffect[]) {
    const ids = new Set(window.flatMap(row => [...row.itemIds]))
    const clients = new Set(window.flatMap(row => [...row.clientMessageIds]))
    const selected = [...ids].flatMap(id => { const item = live.get(id); return item ? [item] : [] })
      .sort((a, b) => a.sequence - b.sequence)
    const removed = [...ids].filter(id => !live.has(id))
    const own = submissions.filter(s => clients.has(s.clientMessageId) || ids.has(agentJournalSubmissionKey(s.clientMessageId)))
    return { selected, removed, own }
  }
  function cost(result: ReturnType<typeof touched>): number {
    const selectedIds = new Set(result.selected.map(item => item.itemId))
    return result.selected.reduce((sum, item) => sum + historyEntryBytes(item, bytes), 0) +
      result.removed.reduce((sum, id) => sum + Buffer.byteLength(JSON.stringify(id), 'utf8') + 1, 0) +
      result.own.filter(s => !selectedIds.has(agentJournalSubmissionKey(s.clientMessageId)))
        .reduce((sum, s) => sum + Buffer.byteLength(JSON.stringify(s), 'utf8'), 0)
  }
  let result = touched(rows)
  while (rows.length > 1 && cost(result) > HISTORY_PAGE_CONTENT_BUDGET_BYTES) {
    rows = rows.slice(0, Math.ceil(rows.length / 2)); result = touched(rows)
  }
  if (cost(result) > HISTORY_PAGE_CONTENT_BUDGET_BYTES) {
    result.selected = result.selected.map(item => {
      const size = historyEntryBytes(item, bytes)
      return size > HISTORY_PAGE_CONTENT_BUDGET_BYTES ? oversizedHistoryItem(item, size) : item
    })
  }
  if (cost(result) > HISTORY_PAGE_CONTENT_BUDGET_BYTES) { return reset('cursor_compacted') }
  return { ok: true, page: page('after', result.selected, result.removed, result.own,
    { epoch, sequence: rows.at(-1)?.sequence ?? cursor.sequence }, cursor.sequence > 0, available.length > rows.length) }
}
