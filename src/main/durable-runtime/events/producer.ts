import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'

import { withDurableTransaction } from '../db/connection.ts'

import { lockAggregates } from '../db/locks.ts'

import type { EventProducer } from './types.ts'

import { d, type ProducerRow } from './model.ts'
import { reject, streamValues, producer } from './internal.ts'

export async function registerEventProducer(pool: Pool, input: EventProducer): Promise<void> {
  const w = input.workload
  const stream = { producerId: w.producerId, incarnation: w.incarnation }
  streamValues(stream)
  logicalId('agent', input.agentId)
  logicalId('runtime-unit', input.runtimeUnitId)
  logicalId('attempt', w.attemptId)
  counter('execution-epoch', w.executionEpoch)
  if (!w.podUid || !w.principalRef || !w.authenticationEvidenceRef) {
    reject('EVENT_BINDING')
  }
  await withDurableTransaction(pool, async (tx) => {
    await lockAggregates(tx, { runtimeUnitIds: [input.runtimeUnitId] })
    const existing = await tx.query<ProducerRow>(
      `SELECT * FROM ${d}runtime_event_producers WHERE producer_id=$1 AND incarnation=$2`,
      streamValues(stream)
    )
    if (existing.rows[0]) {
      // A reconnect reuses the authenticated immutable original registration,
      // even after current attempt or Agent-to-Unit membership changes.
      assertOriginalBinding(await producer(tx, stream, true), input)
      return
    }
    const binding = await tx.query(
      `SELECT a.id FROM ${d}attempts a WHERE a.id=$1 AND a.runtime_unit_id=$2 AND a.execution_epoch=$3 AND a.pod_uid=$4 AND a.incarnation=$5
       AND EXISTS(SELECT 1 FROM ${d}runtime_members m JOIN ${d}sessions s ON s.id=m.session_id WHERE m.runtime_unit_id=a.runtime_unit_id AND s.agent_id=$6)`,
      [w.attemptId, input.runtimeUnitId, w.executionEpoch, w.podUid, w.incarnation, input.agentId]
    )
    if (binding.rowCount !== 1) {
      reject('EVENT_BINDING')
    }
    await tx.query(
      `INSERT INTO ${d}runtime_event_producers(producer_id,incarnation,agent_id,runtime_unit_id,attempt_id,pod_uid,execution_epoch)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(producer_id,incarnation) DO NOTHING`,
      [
        w.producerId,
        w.incarnation,
        input.agentId,
        input.runtimeUnitId,
        w.attemptId,
        w.podUid,
        w.executionEpoch
      ]
    )
    assertOriginalBinding(await producer(tx, stream, true), input)
  })
}

function assertOriginalBinding(row: ProducerRow, input: EventProducer): void {
  const w = input.workload
  if (
    row.agent_id !== input.agentId ||
    row.runtime_unit_id !== input.runtimeUnitId ||
    row.attempt_id !== w.attemptId ||
    row.pod_uid !== w.podUid ||
    row.execution_epoch !== w.executionEpoch
  ) {
    reject('EVENT_PRODUCER_CONFLICT')
  }
}

/** Returns only after the PG COMMIT reply. A lost reply throws; retransmit the
 * original identity instead of fabricating an ACK or a new event identity. */
