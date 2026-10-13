import type { Pool } from 'pg'
import { withDurableTransaction } from '../db/connection.ts'
import { mapSource, type OutboxRow } from './mapper.ts'
import { OPS_REPLAY_STREAM, type PublicationInput, type PublicationResult } from './types.ts'
import { stream, uuid, reject, decimal } from './validation.ts'

// Dedicated SQL transaction: no provider callback and no business locks after rank8.
export async function publishClaimToReplay(
  pool: Pool,
  input: PublicationInput
): Promise<PublicationResult> {
  const streamId = stream(input.streamId ?? OPS_REPLAY_STREAM)
  const { claim } = input
  uuid(claim.id)
  uuid(claim.token)
  if (!claim.owner) {
    reject('REPLAY_CLAIM')
  }
  return withDurableTransaction(pool, async (tx) => {
    tx.advanceLock(8, claim.id)
    const found = await tx.query<OutboxRow>(
      `SELECT *,claim_expires_at>clock_timestamp() AS claim_live
      FROM durable_runtime.outbox_events WHERE id=$1 FOR UPDATE`,
      [claim.id]
    )
    const row = found.rows[0]
    if (!row) {
      reject('REPLAY_SOURCE_MISSING')
    }
    tx.markLockAcquired(8, claim.id)
    const existing = await tx.query<
      { stream_id: string; epoch: string; offset: string } & { payload: unknown; matches: boolean }
    >(
      'SELECT stream_id,epoch,"offset",payload FROM durable_runtime.replay_events WHERE event_id=$1',
      [row.id]
    )
    if (row.state === 'PUBLISHED' && !existing.rows[0]) {
      return { status: 'NOT_PUBLISHED_HERE', sourceEventId: row.id }
    }
    if (
      !existing.rows[0] &&
      (row.state !== 'CLAIMED' ||
        row.claim_owner !== claim.owner ||
        row.claim_token !== claim.token ||
        !row.claim_live)
    ) {
      reject('REPLAY_STALE_CLAIM')
    }
    const mapped = await mapSource(tx, row)
    if (!mapped) {
      if (existing.rows[0]) {
        reject('REPLAY_SOURCE_CONFLICT')
      }
      return {
        status: 'UNSUPPORTED_SOURCE',
        sourceEventId: row.id,
        sourceKind:
          typeof row.event === 'object' &&
          row.event !== null &&
          !Array.isArray(row.event) &&
          typeof row.event.kind === 'string'
            ? row.event.kind
            : null
      }
    }
    if (existing.rows[0]) {
      const exact = await tx.query<{ epoch: string; offset: string }>(
        'SELECT epoch,"offset" FROM durable_runtime.replay_events WHERE event_id=$1 AND stream_id=$2 AND payload=$3::jsonb AND occurred_at=$4',
        [row.id, streamId, JSON.stringify(mapped.payload), mapped.occurredAt]
      )
      if (row.state !== 'PUBLISHED' || exact.rowCount !== 1) {
        reject('REPLAY_SOURCE_CONFLICT')
      }
      return {
        status: 'REPLAYED',
        cursor: {
          streamId,
          epoch: decimal(exact.rows[0].epoch),
          offset: decimal(exact.rows[0].offset)
        }
      }
    }
    tx.advanceLock(9, streamId)
    await tx.query(
      'INSERT INTO durable_runtime.replay_stream_heads(stream_id,epoch) VALUES($1,0) ON CONFLICT(stream_id) DO NOTHING',
      [streamId]
    )
    const head = await tx.query<{ epoch: string; published_offset: string }>(
      'SELECT epoch,published_offset FROM durable_runtime.replay_stream_heads WHERE stream_id=$1 FOR UPDATE',
      [streamId]
    )
    tx.markLockAcquired(9, streamId)
    if (head.rows[0].epoch !== '0') {
      reject('REPLAY_EPOCH_UNSUPPORTED')
    }
    const offset = decimal((BigInt(head.rows[0].published_offset) + 1n).toString())
    await tx.query(
      'INSERT INTO durable_runtime.replay_events(stream_id,epoch,"offset",event_id,occurred_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
      [
        streamId,
        head.rows[0].epoch,
        offset,
        row.id,
        mapped.occurredAt,
        JSON.stringify(mapped.payload)
      ]
    )
    await tx.query(
      'UPDATE durable_runtime.replay_stream_heads SET published_offset=$2 WHERE stream_id=$1',
      [streamId, offset]
    )
    const completed = await tx.query(
      `UPDATE durable_runtime.outbox_events SET state='PUBLISHED',published_at=clock_timestamp(),claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL
      WHERE id=$1 AND claim_owner=$2 AND claim_token=$3 AND claim_expires_at>clock_timestamp()`,
      [row.id, claim.owner, claim.token]
    )
    if (completed.rowCount !== 1) {
      reject('REPLAY_STALE_CLAIM')
    }
    return { status: 'PUBLISHED', cursor: { streamId, epoch: head.rows[0].epoch, offset } }
  })
}
