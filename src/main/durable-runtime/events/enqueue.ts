import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { Sequence } from '../../../shared/durable-runtime/identity.ts'

import { withDurableTransaction } from '../db/connection.ts'

import { lockAggregates } from '../db/locks.ts'

import type { EnqueueEvent, EventProducer } from './types.ts'

import { d, type QueueRow } from './model.ts'
import { reject, json, targetIds, producer, targets, sameTargets } from './internal.ts'

export async function enqueueRuntimeEvent(
  pool: Pool,
  input: EventProducer,
  event: EnqueueEvent
): Promise<{
  status: 'COMMITTED' | 'REPLAYED'
  durablyCommittedThrough: Sequence<'producer'>
}> {
  logicalId('event', event.eventId)
  if (counter('sequence:producer', event.sequence) === '0') {
    reject('EVENT_SEQUENCE')
  }
  const originalPayload = json(event.payload)
  const ids = targetIds(event.targetSessionIds)
  const w = input.workload
  const stream = { producerId: w.producerId, incarnation: w.incarnation }
  return withDurableTransaction(pool, async (tx) => {
    // FK insertion also locks Session keys. Acquire them before the producer
    // lock, so enqueue cannot invert a consumer's Session -> producer order.
    await lockAggregates(tx, { sessionIds: ids, runtimeUnitIds: [input.runtimeUnitId] })
    const p = await producer(tx, stream, true)
    if (
      !w.principalRef ||
      !w.authenticationEvidenceRef ||
      p.agent_id !== input.agentId ||
      p.runtime_unit_id !== input.runtimeUnitId ||
      p.attempt_id !== w.attemptId ||
      p.pod_uid !== w.podUid ||
      p.execution_epoch !== w.executionEpoch
    ) {
      reject('EVENT_BINDING')
    }
    const prior = await tx.query<QueueRow & { matches: boolean }>(
      `SELECT q.*,payload=$4::jsonb AS matches FROM ${d}runtime_event_queue q
       WHERE event_id=$1 OR (producer_id=$2 AND incarnation=$3 AND producer_seq=$5)`,
      [event.eventId, w.producerId, w.incarnation, originalPayload, event.sequence]
    )
    const replayed = prior.rowCount !== 0
    if (replayed) {
      const row = prior.rows[0]
      if (
        prior.rowCount !== 1 ||
        row.event_id !== event.eventId ||
        row.producer_id !== w.producerId ||
        row.incarnation !== w.incarnation ||
        row.producer_seq !== event.sequence ||
        row.agent_id !== p.agent_id ||
        !row.matches ||
        !sameTargets(await targets(tx, row.event_id), ids)
      ) {
        reject('EVENT_IDENTITY_CONFLICT')
      }
    } else {
      // A stored original replay survives current membership changes. Only a
      // new event must satisfy the current target-membership admission check.
      const validTargets = await tx.query(
        `SELECT s.id FROM ${d}sessions s JOIN ${d}runtime_members m ON m.session_id=s.id
         WHERE s.id=ANY($1::uuid[]) AND s.agent_id=$2 AND m.runtime_unit_id=$3`,
        [ids, p.agent_id, p.runtime_unit_id]
      )
      if (validTargets.rowCount !== ids.length) {
        reject('EVENT_TARGET_BINDING')
      }
      await tx.query(
        `INSERT INTO ${d}runtime_event_queue(event_id,producer_id,incarnation,producer_seq,agent_id,payload,state)
         VALUES($1,$2,$3,$4,$5,$6,'PENDING')`,
        [event.eventId, w.producerId, w.incarnation, event.sequence, p.agent_id, originalPayload]
      )
      for (const session of ids) {
        await tx.query(
          `INSERT INTO ${d}runtime_event_targets(event_id,session_id,agent_id) VALUES($1,$2,$3)`,
          [event.eventId, session, p.agent_id]
        )
      }
    }
    // Find the first gap without generating rows up to an arbitrary sequence.
    const prefix = await tx.query<{ through: string }>(
      `SELECT coalesce(min($3::bigint+rn-1) FILTER(WHERE producer_seq<>$3::bigint+rn),max(producer_seq),$3::bigint) AS through
       FROM (SELECT producer_seq,row_number() OVER(ORDER BY producer_seq) AS rn FROM ${d}runtime_event_queue
             WHERE producer_id=$1 AND incarnation=$2 AND producer_seq>$3::bigint) suffix`,
      [w.producerId, w.incarnation, p.committed_through]
    )
    const through = counter('sequence:producer', prefix.rows[0].through)
    await tx.query(
      `UPDATE ${d}runtime_event_producers SET committed_through=$3,revision=revision+1 WHERE producer_id=$1 AND incarnation=$2`,
      [w.producerId, w.incarnation, through]
    )
    return { status: replayed ? 'REPLAYED' : 'COMMITTED', durablyCommittedThrough: through }
  })
}
