import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'

import { runDurableMutation } from '../db/atomic.ts'

import { safeDatabaseError, withDurableTransaction } from '../db/connection.ts'

import {
  EVENT_RETRY_POLICY,
  type ConsumerOptions,
  type EventClaim,
  type EventHandler,
  type ProcessResult
} from './types.ts'

import { d } from './model.ts'
import { record, history, advanceHead, claimedHead } from './head.ts'
import { reject, json, milliseconds, liveLease } from './internal.ts'
import { writeTerminalArtifacts, failureFinalizer } from './terminal.ts'

export async function processRuntimeEvent(
  pool: Pool,
  claim: EventClaim,
  handler: EventHandler,
  options: Pick<ConsumerOptions, 'operationIds'> = {}
): Promise<ProcessResult> {
  logicalId('event', claim.eventId)
  logicalId('claim', claim.token)
  const identity = {
    key: {
      principalId: claim.authority.owner,
      sessionScope: `runtime-event:${claim.eventId}`,
      method: 'runtime-event.process',
      operationKey: claim.token
    },
    payloadHash: createHash('sha256')
      .update(
        json({
          eventId: claim.eventId,
          token: claim.token,
          attempt: claim.attemptCount,
          term: claim.authority.term,
          scope: claim.authority.scope
        })
      )
      .digest('hex'),
    locks: {
      sessionIds: claim.targetSessionIds,
      runtimeUnitIds: [claim.runtimeUnitId],
      operationIds: options.operationIds
    }
  }
  try {
    const commit = await runDurableMutation(pool, identity, async (tx) => {
      const head = await claimedHead(tx, claim, options)
      await handler(tx, record(head))
      await liveLease(tx, claim.authority)
      const stillLive = await tx.query(
        `SELECT event_id FROM ${d}runtime_event_queue WHERE event_id=$1 AND claim_token=$2 AND claim_expires_at>clock_timestamp()`,
        [claim.eventId, claim.token]
      )
      if (stillLive.rowCount !== 1) {
        reject('EVENT_STALE_CLAIM')
      }
      await writeTerminalArtifacts(tx, head, claim.authority, 'DONE')
      await history(tx, head, claim.authority, 'SUCCEEDED')
      await tx.query(
        `UPDATE ${d}runtime_event_queue SET state='DONE',processed_at=clock_timestamp(),terminal_at=clock_timestamp(),next_retry_at=NULL,
         claim_owner=NULL,claim_controller_term=NULL,claim_token=NULL,claim_expires_at=NULL WHERE event_id=$1`,
        [claim.eventId]
      )
      await advanceHead(tx, head)
      return { eventId: claim.eventId, state: 'DONE' }
    })
    return { status: commit.status === 'UNCERTAIN' ? 'UNCERTAIN' : 'DONE', commit }
  } catch (error) {
    const safe = safeDatabaseError(error)
    if (['EVENT_STALE_AUTHORITY', 'EVENT_STALE_CLAIM', 'EVENT_HEAD_CHANGED'].includes(safe.code)) {
      return { status: 'STALE' }
    }
    return recordRuntimeEventFailure(pool, claim, safe.code, options)
  }
}

/** A failed processing transaction has already rolled back. This independent
 * transaction records only sanitized error codes and the original attempt. */

export async function recordRuntimeEventFailure(
  pool: Pool,
  claim: EventClaim,
  errorCode: string,
  options: Pick<ConsumerOptions, 'operationIds'> = {}
): Promise<ProcessResult> {
  // Arbitrary messages, payload excerpts and credentials are never persisted.
  const code = /^[A-Z0-9][A-Z0-9_]{0,63}$/.test(errorCode) ? errorCode : 'HANDLER_FAILURE'
  try {
    return await withDurableTransaction(pool, async (tx) => {
      const head = await claimedHead(tx, claim, options)
      await history(tx, head, claim.authority, 'FAILED', code)
      if (claim.attemptCount >= EVENT_RETRY_POLICY.maximumAttempts) {
        await failureFinalizer(tx, head, claim.authority, code)
        return { status: 'FAILED', eventId: claim.eventId }
      }
      const delay = milliseconds(EVENT_RETRY_POLICY.retryDelaysMs[claim.attemptCount - 1])
      await tx.query(
        `UPDATE ${d}runtime_event_queue SET state='RETRY',last_error=$2,next_retry_at=clock_timestamp()+$3::bigint*interval '1 millisecond',
         claim_owner=NULL,claim_controller_term=NULL,claim_token=NULL,claim_expires_at=NULL WHERE event_id=$1`,
        [claim.eventId, code, delay]
      )
      await liveLease(tx, claim.authority)
      return { status: 'RETRY', eventId: claim.eventId }
    })
  } catch (error) {
    const safe = safeDatabaseError(error)
    if (['EVENT_STALE_AUTHORITY', 'EVENT_STALE_CLAIM', 'EVENT_HEAD_CHANGED'].includes(safe.code)) {
      return { status: 'STALE' }
    }
    throw safe
  }
}

/** Manual recovery uses the same head/authority/locks and calls only the generic
 * finalizer. A sixth crashed attempt is not turned into a seventh handler run. */
