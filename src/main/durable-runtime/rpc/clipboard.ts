import { randomUUID } from 'node:crypto'
import {
  SaveImageAsTempFile, StartImageUpload, AppendImageUploadChunk,
  CommitImageUpload, AbortImageUpload
} from '../../../shared/rpc-contract/clipboard-params.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import { captureCatalogParsed } from '../catalog/immutable.ts'
import { withDurableTransaction, type DurableTransaction } from '../db/connection.ts'
import {
  startAttachmentUpload, appendAttachmentChunk, commitAttachmentUpload,
  saveAttachmentImage, abortAttachmentUpload, readAttachmentUpload, reserveAttachmentAlias
} from '../attachments/store.ts'
import { attachmentUploadId, fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { CatalogReadError, catalogReadFailure } from './config.ts'

export type CatalogClipboardMethod =
  | 'clipboard.saveImageAsTempFile'
  | 'clipboard.startImageUpload'
  | 'clipboard.appendImageUploadChunk'
  | 'clipboard.commitImageUpload'
  | 'clipboard.abortImageUpload'

function invalidParams(): never { throw new CatalogReadError('CLIPBOARD_INVALID_PARAMS') }
function captureClipboardCall(method: CatalogClipboardMethod, params: unknown, context: RpcContext) {
  // Transport has authenticated this context. Shape alone is not an auth issuer.
  const fingerprint = context.authenticatedCallerFingerprint
  const clientKind = context.clientKind
  const capabilities = Object.freeze([...(context.clientCapabilities ?? [])])
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new CatalogReadError('CATALOG_AUTHENTICATED_CALLER_REQUIRED')
  }
  const transport = Object.freeze({ principal: fingerprintAttachmentPrincipal(fingerprint), clientKind, capabilities })
  const original = captureCatalogParsed(params === undefined ? {} : params)
  switch (method) {
    case 'clipboard.saveImageAsTempFile': {
      const parsed = SaveImageAsTempFile.safeParse(original)
      if (!parsed.success) { invalidParams() }
      if (parsed.data.connectionId != null) { throw new CatalogReadError('CLIPBOARD_SSH_NOT_CONNECTED') }
      return Object.freeze({ kind: 'save' as const, transport, params: Object.freeze(parsed.data), id: attachmentUploadId(randomUUID()) })
    }
    case 'clipboard.startImageUpload': {
      const parsed = StartImageUpload.safeParse(original)
      if (!parsed.success) { invalidParams() }
      if (parsed.data.connectionId != null) { throw new CatalogReadError('CLIPBOARD_SSH_NOT_CONNECTED') }
      return Object.freeze({ kind: 'start' as const, transport, params: Object.freeze(parsed.data), id: attachmentUploadId(randomUUID()) })
    }
    case 'clipboard.appendImageUploadChunk': {
      const parsed = AppendImageUploadChunk.safeParse(original)
      if (!parsed.success) { invalidParams() }
      return Object.freeze({ kind: 'append' as const, transport, params: Object.freeze(parsed.data), id: attachmentUploadId(parsed.data.uploadId) })
    }
    case 'clipboard.commitImageUpload': {
      const parsed = CommitImageUpload.safeParse(original)
      if (!parsed.success) { invalidParams() }
      return Object.freeze({ kind: 'commit' as const, transport, id: attachmentUploadId(parsed.data.uploadId) })
    }
    case 'clipboard.abortImageUpload': {
      const parsed = AbortImageUpload.safeParse(original)
      if (!parsed.success) { invalidParams() }
      return Object.freeze({ kind: 'abort' as const, transport, id: attachmentUploadId(parsed.data.uploadId) })
    }
    default: throw new CatalogReadError('CATALOG_METHOD_NOT_CONNECTED')
  }
}

/** Independent factory only: startup, previews and physical alias materialization are unconnected. */
export function createCatalogClipboardRpc(config: CapturedCatalogReadConfig, options: { aliasRoot: string }) {
  const pool = config.pool, datasetName = config.datasetName, hostId = config.hostId
  const assertCurrentHost = config.assertCurrentHost.bind(config)
  const connect = pool.connect.bind(pool)
  const aliasRoot = options.aliasRoot
  // Use the original alias validator, without reserving/uploading a row or touching FS.
  reserveAttachmentAlias(aliasRoot, attachmentUploadId('00000000-0000-4000-8000-000000000000'))
  if (typeof datasetName !== 'string' || !datasetName || typeof hostId !== 'string' || !hostId) {
    throw new CatalogReadError('CATALOG_SERVER_CONFIG')
  }
  // Only the captured connect receiver is consumed by withDurableTransaction.
  // This view is not a new Pool and never changes/ends the borrowed owner.
  const capturedPool = new Proxy(pool, { get(target, key, receiver) {
    return key === 'connect' ? connect : Reflect.get(target, key, receiver)
  } })
  assertCurrentHost()

  async function guard(tx: DurableTransaction): Promise<void> {
    assertCurrentHost()
    const rows = (await tx.query<{ dataset_name: string }>(
      'SELECT dataset_name FROM durable_runtime.dataset_metadata FOR SHARE')).rows
    assertCurrentHost()
    if (rows.length !== 1 || rows[0].dataset_name !== datasetName) {
      throw new CatalogReadError('CATALOG_DATASET_MISMATCH')
    }
  }

  return async (method: CatalogClipboardMethod, params: unknown, context: RpcContext): Promise<unknown> => {
    try {
      const call = captureClipboardCall(method, params, context)
      assertCurrentHost()
      const result = await withDurableTransaction(capturedPool, async tx => {
        // Server dataset is the namespace; clipboard has no request Workspace selector.
        await guard(tx)
        const principal = call.transport.principal
        let value: unknown
        switch (call.kind) {
          case 'start':
            await startAttachmentUpload(tx, { id: call.id, principal,
              expectedBase64Length: call.params.expectedBase64Length, targetConnectionId: null })
            value = { uploadId: call.id }
            break
          case 'append':
            value = await appendAttachmentChunk(tx, { id: call.id, principal,
              offset: call.params.offset, contentBase64: call.params.contentBase64 })
            break
          case 'commit': {
            const upload = await readAttachmentUpload(tx, principal, call.id)
            assertCurrentHost()
            if (upload.targetConnectionId !== null) { throw new CatalogReadError('CLIPBOARD_SSH_NOT_CONNECTED') }
            value = (await commitAttachmentUpload(tx, { id: call.id, principal, aliasRoot })).aliasPath
            break
          }
          case 'save':
            value = (await saveAttachmentImage(tx, { id: call.id, principal,
              contentBase64: call.params.contentBase64, aliasRoot, targetConnectionId: null })).aliasPath
            break
          case 'abort':
            await abortAttachmentUpload(tx, principal, call.id)
            value = { aborted: true }
            break
        }
        assertCurrentHost()
        return value
      })
      assertCurrentHost()
      // The outer transaction has observed COMMIT. A logical alias is not a readable file claim.
      return result
    } catch (error) { throw catalogReadFailure(error) }
  }
}
