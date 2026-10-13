import { randomUUID } from 'node:crypto'

import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'

import type { DurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'

import type {
  ConsumerAuthority,
  ConsumerOptions,
  EventClaim,
  EventRecord,
  ProducerStream
} from './types.ts'

import { d, type QueueRow, type Head } from './model.ts'
import { reject, streamValues, producer, targets, sameTargets, lease } from './internal.ts'

export async function lockHead(
  tx: DurableTransaction,
  stream: ProducerStream,
  authority: ConsumerAuthority,
  options: Pick<ConsumerOptions, 'operationIds'>
): Promise<Head> {
  const before = await producer(tx, stream, false)
  const candidate = await tx.query<{ event_id: string }>(
    `SELECT event_id FROM ${d}runtime_event_queue WHERE producer_id=$1 AND incarnation=$2 AND producer_seq=$3::bigint+1`,
    [...streamValues(stream), before.processed_through]
  )
  const ids = candidate.rows[0] ? await targets(tx, candidate.rows[0].event_id) : []
  await lockAggregates(tx, {
    sessionIds: ids,
    runtimeUnitIds: [logicalId('runtime-unit', before.runtime_unit_id)],
    operationIds: options.operationIds
  })
  await lease(tx, authority)
  const p = await producer(tx, stream, true)
  // Head movement between discovery and locks requires a fresh transaction,
  // never acquiring an undiscovered Session after the Runtime/lease locks.
  if (before.processed_through !== p.processed_through) {
    reject('EVENT_HEAD_CHANGED')
  }
  if (candidate.rows[0]) {
    tx.advanceLock(7, candidate.rows[0].event_id)
  }
  const q = await tx.query<QueueRow>(
    `SELECT q.*,claim_expires_at>clock_timestamp() AS claim_live,
       (next_retry_at IS NULL OR next_retry_at<=clock_timestamp()) AS retry_due
     FROM ${d}runtime_event_queue q WHERE producer_id=$1 AND incarnation=$2 AND producer_seq=$3::bigint+1 FOR UPDATE`,
    [...streamValues(stream), p.processed_through]
  )
  const row = q.rows[0] ?? null
  if (
    (row?.event_id ?? null) !== (candidate.rows[0]?.event_id ?? null) ||
    (row && !sameTargets(ids, await targets(tx, row.event_id)))
  ) {
    reject('EVENT_HEAD_CHANGED')
  }
  if (row) {
    tx.markLockAcquired(7, row.event_id)
  }
  return { producer: p, queue: row, targets: ids }
}

export function record(head: Head): EventRecord {
  const q = head.queue!
  return {
    eventId: logicalId('event', q.event_id),
    producerId: logicalId('producer', q.producer_id),
    incarnation: head.producer.incarnation as ProducerStream['incarnation'],
    sequence: counter('sequence:producer', q.producer_seq),
    agentId: logicalId('agent', q.agent_id),
    runtimeUnitId: logicalId('runtime-unit', head.producer.runtime_unit_id),
    payload: q.payload,
    attemptId: logicalId('attempt', head.producer.attempt_id),
    podUid: head.producer.pod_uid as EventRecord['podUid'],
    executionEpoch: counter('execution-epoch', head.producer.execution_epoch),
    targetSessionIds: head.targets,
    attemptCount: Number(q.attempt_count)
  }
}

export async function history(
  tx: DurableTransaction,
  head: Head,
  authority: ConsumerAuthority,
  stage: string,
  errorCode?: string
): Promise<void> {
  await tx.query(
    `INSERT INTO ${d}runtime_event_attempt_history(id,event_id,attempt_number,stage,controller_term,occurred_at,error_code)
     VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6)`,
    [
      randomUUID(),
      head.queue!.event_id,
      head.queue!.attempt_count,
      stage,
      authority.term,
      errorCode ?? null
    ]
  )
}

export async function advanceHead(tx: DurableTransaction, head: Head): Promise<void> {
  const p = head.producer
  const q = head.queue!
  const moved = await tx.query(
    `UPDATE ${d}runtime_event_producers SET processed_through=$3,revision=revision+1
     WHERE producer_id=$1 AND incarnation=$2 AND processed_through=$4 AND committed_through>=$3`,
    [p.producer_id, p.incarnation, q.producer_seq, p.processed_through]
  )
  if (moved.rowCount !== 1) {
    reject('EVENT_HEAD_CONFLICT')
  }
}

export async function claimedHead(
  tx: DurableTransaction,
  claim: EventClaim,
  options: Pick<ConsumerOptions, 'operationIds'>
): Promise<Head> {
  const head = await lockHead(tx, claim, claim.authority, options)
  const q = head.queue
  if (
    !q ||
    q.event_id !== claim.eventId ||
    q.state !== 'PROCESSING' ||
    q.claim_token !== claim.token ||
    q.claim_owner !== claim.authority.owner ||
    q.claim_controller_term !== claim.authority.term ||
    !q.claim_live ||
    head.producer.runtime_unit_id !== claim.runtimeUnitId ||
    q.agent_id !== claim.agentId ||
    head.producer.attempt_id !== claim.attemptId ||
    head.producer.pod_uid !== claim.podUid ||
    head.producer.execution_epoch !== claim.executionEpoch ||
    Number(q.attempt_count) !== claim.attemptCount ||
    !sameTargets(head.targets, claim.targetSessionIds)
  ) {
    reject('EVENT_STALE_CLAIM')
  }
  return head
}
/** DB-only handler. P1-03's guarded transaction prevents COMMIT/ROLLBACK/SET or
 * multi-statement escape. Side effects are separate durable operations/outbox. */
