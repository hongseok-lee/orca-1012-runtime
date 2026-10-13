import { createHash } from 'node:crypto'
import path from 'node:path'
import type { DurableTransaction } from '../db/connection.ts'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import {
  AppendImageUploadChunk,
  CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS,
  SaveImageAsTempFile,
  StartImageUpload,
  isValidBase64
} from '../../../shared/rpc-contract/clipboard-params.ts'
import {
  assertAttachmentPrincipal,
  attachmentUploadId,
  AttachmentStoreError,
  type AttachmentAbortResult,
  type AttachmentAlias,
  type AttachmentPrincipal,
  type AttachmentUpload,
  type AttachmentUploadId,
  type AttachmentUploadState,
  type CommittedAttachment
} from './types.ts'

// P1-02 aggregate ranks 1..4 precede these. Within each rank, keys are lexical.
// Never acquire Session/Runtime Unit locks after calling a helper below.
const UPLOAD_LOCK_RANK = 5
const ALIAS_LOCK_RANK = 6
const MEDIA_TYPE = 'image/png'

interface UploadRow {
  [key: string]: unknown
  id: string
  principal_id: string
  target_connection_id: string | null
  expected_base64_length: string | number
  received_base64_length: string | number
  state: AttachmentUploadState
  revision: string
}

interface ChunkRow {
  [key: string]: unknown
  chunk_offset: string | number
  content_base64: string
  content_hash: string
  char_length: string | number
}

interface AliasRow {
  [key: string]: unknown
  alias_path: string
  upload_id: string
  principal_id: string
  content_hash: string
  byte_length: string | number
  media_type: string
  target_connection_id: string | null
  content_bytes: Buffer
}

function wireLength(value: string | number): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new AttachmentStoreError('CORRUPT_LENGTH')
  return result
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function uploadView(row: UploadRow, principal: AttachmentPrincipal): AttachmentUpload {
  return {
    id: attachmentUploadId(row.id),
    principal,
    targetConnectionId: row.target_connection_id,
    expectedBase64Length: wireLength(row.expected_base64_length),
    receivedBase64Length: wireLength(row.received_base64_length),
    state: row.state,
    revision: counter('row:attachment-upload', row.revision)
  }
}

export function attachmentFilename(id: AttachmentUploadId): string {
  return `orca-paste-${attachmentUploadId(id)}.png`
}

export function reserveAttachmentAlias(aliasRoot: string, id: AttachmentUploadId): string {
  if (!path.isAbsolute(aliasRoot) || aliasRoot.includes('\0')) {
    throw new AttachmentStoreError('INVALID_ALIAS_ROOT')
  }
  return path.join(aliasRoot, attachmentFilename(id))
}

async function findOwnedUpload(
  tx: DurableTransaction,
  principal: AttachmentPrincipal,
  id: AttachmentUploadId
): Promise<AttachmentUpload | null> {
  assertAttachmentPrincipal(principal)
  attachmentUploadId(id)
  tx.advanceLock(UPLOAD_LOCK_RANK, id)
  const result = await tx.query<UploadRow>(
    `SELECT * FROM durable_runtime.attachment_uploads
     WHERE id=$1 AND principal_id=$2 FOR UPDATE`, [id, principal]
  )
  return result.rows[0] ? uploadView(result.rows[0], principal) : null
}

async function requireOwnedUpload(
  tx: DurableTransaction, principal: AttachmentPrincipal, id: AttachmentUploadId
): Promise<AttachmentUpload> {
  const upload = await findOwnedUpload(tx, principal, id)
  // Missing and another owner's upload are deliberately indistinguishable.
  if (!upload) throw new AttachmentStoreError('UPLOAD_NOT_FOUND')
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
    expectedBase64Length: input.expectedBase64Length, connectionId: input.targetConnectionId ?? null
  })
  if (!parsed.success) throw new AttachmentStoreError('INVALID_UPLOAD')
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
  if (upload.targetConnectionId !== parsed.data.connectionId ||
      upload.expectedBase64Length !== parsed.data.expectedBase64Length) {
    throw new AttachmentStoreError('UPLOAD_CONFLICT')
  }
  return upload
}

export async function readAttachmentUpload(
  tx: DurableTransaction, principal: AttachmentPrincipal, id: AttachmentUploadId
): Promise<AttachmentUpload> {
  return requireOwnedUpload(tx, principal, id)
}

