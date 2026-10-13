import type { DurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import type { MessageId, SessionId } from '../../../shared/durable-runtime/identity.ts'
import { InputStoreError, type InputKind } from './types.ts'

export type PendingMessageRow = {
  id: string
  seq: string
  revision: string
  input_kind: InputKind
  merge_closed: boolean
  sealed_revision: string | null
  sealed_payload_hash: string | null
  intake_status: string
  cancel_revision: string
  body_or_blob_ref: JsonValue
}
export function requireInputSessionLock(tx: DurableTransaction, sessionId: SessionId): void {
  if (!tx.isLockHeld(1, sessionId)) {
    throw new InputStoreError('INPUT_SESSION_LOCK_REQUIRED')
  }
}
export function mergeable(row: PendingMessageRow | undefined): boolean {
  return (
    !!row &&
    row.input_kind === 'GENERAL' &&
    row.intake_status === 'DURABLE' &&
    !row.merge_closed &&
    row.sealed_revision === null &&
    row.cancel_revision === '0'
  )
}
export async function latestInputMessage(
  tx: DurableTransaction,
  sessionId: SessionId
): Promise<PendingMessageRow | undefined> {
  requireInputSessionLock(tx, sessionId)
  const rows = await tx.query<PendingMessageRow>(
    'SELECT * FROM durable_runtime.messages WHERE session_id=$1 ORDER BY seq DESC LIMIT 1 FOR UPDATE',
    [sessionId]
  )
  return rows.rows[0]
}
export async function closeLatestMergeable(
  tx: DurableTransaction,
  sessionId: SessionId
): Promise<string | null> {
  const latest = await latestInputMessage(tx, sessionId)
  if (!mergeable(latest) || !latest) {
    return null
  }
  const changed = await tx.query<{ revision: string }>(
    'UPDATE durable_runtime.messages SET merge_closed=true,revision=revision+1 WHERE id=$1 RETURNING revision',
    [latest.id]
  )
  return changed.rows[0].revision
}
/** Reconstruct from immutable PG originals, including duplicate positions. */
export async function composeMessagePayload(
  tx: DurableTransaction,
  sessionId: SessionId,
  messageId: MessageId,
  kind: InputKind
): Promise<JsonValue> {
  requireInputSessionLock(tx, sessionId)
  const inputs = await tx.query<{
    id: string
    input_seq: string
    authenticated_sender: string
    client_operation_id: string | null
    original_payload_hash: string
    body_or_blob_ref: JsonValue
  }>(
    'SELECT * FROM durable_runtime.input_components WHERE session_id=$1 AND message_id=$2 ORDER BY input_seq',
    [sessionId, messageId]
  )
  const attachments = await tx.query<{
    input_id: string
    position: string
    blob_ref: string
    content_hash: string
  }>(
    `SELECT a.* FROM durable_runtime.input_attachments a
     JOIN durable_runtime.input_components i ON i.id=a.input_id
     WHERE i.session_id=$1 AND i.message_id=$2 ORDER BY i.input_seq,a.position`,
    [sessionId, messageId]
  )
  const byInput = new Map<string, JsonValue[]>()
  for (const attachment of attachments.rows) {
    const list = byInput.get(attachment.input_id) ?? []
    list.push({
      position: attachment.position,
      aliasPath: attachment.blob_ref,
      contentHash: attachment.content_hash
    })
    byInput.set(attachment.input_id, list)
  }
  return {
    version: 1,
    inputKind: kind,
    components: inputs.rows.map((input) => ({
      inputId: input.id,
      inputSequence: input.input_seq,
      sender: input.authenticated_sender,
      operationKey: input.client_operation_id,
      originalPayloadHash: input.original_payload_hash,
      original: input.body_or_blob_ref,
      attachments: byInput.get(input.id) ?? []
    }))
  }
}
