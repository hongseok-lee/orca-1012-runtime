import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'

import { withDurableTransaction } from '../db/connection.ts'

import {
  EVENT_RETRY_POLICY,
  type ClaimResult,
  type ConsumerAuthority,
  type ConsumerOptions,
  type ProducerStream
} from './types.ts'

import { d } from './model.ts'
import { lockHead, record, history } from './head.ts'
import { reject, milliseconds, liveLease } from './internal.ts'
import { failureFinalizer } from './terminal.ts'

export async function claimRuntimeEvent(
  pool: Pool,
  stream: ProducerStream,
  authority: ConsumerAuthority,
  options: ConsumerOptions
): Promise<ClaimResult> {
  const duration = milliseconds(options.claimDurationMs)
  return withDurableTransaction(pool, async (tx) => {
    const head = await lockHead(tx, stream, authority, options)
    const q = head.queue
    if (!q || BigInt(q.producer_seq) > BigInt(head.producer.committed_through)) {
      return { status: 'WAITING', reason: 'GAP' }
    }
    if (q.state === 'PROCESSING') {
      if (
        q.claim_live &&
        q.claim_owner === authority.owner &&
        q.claim_controller_term === authority.term
      ) {
        return { status: 'WAITING', reason: 'CLAIM' }
      }
      // This STARTED attempt is already charged; record uncertainty, never reset.
      const oldAuthority = {
        ...authority,
        term: counter('controller-term', q.claim_controller_term!)
      }
      await history(tx, head, oldAuthority, 'UNCONFIRMED', 'CLAIM_UNCONFIRMED')
      q.last_error = 'CLAIM_UNCONFIRMED'
    } else if (q.state === 'RETRY' && !q.retry_due) {
      return { status: 'WAITING', reason: 'RETRY' }
    } else if (q.state !== 'PENDING' && q.state !== 'RETRY') {
      reject('EVENT_HEAD_TERMINAL_DRIFT')
    }
    if (Number(q.attempt_count) >= EVENT_RETRY_POLICY.maximumAttempts) {
      await failureFinalizer(tx, head, authority, q.last_error ?? 'ATTEMPTS_EXHAUSTED')
      return { status: 'FAILED', eventId: logicalId('event', q.event_id) }
    }
    const token = randomUUID()
    const claimed = await tx.query<{ attempt_count: string; claim_expires_at: Date }>(
      `UPDATE ${d}runtime_event_queue SET state='PROCESSING',attempt_count=attempt_count+1,retry_count=greatest(attempt_count,0),
       next_retry_at=NULL,claim_owner=$2,claim_controller_term=$3,claim_token=$4,claim_expires_at=clock_timestamp()+$5::bigint*interval '1 millisecond'
       WHERE event_id=$1 RETURNING attempt_count,claim_expires_at`,
      [q.event_id, authority.owner, authority.term, token, duration]
    )
    q.attempt_count = claimed.rows[0].attempt_count
    await history(tx, head, authority, 'STARTED')
    await liveLease(tx, authority)
    return {
      status: 'CLAIMED',
      claim: {
        ...record(head),
        token,
        authority: { ...authority },
        expiresAt: claimed.rows[0].claim_expires_at
      }
    }
  })
}

export async function finalizeRuntimeEvent(
  pool: Pool,
  stream: ProducerStream,
  authority: ConsumerAuthority,
  options: Pick<ConsumerOptions, 'operationIds'> = {}
): Promise<ClaimResult> {
  return withDurableTransaction(pool, async (tx) => {
    const head = await lockHead(tx, stream, authority, options)
    const q = head.queue
    if (!q || BigInt(q.producer_seq) > BigInt(head.producer.committed_through)) {
      return { status: 'WAITING', reason: 'GAP' }
    }
    if (Number(q.attempt_count) < EVENT_RETRY_POLICY.maximumAttempts) {
      return { status: 'WAITING', reason: 'RETRY' }
    }
    if (q.state === 'PROCESSING') {
      if (
        q.claim_live &&
        q.claim_owner === authority.owner &&
        q.claim_controller_term === authority.term
      ) {
        return { status: 'WAITING', reason: 'CLAIM' }
      }
      await history(
        tx,
        head,
        { ...authority, term: counter('controller-term', q.claim_controller_term!) },
        'UNCONFIRMED',
        'CLAIM_UNCONFIRMED'
      )
      q.last_error = 'CLAIM_UNCONFIRMED'
    } else if (q.state !== 'RETRY') {
      reject('EVENT_HEAD_TERMINAL_DRIFT')
    }
    await failureFinalizer(tx, head, authority, q.last_error ?? 'CLAIM_UNCONFIRMED')
    return { status: 'FAILED', eventId: logicalId('event', q.event_id) }
  })
}