export async function appendAttachmentChunk(
  tx: DurableTransaction,
  input: { id: AttachmentUploadId; principal: AttachmentPrincipal; offset: number; contentBase64: string }
): Promise<{ receivedBase64Length: number }> {
  const parsed = AppendImageUploadChunk.safeParse({
    uploadId: input.id, offset: input.offset, contentBase64: input.contentBase64
  })
  if (!parsed.success) throw new AttachmentStoreError('INVALID_CHUNK')
  const upload = await requireOwnedUpload(tx, input.principal, input.id)
  const { offset, contentBase64 } = parsed.data
  if (contentBase64.length === 0) {
    if (upload.state !== 'OPEN') throw new AttachmentStoreError('UPLOAD_TERMINAL')
    if (offset !== upload.receivedBase64Length) throw new AttachmentStoreError('CHUNK_ORDER')
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
    if (chunk.content_base64 !== contentBase64 || chunk.content_hash !== digest ||
        wireLength(chunk.char_length) !== contentBase64.length) {
      throw new AttachmentStoreError('CHUNK_CONFLICT')
    }
    // Return the original boundary, even after later chunks or a terminal transition.
    return { receivedBase64Length: offset + contentBase64.length }
  }
  if (upload.state !== 'OPEN') throw new AttachmentStoreError('UPLOAD_TERMINAL')
  if (offset !== upload.receivedBase64Length) throw new AttachmentStoreError('CHUNK_ORDER')
  const received = offset + contentBase64.length
  if (received > upload.expectedBase64Length) throw new AttachmentStoreError('CHUNK_TOO_LARGE')
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

function aliasView(row: AliasRow, principal: AttachmentPrincipal): AttachmentAlias {
  return {
    aliasPath: row.alias_path, uploadId: attachmentUploadId(row.upload_id), principal,
    contentHash: row.content_hash, byteLength: wireLength(row.byte_length), mediaType: row.media_type,
    targetConnectionId: row.target_connection_id
  }
}

async function aliasForUpload(
  tx: DurableTransaction, principal: AttachmentPrincipal, id: AttachmentUploadId
): Promise<AttachmentAlias> {
  const result = await tx.query<AliasRow>(
    `SELECT a.*,b.byte_length,b.media_type,u.target_connection_id
     FROM durable_runtime.attachment_aliases a
     JOIN durable_runtime.attachment_blobs b ON b.content_hash=a.content_hash
     JOIN durable_runtime.attachment_uploads u ON u.id=a.upload_id
     WHERE a.upload_id=$1 AND a.principal_id=$2 AND u.principal_id=$2 AND u.state='COMMITTED'`,
    [id, principal]
  )
  if (!result.rows[0]) throw new AttachmentStoreError('ALIAS_NOT_FOUND')
  return aliasView(result.rows[0], principal)
}

export async function commitAttachmentUpload(
  tx: DurableTransaction,
  input: { id: AttachmentUploadId; principal: AttachmentPrincipal; aliasRoot: string }
): Promise<AttachmentAlias> {
  const upload = await requireOwnedUpload(tx, input.principal, input.id)
  if (upload.state === 'COMMITTED') return aliasForUpload(tx, input.principal, input.id)
  if (upload.state !== 'OPEN') throw new AttachmentStoreError('UPLOAD_TERMINAL')
  if (upload.receivedBase64Length !== upload.expectedBase64Length) {
    throw new AttachmentStoreError('UPLOAD_INCOMPLETE')
  }
  const result = await tx.query<ChunkRow>(
    `SELECT chunk_offset,content_base64,content_hash,char_length
     FROM durable_runtime.attachment_upload_chunks WHERE upload_id=$1 ORDER BY chunk_offset`, [input.id]
  )
  let length = 0
  for (const chunk of result.rows) {
    if (wireLength(chunk.chunk_offset) !== length || chunk.content_base64.length === 0 ||
        wireLength(chunk.char_length) !== chunk.content_base64.length ||
        hash(chunk.content_base64) !== chunk.content_hash) {
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
  const blob = await tx.query<{ content_bytes: Buffer; byte_length: string | number; media_type: string }>(
    'SELECT content_bytes,byte_length,media_type FROM durable_runtime.attachment_blobs WHERE content_hash=$1',
    [contentHash]
  )
  const saved = blob.rows[0]
  if (!saved || !saved.content_bytes.equals(contentBytes) ||
      wireLength(saved.byte_length) !== contentBytes.length || saved.media_type !== MEDIA_TYPE) {
    throw new AttachmentStoreError('BLOB_CONFLICT')
  }
  tx.advanceLock(ALIAS_LOCK_RANK, aliasPath)
  await tx.query(
    `INSERT INTO durable_runtime.attachment_aliases
      (alias_path,upload_id,principal_id,content_hash,created_at)
     VALUES ($1,$2,$3,$4,clock_timestamp())`, [aliasPath, input.id, input.principal, contentHash]
  )
  await tx.query(
    `UPDATE durable_runtime.attachment_uploads
     SET state='COMMITTED',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, [input.id]
  )
  return { aliasPath, uploadId: input.id, principal: input.principal, contentHash,
    byteLength: contentBytes.length, mediaType: MEDIA_TYPE, targetConnectionId: upload.targetConnectionId }
}

/** Legacy single-frame fallback, with exactly the same blob/alias commit path. */
export async function saveAttachmentImage(
  tx: DurableTransaction,
  input: { id: AttachmentUploadId; principal: AttachmentPrincipal; contentBase64: string;
    aliasRoot: string; targetConnectionId?: string | null }
): Promise<AttachmentAlias> {
  const parsed = SaveImageAsTempFile.safeParse({
    contentBase64: input.contentBase64, connectionId: input.targetConnectionId ?? null
  })
  if (!parsed.success) throw new AttachmentStoreError('INVALID_IMAGE')
  await startAttachmentUpload(tx, {
    ...input, expectedBase64Length: parsed.data.contentBase64.length
  })
  // Replays compare original chunk text, not just decoded bytes/content hash.
  // Reuse the wire chunk cap; no oversized synthetic chunk bypasses append validation.
  const chunkSize = CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
  for (let offset = 0; offset < parsed.data.contentBase64.length; offset += chunkSize) {
    await appendAttachmentChunk(tx, { id: input.id, principal: input.principal, offset,
      contentBase64: parsed.data.contentBase64.slice(offset, offset + chunkSize) })
  }
  return commitAttachmentUpload(tx, input)
}

export async function abortAttachmentUpload(
  tx: DurableTransaction, principal: AttachmentPrincipal, id: AttachmentUploadId
): Promise<AttachmentAbortResult> {
  const upload = await findOwnedUpload(tx, principal, id)
  if (!upload) return { kind: 'missing' }
  if (upload.state === 'COMMITTED') return { kind: 'committed' }
  if (upload.state === 'ABORTED') return { kind: 'already-aborted' }
  await tx.query(
    `UPDATE durable_runtime.attachment_uploads
     SET state='ABORTED',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, [id]
  )
  return { kind: 'aborted' }
}

/** Owner-scoped snapshot. Materialization must wait for the outer transaction's commit. */
export async function readCommittedAttachment(
  tx: DurableTransaction, principal: AttachmentPrincipal, aliasPath: string
): Promise<CommittedAttachment> {
  assertAttachmentPrincipal(principal)
  tx.advanceLock(ALIAS_LOCK_RANK, aliasPath)
  const result = await tx.query<AliasRow>(
    `SELECT a.*,b.byte_length,b.media_type,b.content_bytes,u.target_connection_id
     FROM durable_runtime.attachment_aliases a
     JOIN durable_runtime.attachment_blobs b ON b.content_hash=a.content_hash
     JOIN durable_runtime.attachment_uploads u ON u.id=a.upload_id
     WHERE a.alias_path=$1 AND a.principal_id=$2 AND u.principal_id=$2 AND u.state='COMMITTED'
     FOR KEY SHARE OF a`, [aliasPath, principal]
  )
  const row = result.rows[0]
  if (!row) throw new AttachmentStoreError('ALIAS_NOT_FOUND')
  const view = aliasView(row, principal)
  if (row.content_bytes.length !== view.byteLength || hash(row.content_bytes) !== view.contentHash) {
    throw new AttachmentStoreError('CORRUPT_BLOB')
  }
  return { ...view, contentBytes: Buffer.from(row.content_bytes) }
}
