import type { Pool, PoolClient } from 'pg'
import { safeDatabaseError } from '../db/connection.ts'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import { AGENT_SESSION_HISTORY_DEFAULT_LIMIT, AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session-wire'
import {
  freezeJournalJson, journalSafeCounter, snapshotJournalScope, JournalReadError,
  type VerifiedJournalReadScope, type JournalReadRequest, type CommittedJournalRead,
  type CommittedJournalEvent, type JournalResetReason
} from './model.ts'
import { readOriginalInputs } from './input-read.ts'

/** Forward committed-event reader; not the public history/tail/subscribe handler. */
export async function readCommittedSessionJournal(
  pool: Pool, scope: VerifiedJournalReadScope, request: JournalReadRequest
): Promise<CommittedJournalRead> {
  const fixedScope = snapshotJournalScope(scope)
  const limit = request.limit ?? AGENT_SESSION_HISTORY_DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_SESSION_HISTORY_MAX_LIMIT) {
    throw new JournalReadError('JOURNAL_LIMIT_INVALID')
  }
  const requested = request.cursor ? Object.freeze({ ...request.cursor }) : null
  if (requested) {
    counter('journal-epoch', requested.epoch)
    if (!Number.isSafeInteger(requested.sequence) || requested.sequence < 0) {
      throw new JournalReadError('JOURNAL_COUNTER_UNREADABLE')
    }
  }
  const connect = pool.connect.bind(pool)
  let client: PoolClient
  try { client = await connect() } catch (error) { throw safeDatabaseError(error) }
  let destroy = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const identity = await client.query<{ session_id: string; workspace_id: string; journal_epoch: string; head: string }>(
      `SELECT a.session_id,a.workspace_id,s.journal_epoch::text,(s.next_event_seq-1)::text AS head
       FROM durable_runtime.structured_session_aliases a
       JOIN durable_runtime.sessions s ON s.id=a.session_id AND s.workspace_id=a.workspace_id
       WHERE a.public_session_id=$1`, [fixedScope.publicSessionId]
    )
    const row = identity.rows[0]
    if (identity.rowCount !== 1 || row.session_id !== fixedScope.sessionId || row.workspace_id !== fixedScope.workspaceId) {
      throw new JournalReadError('JOURNAL_ALIAS_MISMATCH')
    }
    // created_by and lifecycle are deliberately not used as owner-only authorization.
    const head = Object.freeze({ epoch: counter('journal-epoch', row.journal_epoch), sequence: journalSafeCounter(row.head) })
    const cursor = requested ?? Object.freeze({ epoch: head.epoch, sequence: 0 })
    async function reset(reason: JournalResetReason): Promise<CommittedJournalRead> {
      await client.query('COMMIT')
      return Object.freeze({ kind: 'RESET', reason, head, requestedCursor: cursor })
    }
    if (cursor.epoch !== head.epoch) { return await reset('epoch_changed') }
    if (cursor.sequence > head.sequence) { return await reset('cursor_ahead') }
    const prefix = await client.query<{ first: string | null }>(
      `SELECT min(seq)::text AS first FROM durable_runtime.session_events WHERE session_id=$1 AND journal_epoch=$2`,
      [fixedScope.sessionId, head.epoch]
    )
    const first = prefix.rows[0].first === null ? null : journalSafeCounter(prefix.rows[0].first, true)
    if (first !== null && cursor.sequence < first - 1) { return await reset('cursor_compacted') }
    const rows = await client.query<{ event_id: string; source_key: string; seq: string; body: unknown; committed_at: string }>(
      `SELECT event_id,source_key,seq::text,body,committed_at::text
       FROM durable_runtime.session_events
       WHERE session_id=$1 AND journal_epoch=$2 AND seq>$3 AND seq<=$4 ORDER BY seq LIMIT $5`,
      [fixedScope.sessionId, head.epoch, cursor.sequence, head.sequence, limit]
    )
    const events: CommittedJournalEvent[] = []
    let last = cursor.sequence
    // Check every raw journal row before considering which ones can be projected.
    for (const event of rows.rows) {
      const sequence = journalSafeCounter(event.seq, true)
      if (sequence !== last + 1) { return await reset('journal_gap') }
      events.push(Object.freeze({ eventId: event.event_id, sourceKey: event.source_key,
        sequence, body: freezeJournalJson(event.body), committedAt: event.committed_at }))
      last = sequence
    }
    if (events.length < limit && last !== head.sequence) { return await reset('journal_gap') }
    const inputs = await readOriginalInputs(client, fixedScope, head.epoch, events)
    await client.query('COMMIT')
    return Object.freeze({ kind: 'PAGE', scope: fixedScope, head,
      cursor: Object.freeze({ epoch: head.epoch, sequence: last }), hasMore: last < head.sequence,
      events: Object.freeze(events), inputs })
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { destroy = true }
    throw error instanceof JournalReadError ? error : safeDatabaseError(error)
  } finally { client.release(destroy) }
}
