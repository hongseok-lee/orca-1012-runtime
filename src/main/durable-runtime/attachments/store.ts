import type { DurableTransaction } from '../db/connection.ts'
import {
  CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS,
  SaveImageAsTempFile,
  isValidBase64
} from '../../../shared/rpc-contract/clipboard-params.ts'
import {
  assertAttachmentPrincipal,
  AttachmentStoreError,
  type AttachmentPrincipal,
  type AttachmentUploadId,
  type AttachmentAlias,
  type CommittedAttachment
} from './types.ts'
import {
  ALIAS_LOCK_RANK,
  MEDIA_TYPE,
  wireLength,
  hash,
  aliasView,
  reserveAttachmentAlias,
  type AliasRow,
  type ChunkRow
} from './store-internals.ts'
import { requireOwnedUpload, startAttachmentUpload, appendAttachmentChunk } from './upload-store.ts'
export {
  startAttachmentUpload,
  appendAttachmentChunk,
  readAttachmentUpload,
  abortAttachmentUpload
} from './upload-store.ts'
export { attachmentFilename, reserveAttachmentAlias } from './store-internals.ts'

async function aliasForUpload(
  tx: DurableTransaction,
  principal: AttachmentPrincipal,
  id: AttachmentUploadId
): Promise<AttachmentAlias> {
  const result = await tx.query<AliasRow>(
    `SELECT a.*,b.byte_length,b.media_type,u.target_connection_id
     FROM durable_runtime.attachment_aliases a
     JOIN durable_runtime.attachment_blobs b ON b.content_hash=a.content_hash
     JOIN durable_runtime.attachment_uploads u ON u.id=a.upload_id
     WHERE a.upload_id=$1 AND a.principal_id=$2 AND u.principal_id=$2 AND u.state='COMMITTED'`,
    [id, principal]
  )
  if (!result.rows[0]) {
    throw new AttachmentStoreError('ALIAS_NOT_FOUND')
  }
  return aliasView(result.rows[0], principal)
}

