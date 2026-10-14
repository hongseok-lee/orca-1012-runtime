import type { Pool } from 'pg'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { withDurableTransaction, type DurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { assertInputScope } from './authority.ts'
import {
  composeMessagePayload,
  requireInputSessionLock,
  type PendingMessageRow
} from './composition.ts'
import { inputPayloadHash } from './canonical.ts'
import { InputStoreError, type SealRequest, type SealedInputMessage } from './types.ts'

/** A payload seal only, never execution ownership, provider effect or ADMITTED. */
export async function sealInputMessage(
  pool: Pool,
  input: SealRequest
): Promise<SealedInputMessage> {
  return withDurableTransaction(pool, async (tx) => {
    await lockAggregates(tx, { sessionIds: [input.authority.sessionId] })
    return sealInputMessageInTransaction(tx, input)
  })
}

/** Composes with gateway stage in an existing P1-03 transaction. */
export async function sealInputMessageInTransaction(
  tx: DurableTransaction,
  input: SealRequest
): Promise<SealedInputMessage> {
  logicalId('message', input.messageId)
  counter('message-revision', input.expectedRevision)
  requireInputSessionLock(tx, input.authority.sessionId)
  await assertInputScope(tx, input.authority)
  const result = await tx.query<PendingMessageRow>(
    'SELECT * FROM durable_runtime.messages WHERE id=$1 AND session_id=$2 FOR UPDATE',
    [input.messageId, input.authority.sessionId]
  )
  const row = result.rows[0]
  if (!row) {
    throw new InputStoreError('INPUT_MESSAGE_NOT_FOUND')
  }
  if (row.sealed_revision !== null) {
    if (row.sealed_revision !== input.expectedRevision) {
      throw new InputStoreError('INPUT_REVISION_CONFLICT')
    }
    return {
      messageId: input.messageId,
      sealedRevision: counter('message-revision', row.sealed_revision),
      payloadHash: row.sealed_payload_hash!,
      payload: row.body_or_blob_ref
    }
  }
  if (row.revision !== input.expectedRevision) {
    throw new InputStoreError('INPUT_REVISION_CONFLICT')
  }
  if (row.intake_status !== 'DURABLE' || row.cancel_revision !== '0') {
    throw new InputStoreError('INPUT_MESSAGE_NOT_PENDING')
  }
  const payload = await composeMessagePayload(
    tx,
    input.authority.sessionId,
    input.messageId,
    row.input_kind
  )
  const payloadHash = inputPayloadHash(payload)
  await tx.query(
    `UPDATE durable_runtime.messages SET body_or_blob_ref=$2,sealed_payload_hash=$3,
     sealed_revision=revision,merge_closed=true,intake_status='DISPATCH_INTENT' WHERE id=$1`,
    [input.messageId, JSON.stringify(payload), payloadHash]
  )
  return {
    messageId: input.messageId,
    sealedRevision: input.expectedRevision,
    payloadHash,
    payload
  }
}
