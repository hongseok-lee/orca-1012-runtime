import type { DurableTransaction } from '../db/connection.ts'
import {
  AppendImageUploadChunk,
  StartImageUpload
} from '../../../shared/rpc-contract/clipboard-params.ts'
import {
  assertAttachmentPrincipal,
  attachmentUploadId,
  AttachmentStoreError,
  type AttachmentPrincipal,
  type AttachmentUploadId,
  type AttachmentUpload,
  type AttachmentAbortResult
} from './types.ts'
import {
  UPLOAD_LOCK_RANK,
  uploadView,
  wireLength,
  hash,
  type UploadRow,
  type ChunkRow
} from './store-internals.ts'

export async function findOwnedUpload(
  tx: DurableTransaction,
  principal: AttachmentPrincipal,
  id: AttachmentUploadId
): Promise<AttachmentUpload | null> {
  assertAttachmentPrincipal(principal)
  attachmentUploadId(id)
  tx.advanceLock(UPLOAD_LOCK_RANK, id)
  const result = await tx.query<UploadRow>(
    `SELECT * FROM durable_runtime.attachment_uploads
     WHERE id=$1 AND principal_id=$2 FOR UPDATE`,
    [id, principal]
  )
  return result.rows[0] ? uploadView(result.rows[0], principal) : null
}

export async function requireOwnedUpload(
  tx: DurableTransaction,
  principal: AttachmentPrincipal,
  id: AttachmentUploadId
): Promise<AttachmentUpload> {
  const upload = await findOwnedUpload(tx, principal, id)
  // Missing and another owner's upload are deliberately indistinguishable.
  if (!upload) {
    throw new AttachmentStoreError('UPLOAD_NOT_FOUND')
  }
  return upload
}

export async function startAttachmentUpload(
  tx: DurableTransaction,
  input: {
    id: AttachmentUploadId
    principal: AttachmentPrincipal
    expectedBase64Length: number
    targetConnectionId?: string | null
  }
): Promise<AttachmentUpload> {
  assertAttachmentPrincipal(input.principal)
  attachmentUploadId(input.id)
  const parsed = StartImageUpload.safeParse({
    expectedBase64Length: input.expectedBase64Length,
    connectionId: input.targetConnectionId ?? null
  })
  if (!parsed.success) {
    throw new AttachmentStoreError('INVALID_UPLOAD')
  }
  tx.advanceLock(UPLOAD_LOCK_RANK, input.id)
  await tx.query(
    `INSERT INTO durable_runtime.attachment_uploads
      (id,principal_id,target_connection_id,expected_base64_length,received_base64_length,
       state,revision,created_at,updated_at)
     VALUES ($1,$2,$3,$4,0,'OPEN',0,clock_timestamp(),clock_timestamp())
     ON CONFLICT (id) DO NOTHING`,
    [input.id, input.principal, parsed.data.connectionId, parsed.data.expectedBase64Length]
  )
  const upload = await requireOwnedUpload(tx, input.principal, input.id)
  if (
    upload.targetConnectionId !== parsed.data.connectionId ||
    upload.expectedBase64Length !== parsed.data.expectedBase64Length
  ) {
    throw new AttachmentStoreError('UPLOAD_CONFLICT')
  }
  return upload
}

export async function readAttachmentUpload(
  tx: DurableTransaction,
  principal: AttachmentPrincipal,
  id: AttachmentUploadId
): Promise<AttachmentUpload> {
  return requireOwnedUpload(tx, principal, id)
}

export async function appendAttachmentChunk(
  tx: DurableTransaction,
  input: {
    id: AttachmentUploadId
    principal: AttachmentPrincipal
    offset: number
    contentBase64: string
  }
): Promise<{ receivedBase64Length: number }> {
  const parsed = AppendImageUploadChunk.safeParse({
    uploadId: input.id,
    offset: input.offset,
    contentBase64: input.contentBase64
  })
  if (!parsed.success) {
    throw new AttachmentStoreError('INVALID_CHUNK')
  }
  const upload = await requireOwnedUpload(tx, input.principal, input.id)
  const { offset, contentBase64 } = parsed.data
  if (contentBase64.length === 0) {
    if (upload.state !== 'OPEN') {
      throw new AttachmentStoreError('UPLOAD_TERMINAL')
    }
    if (offset !== upload.receivedBase64Length) {
      throw new AttachmentStoreError('CHUNK_ORDER')
    }
    return { receivedBase64Length: upload.receivedBase64Length }
  }
  const previous = await tx.query<ChunkRow>(
    `SELECT chunk_offset,content_base64,content_hash,char_length
     FROM durable_runtime.attachment_upload_chunks WHERE upload_id=$1 AND chunk_offset=$2`,
    [input.id, offset]
  )
  const digest = hash(contentBase64)
  const chunk = previous.rows[0]
  if (chunk) {
    if (
      chunk.content_base64 !== contentBase64 ||
      chunk.content_hash !== digest ||
      wireLength(chunk.char_length) !== contentBase64.length
    ) {
      throw new AttachmentStoreError('CHUNK_CONFLICT')
    }
    // Return the original boundary, even after later chunks or a terminal transition.
    return { receivedBase64Length: offset + contentBase64.length }
  }
  if (upload.state !== 'OPEN') {
    throw new AttachmentStoreError('UPLOAD_TERMINAL')
  }
  if (offset !== upload.receivedBase64Length) {
    throw new AttachmentStoreError('CHUNK_ORDER')
  }
  const received = offset + contentBase64.length
  if (received > upload.expectedBase64Length) {
    throw new AttachmentStoreError('CHUNK_TOO_LARGE')
  }
  await tx.query(
    `INSERT INTO durable_runtime.attachment_upload_chunks
      (upload_id,chunk_offset,content_base64,content_hash,char_length) VALUES ($1,$2,$3,$4,$5)`,
    [input.id, offset, contentBase64, digest, contentBase64.length]
  )
  await tx.query(
    `UPDATE durable_runtime.attachment_uploads
     SET received_base64_length=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,
    [input.id, received]
  )
  return { receivedBase64Length: received }
}

export async function abortAttachmentUpload(
  tx: DurableTransaction,
  principal: AttachmentPrincipal,
  id: AttachmentUploadId
): Promise<AttachmentAbortResult> {
  const upload = await findOwnedUpload(tx, principal, id)
  if (!upload) {
    return { kind: 'missing' }
  }
  if (upload.state === 'COMMITTED') {
    return { kind: 'committed' }
  }
  if (upload.state === 'ABORTED') {
    return { kind: 'already-aborted' }
  }
  await tx.query(
    `UPDATE durable_runtime.attachment_uploads
     SET state='ABORTED',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,
    [id]
  )
  return { kind: 'aborted' }
}