export async function commitAttachmentUpload(
  tx: DurableTransaction,
  input: { id: AttachmentUploadId; principal: AttachmentPrincipal; aliasRoot: string }
): Promise<AttachmentAlias> {
  const upload = await requireOwnedUpload(tx, input.principal, input.id)
  if (upload.state === 'COMMITTED') {
    return aliasForUpload(tx, input.principal, input.id)
  }
  if (upload.state !== 'OPEN') {
    throw new AttachmentStoreError('UPLOAD_TERMINAL')
  }
  if (upload.receivedBase64Length !== upload.expectedBase64Length) {
    throw new AttachmentStoreError('UPLOAD_INCOMPLETE')
  }
  const result = await tx.query<ChunkRow>(
    `SELECT chunk_offset,content_base64,content_hash,char_length
     FROM durable_runtime.attachment_upload_chunks WHERE upload_id=$1 ORDER BY chunk_offset`,
    [input.id]
  )
  let length = 0
  for (const chunk of result.rows) {
    if (
      wireLength(chunk.chunk_offset) !== length ||
      chunk.content_base64.length === 0 ||
      wireLength(chunk.char_length) !== chunk.content_base64.length ||
      hash(chunk.content_base64) !== chunk.content_hash
    ) {
      throw new AttachmentStoreError('CORRUPT_CHUNKS')
    }
    length += chunk.content_base64.length
  }
  const contentBase64 = result.rows.map((chunk) => chunk.content_base64).join('')
  if (length !== upload.expectedBase64Length || !isValidBase64(contentBase64)) {
    throw new AttachmentStoreError('CORRUPT_CHUNKS')
  }
  const contentBytes = Buffer.from(contentBase64, 'base64')
  const contentHash = hash(contentBytes)
  const aliasPath = reserveAttachmentAlias(input.aliasRoot, input.id)
  await tx.query(
    `INSERT INTO durable_runtime.attachment_blobs
      (content_hash,content_bytes,byte_length,media_type,created_at)
     VALUES ($1,$2,$3,$4,clock_timestamp()) ON CONFLICT (content_hash) DO NOTHING`,
    [contentHash, contentBytes, contentBytes.length, MEDIA_TYPE]
  )
  const blob = await tx.query<{
    content_bytes: Buffer
    byte_length: string | number
    media_type: string
  }>(
    'SELECT content_bytes,byte_length,media_type FROM durable_runtime.attachment_blobs WHERE content_hash=$1',
    [contentHash]
  )
  const saved = blob.rows[0]
  if (
    !saved ||
    !saved.content_bytes.equals(contentBytes) ||
    wireLength(saved.byte_length) !== contentBytes.length ||
    saved.media_type !== MEDIA_TYPE
  ) {
    throw new AttachmentStoreError('BLOB_CONFLICT')
  }
  tx.advanceLock(ALIAS_LOCK_RANK, aliasPath)
  await tx.query(
    `INSERT INTO durable_runtime.attachment_aliases
      (alias_path,upload_id,principal_id,content_hash,created_at)
     VALUES ($1,$2,$3,$4,clock_timestamp())`,
    [aliasPath, input.id, input.principal, contentHash]
  )
  await tx.query(
    `UPDATE durable_runtime.attachment_uploads
     SET state='COMMITTED',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,
    [input.id]
  )
  return {
    aliasPath,
    uploadId: input.id,
    principal: input.principal,
    contentHash,
    byteLength: contentBytes.length,
    mediaType: MEDIA_TYPE,
    targetConnectionId: upload.targetConnectionId
  }
}

/** Legacy single-frame fallback, with exactly the same blob/alias commit path. */
export async function saveAttachmentImage(
  tx: DurableTransaction,
  input: {
    id: AttachmentUploadId
    principal: AttachmentPrincipal
    contentBase64: string
    aliasRoot: string
    targetConnectionId?: string | null
  }
): Promise<AttachmentAlias> {
  const parsed = SaveImageAsTempFile.safeParse({
    contentBase64: input.contentBase64,
    connectionId: input.targetConnectionId ?? null
  })
  if (!parsed.success) {
    throw new AttachmentStoreError('INVALID_IMAGE')
  }
  await startAttachmentUpload(tx, {
    ...input,
    expectedBase64Length: parsed.data.contentBase64.length
  })
  // Replays compare original chunk text, not just decoded bytes/content hash.
  // Reuse the wire chunk cap; no oversized synthetic chunk bypasses append validation.
  const chunkSize = CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
  for (let offset = 0; offset < parsed.data.contentBase64.length; offset += chunkSize) {
    await appendAttachmentChunk(tx, {
      id: input.id,
      principal: input.principal,
      offset,
      contentBase64: parsed.data.contentBase64.slice(offset, offset + chunkSize)
    })
  }
  return commitAttachmentUpload(tx, input)
}

/** Owner-scoped snapshot. Materialization must wait for the outer transaction's commit. */
export async function readCommittedAttachment(
  tx: DurableTransaction,
  principal: AttachmentPrincipal,
  aliasPath: string
): Promise<CommittedAttachment> {
  assertAttachmentPrincipal(principal)
  tx.advanceLock(ALIAS_LOCK_RANK, aliasPath)
  const result = await tx.query<AliasRow>(
    `SELECT a.*,b.byte_length,b.media_type,b.content_bytes,u.target_connection_id
     FROM durable_runtime.attachment_aliases a
     JOIN durable_runtime.attachment_blobs b ON b.content_hash=a.content_hash
     JOIN durable_runtime.attachment_uploads u ON u.id=a.upload_id
     WHERE a.alias_path=$1 AND a.principal_id=$2 AND u.principal_id=$2 AND u.state='COMMITTED'
     FOR KEY SHARE OF a`,
    [aliasPath, principal]
  )
  const row = result.rows[0]
  if (!row) {
    throw new AttachmentStoreError('ALIAS_NOT_FOUND')
  }
  const view = aliasView(row, principal)
  if (
    row.content_bytes.length !== view.byteLength ||
    hash(row.content_bytes) !== view.contentHash
  ) {
    throw new AttachmentStoreError('CORRUPT_BLOB')
  }
  return { ...view, contentBytes: Buffer.from(row.content_bytes) }
}
