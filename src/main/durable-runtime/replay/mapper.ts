import type { DurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import { object, text, uuid, date, reason, target, decimal, reject } from './validation.ts'

export type OutboxRow = {
  id: string
  aggregate_id: string
  aggregate_kind: string
  revision: string
  event: JsonValue
  state: 'PENDING' | 'CLAIMED' | 'PUBLISHED'
  claim_owner: string | null
  claim_token: string | null
  claim_live: boolean
  created_at: Date | null
}
export type MappedSource = { payload: JsonValue; occurredAt: Date }
const notificationKinds = new Set([
  'NOTIFICATION_OPENED',
  'NOTIFICATION_OBSERVED',
  'NOTIFICATION_READ',
  'NOTIFICATION_RESOLVED'
])
// Explicit allowlist: metadata only. Never spread the original outbox JSON.
export async function mapSource(
  tx: DurableTransaction,
  row: OutboxRow
): Promise<MappedSource | null> {
  if (!row.event || typeof row.event !== 'object' || Array.isArray(row.event)) { return null }
  const source = object(row.event)
  if (typeof source.kind !== 'string') {
    return null
  }
  if (notificationKinds.has(source.kind)) {
    if (
      row.aggregate_kind !== 'notification' ||
      text(source.sourceEventId) !== row.id ||
      uuid(text(source.notificationId)) !== row.aggregate_id
    ) {
      reject('REPLAY_SOURCE_METADATA')
    }
    const occurredAt = date(text(source.occurredAt))
    if (source.state !== 'OPEN' && source.state !== 'RESOLVED') {
      reject('REPLAY_SOURCE_METADATA')
    }
    const payload: Record<string, JsonValue> = {
      kind: source.kind,
      sourceEventId: row.id,
      notificationId: row.aggregate_id,
      incidentKey: text(source.incidentKey),
      targetRef: target(source.targetRef!),
      revision: decimal(text(source.revision)),
      state: source.state,
      reasonCode: reason(source.reasonCode),
      retryCount: decimal(text(source.retryCount)),
      occurredAt: occurredAt.toISOString(),
      firstSeenAt: date(text(source.firstSeenAt)).toISOString(),
      lastSeenAt: date(text(source.lastSeenAt)).toISOString(),
      readAt: source.readAt === null ? null : date(text(source.readAt)).toISOString(),
      resolvedAt: source.resolvedAt === null ? null : date(text(source.resolvedAt)).toISOString(),
      actionRef: source.actionRef === null ? null : uuid(text(source.actionRef))
    }
    if (payload.revision !== row.revision) {
      reject('REPLAY_SOURCE_METADATA')
    }
    return { payload, occurredAt }
  }
  const failureNotification = source.kind === 'RUNTIME_EVENT_FAILED'
  const terminalOutcome = source.kind === 'RUNTIME_EVENT_OUTCOME' && (source.outcome === 'FAILED' || source.outcome === 'DONE')
  if (!failureNotification && !terminalOutcome) {
    return null
  }
  const eventId = uuid(text(source.eventId))
  const result = await tx.query<{
    event_id: string
    agent_id: string
    runtime_unit_id: string
    retry_count: string
    terminal_at: Date
    last_error: string | null
    state: string
    sessions: string[]
  }>(
    `SELECT q.event_id,q.agent_id,p.runtime_unit_id,q.retry_count,q.terminal_at,q.last_error,q.state,
      ARRAY(SELECT session_id::text FROM durable_runtime.runtime_event_targets WHERE event_id=q.event_id ORDER BY session_id) AS sessions
      FROM durable_runtime.runtime_event_queue q JOIN durable_runtime.runtime_event_producers p USING(producer_id,incarnation)
      WHERE q.event_id=$1 AND q.state IN ('DONE','FAILED')`,
    [eventId]
  )
  const original = result.rows[0]
  if (!original || (failureNotification ? original.state !== 'FAILED' : original.state !== source.outcome)) {
    reject('REPLAY_SOURCE_METADATA')
  }
  const occurredAt = date(original.terminal_at)
  const payload: Record<string, JsonValue> = {
    kind: source.kind,
    sourceEventId: row.id,
    eventId,
    targetRef: {
      runtimeUnitId: original.runtime_unit_id,
      agentId: original.agent_id,
      eventId,
      sessionIds: original.sessions
    },
    revision: decimal(row.revision),
    state: original.state,
    ...(original.state === 'FAILED' ? { reasonCode: reason(original.last_error ?? undefined) } : {}),
    retryCount: decimal(original.retry_count),
    occurredAt: occurredAt.toISOString()
  }
  if (failureNotification) {
    if (row.aggregate_kind !== 'notification') {
      reject('REPLAY_SOURCE_METADATA')
    }
    const stored = await tx.query(
      'SELECT id FROM durable_runtime.notifications WHERE id=$1 AND incident_key=$2',
      [row.aggregate_id, text(source.incidentKey)]
    )
    if (stored.rowCount !== 1) {
      reject('REPLAY_SOURCE_METADATA')
    }
    payload.notificationId = row.aggregate_id
    payload.incidentKey = text(source.incidentKey)
  } else if (row.aggregate_kind !== 'session' || !original.sessions.includes(row.aggregate_id)) {
    reject('REPLAY_SOURCE_METADATA')
  }
  return { payload, occurredAt }
}
