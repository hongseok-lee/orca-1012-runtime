import { createHash } from 'node:crypto'
import path from 'node:path'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import {
  attachmentUploadId,
  AttachmentStoreError,
  type AttachmentUploadId,
  type AttachmentPrincipal,
  type AttachmentUpload,
  type AttachmentUploadState,
  type AttachmentAlias
} from './types.ts'

// P1-02 aggregate ranks 1..4 precede these. Within each rank, keys are lexical.
// Never acquire Session/Runtime Unit locks after calling a helper below.
export const UPLOAD_LOCK_RANK = 5
export const ALIAS_LOCK_RANK = 6
export const MEDIA_TYPE = 'image/png'

export type UploadRow = {
  [key: string]: unknown
  id: string
  principal_id: string
  target_connection_id: string | null
  expected_base64_length: string | number
  received_base64_length: string | number
  state: AttachmentUploadState
  revision: string
}

export type ChunkRow = {
  [key: string]: unknown
  chunk_offset: string | number
  content_base64: string
  content_hash: string
  char_length: string | number
}

export type AliasRow = {
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

export function wireLength(value: string | number): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new AttachmentStoreError('CORRUPT_LENGTH')
  }
  return result
}

export function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function uploadView(row: UploadRow, principal: AttachmentPrincipal): AttachmentUpload {
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

export function aliasView(row: AliasRow, principal: AttachmentPrincipal): AttachmentAlias {
  return {
    aliasPath: row.alias_path,
    uploadId: attachmentUploadId(row.upload_id),
    principal,
    contentHash: row.content_hash,
    byteLength: wireLength(row.byte_length),
    mediaType: row.media_type,
    targetConnectionId: row.target_connection_id
  }
}
