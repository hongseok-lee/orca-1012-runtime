import { randomUUID } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { readCommittedAttachment } from '../attachments/store.ts'
import { InputStoreError, type PreparedInput } from './types.ts'
import {
  latestInputMessage,
  mergeable,
  closeLatestMergeable,
  composeMessagePayload
} from './composition.ts'

/** Alias lock order is independent of original attachment occurrence order. */
export async function validateInputAttachments(
  tx: DurableTransaction,
  prepared: PreparedInput
): Promise<void> {
  const { attachments, authority } = prepared.request
  const aliases = new Map<string, string>()
  for (const item of attachments) {
    if (!item.aliasPath || !/^[a-f0-9]{64}$/.test(item.contentHash)) {
      throw new InputStoreError('INPUT_ATTACHMENT')
    }
    const existing = aliases.get(item.aliasPath)
    if (existing && existing !== item.contentHash) {
      throw new InputStoreError('INPUT_ATTACHMENT_CONFLICT')
    }
    aliases.set(item.aliasPath, item.contentHash)
  }
  for (const alias of [...aliases.keys()].sort()) {
    const saved = await readCommittedAttachment(tx, authority.principal, alias)
    if (saved.contentHash !== aliases.get(alias)) {
      throw new InputStoreError('INPUT_ATTACHMENT_CONFLICT')
    }
    tx.markLockAcquired(6, alias)
  }
}
export async function appendInputComponent(tx: DurableTransaction, prepared: PreparedInput) {
  const { authority, inputKind, operationKey, attachments } = prepared.request
  // Only the latest Message can merge; never search backwards past a semantic boundary.
  if (inputKind !== 'GENERAL') {
    await closeLatestMergeable(tx, authority.sessionId)
  }
  const latest = await latestInputMessage(tx, authority.sessionId)
  let messageId =
    inputKind === 'GENERAL' && mergeable(latest) ? logicalId('message', latest!.id) : null
  let messageSequence = latest?.seq
  if (!messageId) {
    const allocation = await tx.query<{ seq: string }>(
      `UPDATE durable_runtime.sessions SET next_message_seq=next_message_seq+1
       WHERE id=$1 RETURNING next_message_seq-1 AS seq`,
      [authority.sessionId]
    )
    messageSequence = allocation.rows[0].seq
    messageId = logicalId('message', randomUUID())
    await tx.query(
      `INSERT INTO durable_runtime.messages(id,session_id,seq,revision,body_or_blob_ref,intake_status,input_kind,merge_closed)
       VALUES ($1,$2,$3,0,$4,'DURABLE',$5,$6)`,
      [
        messageId,
        authority.sessionId,
        messageSequence,
        JSON.stringify({ version: 1, inputKind, components: [] }),
        inputKind,
        inputKind !== 'GENERAL'
      ]
    )
  }
  const allocation = await tx.query<{ seq: string }>(
    `UPDATE durable_runtime.sessions SET next_input_seq=next_input_seq+1,revision=revision+1
     WHERE id=$1 RETURNING next_input_seq-1 AS seq`,
    [authority.sessionId]
  )
  const inputSequence = counter('sequence:input', allocation.rows[0].seq)
  const inputId = logicalId('input', randomUUID())
  await tx.query(
    `INSERT INTO durable_runtime.input_components
     (id,message_id,session_id,input_seq,authenticated_sender,client_operation_id,original_payload_hash,body_or_blob_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      inputId,
      messageId,
      authority.sessionId,
      inputSequence,
      authority.principal,
      operationKey,
      prepared.identity.payloadHash,
      JSON.stringify(prepared.original)
    ]
  )
  for (const [position, item] of attachments.entries()) {
    await tx.query(
      'INSERT INTO durable_runtime.input_attachments(input_id,position,blob_ref,content_hash) VALUES ($1,$2,$3,$4)',
      [inputId, position, item.aliasPath, item.contentHash]
    )
  }
  const payload = await composeMessagePayload(tx, authority.sessionId, messageId, inputKind)
  const message = await tx.query<{ revision: string }>(
    `UPDATE durable_runtime.messages SET revision=revision+1,body_or_blob_ref=$2
     WHERE id=$1 RETURNING revision`,
    [messageId, JSON.stringify(payload)]
  )
  return {
    inputId,
    inputSequence,
    messageId,
    messageSequence: counter('sequence:message', messageSequence!),
    messageRevision: counter('message-revision', message.rows[0].revision)
  }
}
