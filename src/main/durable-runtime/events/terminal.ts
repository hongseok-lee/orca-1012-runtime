import { randomUUID } from 'node:crypto'

import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'

import type { JsonValue } from '../db/atomic.ts'

import type { DurableTransaction } from '../db/connection.ts'

import { appendAudit, appendSessionEvent, enqueueOutbox } from '../journal/store.ts'
import { EVENT_RETRY_POLICY, type ConsumerAuthority } from './types.ts'

import { d, type Head } from './model.ts'
import { record, advanceHead } from './head.ts'
import { json, liveLease } from './internal.ts'

export async function writeTerminalArtifacts(
  tx: DurableTransaction,
  head: Head,
  authority: ConsumerAuthority,
  outcome: 'DONE' | 'FAILED',
  errorCode?: string
): Promise<void> {
  const event = record(head)
  const body: JsonValue = {
    kind: 'RUNTIME_EVENT_OUTCOME',
    eventId: event.eventId,
    outcome,
    attempts: event.attemptCount,
    retryCount: Math.max(event.attemptCount - 1, 0),
    policyRevision: EVENT_RETRY_POLICY.revision,
    ...(errorCode ? { errorCode } : {})
  }
  for (const session of event.targetSessionIds) {
    const journal = await appendSessionEvent(tx, {
      sessionId: session,
      source: {
        kind: 'PRODUCER',
        sourceKind: `runtime-event:${outcome}`,
        producerId: event.producerId,
        incarnation: event.incarnation,
        producerSeq: event.sequence
      },
      body
    })
    await enqueueOutbox(tx, {
      eventId: journal.eventId,
      aggregateId: session,
      aggregateKind: 'session',
      revision: counter('row:session', journal.sequence),
      event: body
    })
  }
  // A fresh audit producer identity separates the consumer's terminal decision
  // from source sequence/incarnation identity; source refs remain in nextState.
  const now = await tx.query<{ at: Date }>('SELECT clock_timestamp() AS at')
  await appendAudit(tx, {
    actorId: authority.owner,
    runtimeUnitId: event.runtimeUnitId,
    attemptId: head.producer.attempt_id,
    podUid: head.producer.pod_uid,
    kind: `RUNTIME_EVENT_${outcome}`,
    reasonCode: errorCode,
    nextState: {
      outcome,
      eventId: event.eventId,
      attempts: event.attemptCount,
      producerId: event.producerId,
      incarnation: event.incarnation,
      sequence: event.sequence
    },
    occurredAt: now.rows[0].at,
    receivedAt: now.rows[0].at,
    producerId: randomUUID(),
    producerSeq: counter('sequence:producer', '1'),
    evidenceRefs: [`runtime-event:${event.eventId}`]
  })
}

export async function failureFinalizer(
  tx: DurableTransaction,
  head: Head,
  authority: ConsumerAuthority,
  errorCode: string
): Promise<void> {
  const event = record(head)
  for (const session of head.targets) {
    const existing = await tx.query(
      `SELECT context_record_id FROM ${d}runtime_event_failure_contexts WHERE event_id=$1 AND session_id=$2`,
      [event.eventId, session]
    )
    if (existing.rowCount) {
      continue
    }
    const revision = await tx.query<{ context_revision: string }>(
      `UPDATE ${d}sessions SET context_revision=context_revision+1,revision=revision+1 WHERE id=$1 RETURNING context_revision`,
      [session]
    )
    const contextId = randomUUID()
    const ref: JsonValue = {
      kind: 'FAILED_RUNTIME_EVENT_HISTORY',
      originalEventRef: `runtime-event:${event.eventId}`,
      errorCode,
      attemptHistoryRef: `runtime-event:${event.eventId}:attempts`,
      attempts: event.attemptCount,
      retryCount: 5,
      executionDirective: 'HISTORY_ONLY_DO_NOT_REEXECUTE',
      controlRecoveryConfirmed: false
    }
    await tx.query(
      `INSERT INTO ${d}session_context_records(id,session_id,revision,kind,target_event_id,body_ref) VALUES($1,$2,$3,'RUNTIME_EVENT_FAILED',$4,$5)`,
      [contextId, session, revision.rows[0].context_revision, event.eventId, json(ref)]
    )
    await tx.query(
      `INSERT INTO ${d}runtime_event_failure_contexts(event_id,session_id,context_record_id) VALUES($1,$2,$3)`,
      [event.eventId, session, contextId]
    )
  }
  const notificationId = randomUUID()
  const incidentKey = `runtime-event-failed:${event.eventId}`
  await tx.query(
    `INSERT INTO ${d}notifications(id,incident_key,target_ref,reason,state,first_seen_at,last_seen_at,retry_count)
     VALUES($1,$2,$3,$4,'OPEN',clock_timestamp(),clock_timestamp(),5) ON CONFLICT(incident_key) DO NOTHING`,
    [
      notificationId,
      incidentKey,
      json({
        eventId: event.eventId,
        agentId: event.agentId,
        sessionIds: [...event.targetSessionIds]
      }),
      errorCode
    ]
  )
  const notification = await tx.query<{ id: string; revision: string }>(
    `SELECT id,revision FROM ${d}notifications WHERE incident_key=$1`,
    [incidentKey]
  )
  await enqueueOutbox(tx, {
    eventId: logicalId('event', notification.rows[0].id),
    aggregateId: notification.rows[0].id,
    aggregateKind: 'notification',
    revision: counter('row:notification', notification.rows[0].revision),
    event: { kind: 'RUNTIME_EVENT_FAILED', eventId: event.eventId, incidentKey }
  })
  await writeTerminalArtifacts(tx, head, authority, 'FAILED', errorCode)
  await liveLease(tx, authority)
  await tx.query(
    `UPDATE ${d}runtime_event_queue SET state='FAILED',last_error=$2,processed_at=NULL,terminal_at=clock_timestamp(),next_retry_at=NULL,
       claim_owner=NULL,claim_controller_term=NULL,claim_token=NULL,claim_expires_at=NULL WHERE event_id=$1`,
    [event.eventId, errorCode]
  )
  await advanceHead(tx, head)
}
