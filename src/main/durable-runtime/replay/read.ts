import type { Pool } from 'pg'
import type { JsonValue } from '../db/atomic.ts'
import { withDurableTransaction } from '../db/connection.ts'
import type { ReplayRead, ReplayPage } from './types.ts'
import { stream, decimal, pageLimit, uuid, reject } from './validation.ts'

// One MVCC snapshot for head and bounded global scan; filtering follows scanning.
// Page and a future HTTP/SSE tail consume this exact cursor contract.
export async function readReplayPage(pool: Pool, request: ReplayRead): Promise<ReplayPage> {
  const input = Object.freeze({ streamId: request.streamId, epoch: request.epoch, afterOffset: request.afterOffset,
    optionalUnitFilter: request.optionalUnitFilter, limit: request.limit })
  stream(input.streamId)
  decimal(input.epoch)
  decimal(input.afterOffset)
  pageLimit(input.limit)
  if (input.optionalUnitFilter !== undefined) {
    uuid(input.optionalUnitFilter)
  }
  return withDurableTransaction(pool, async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const result = await tx.query<{ epoch: string; published_offset: string }>(
      'SELECT epoch,published_offset FROM durable_runtime.replay_stream_heads WHERE stream_id=$1',
      [input.streamId]
    )
    const head = result.rows[0] ?? { epoch: '0', published_offset: '0' }
    if (input.epoch !== head.epoch) {
      return {
        status: 'RESET_REQUIRED',
        streamId: input.streamId,
        currentEpoch: head.epoch,
        minimumOffset: '1',
        latestOffset: head.published_offset
      }
    }
    if (BigInt(input.afterOffset) > BigInt(head.published_offset)) {
      reject('REPLAY_FUTURE_CURSOR')
    }
    const scan = await tx.query<{
      epoch: string
      offset: string
      event_id: string
      occurred_at: Date
      published_at: Date
      payload: JsonValue
    }>(
      'SELECT epoch,"offset",event_id,occurred_at,published_at,payload FROM durable_runtime.replay_events WHERE stream_id=$1 AND epoch=$2 AND "offset">$3 AND "offset"<=$4 ORDER BY "offset" LIMIT $5',
      [input.streamId, head.epoch, input.afterOffset, head.published_offset, input.limit]
    )
    const next = scan.rows.at(-1)?.offset ?? input.afterOffset
    const events = scan.rows
      .filter((row) => {
        if (input.optionalUnitFilter === undefined) {
          return true
        }
        const payload = row.payload
        return (
          typeof payload === 'object' &&
          payload !== null &&
          !Array.isArray(payload) &&
          typeof payload.targetRef === 'object' &&
          payload.targetRef !== null &&
          !Array.isArray(payload.targetRef) &&
          payload.targetRef.runtimeUnitId === input.optionalUnitFilter
        )
      })
      .map((row) => ({
        cursor: { streamId: input.streamId, epoch: row.epoch, offset: row.offset },
        sourceEventId: row.event_id,
        occurredAt: row.occurred_at,
        publishedAt: row.published_at,
        payload: row.payload
      }))
    return {
      status: 'PAGE',
      events,
      scanned: scan.rows.length,
      nextCursor: { streamId: input.streamId, epoch: head.epoch, offset: next },
      highWatermark: { streamId: input.streamId, epoch: head.epoch, offset: head.published_offset },
      minimumOffset: '1'
    }
  })
}
