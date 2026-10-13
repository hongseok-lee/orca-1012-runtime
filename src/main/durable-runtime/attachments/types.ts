import type { LogicalId, RowRevision } from '../../../shared/durable-runtime/identity.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError } from '../db/connection.ts'

declare const principalBrand: unique symbol

/** Internal API: the adapter must authenticate the identity before constructing this value. */
export type AttachmentPrincipal = string & { readonly [principalBrand]: true }
export type AttachmentUploadId = LogicalId<'attachment-upload'>
export type AttachmentUploadState = 'OPEN' | 'COMMITTED' | 'ABORTED'

export function attachmentUploadId(value: string): AttachmentUploadId {
  return logicalId('attachment-upload', value)
}

/** Takes a verified pairedDeviceId, never RpcContext.clientId (the bearer credential). */
export function pairedDeviceAttachmentPrincipal(deviceId: string): AttachmentPrincipal {
  const id = logicalId('paired-device', deviceId)
  return `paired-device:${id}` as AttachmentPrincipal
}

/** Takes the authenticated context's SHA-256 fingerprint, not a token or client assertion. */
export function fingerprintAttachmentPrincipal(fingerprint: string): AttachmentPrincipal {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new AttachmentStoreError('INVALID_PRINCIPAL')
  }
  return `pairing-sha256:${fingerprint}` as AttachmentPrincipal
}

export function assertAttachmentPrincipal(value: AttachmentPrincipal): void {
  if (
    !/^paired-device:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) &&
    !/^pairing-sha256:[a-f0-9]{64}$/.test(value)
  ) {
    throw new AttachmentStoreError('INVALID_PRINCIPAL')
  }
}

export class AttachmentStoreError extends DurableDatabaseError {
  constructor(code: string) {
    super(code)
    this.name = 'AttachmentStoreError'
  }
}

export type AttachmentUpload = {
  id: AttachmentUploadId
  principal: AttachmentPrincipal
  targetConnectionId: string | null
  expectedBase64Length: number
  receivedBase64Length: number
  state: AttachmentUploadState
  revision: RowRevision<'attachment-upload'>
}

export type AttachmentAlias = {
  aliasPath: string
  uploadId: AttachmentUploadId
  principal: AttachmentPrincipal
  contentHash: string
  byteLength: number
  mediaType: string
  targetConnectionId: string | null
}

/** A snapshot to materialize only after the owning transaction has committed. */
export type CommittedAttachment = {
  contentBytes: Buffer
} & AttachmentAlias

export type AttachmentAbortResult =
  | { kind: 'missing' }
  | { kind: 'aborted' }
  | { kind: 'already-aborted' }
  | { kind: 'committed' }
