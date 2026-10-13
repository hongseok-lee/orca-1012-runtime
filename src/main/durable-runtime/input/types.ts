import type { JsonValue, ReceiptIdentity } from '../db/atomic.ts'
import type { AttachmentPrincipal } from '../attachments/types.ts'
import type {
  SessionId,
  SessionFence,
  MessageId,
  MessageRevision
} from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { MessageInputKind } from '../db/rows.ts'

/** An internal classified input, not a new public wire enum. */
export type InputKind = MessageInputKind
/** Upper adapters authenticate and authorize this scope; its shape is not authentication. */
export type InputAuthority = {
  principal: AttachmentPrincipal
  sessionId: SessionId
  scope: { kind: 'SESSION' } | { kind: 'TERMINAL'; terminalHandle: string }
}
export type InputAttachment = { aliasPath: string; contentHash: string }
export type InputRequest = {
  authority: InputAuthority
  method: string
  operationKey: string
  inputKind: InputKind
  sessionFence: SessionFence
  /** Original credential-free wire JSON, never a merged provider string. */
  payload: JsonValue
  attachments: readonly InputAttachment[]
}
export type PreparedInput = {
  request: InputRequest
  original: JsonValue
  identity: ReceiptIdentity
}
export type SealRequest = {
  authority: InputAuthority
  messageId: MessageId
  expectedRevision: MessageRevision
}
export type SealedInputMessage = {
  messageId: MessageId
  sealedRevision: MessageRevision
  payloadHash: string
  payload: JsonValue
}
export class InputStoreError extends DurableDatabaseError {
  constructor(code: string) {
    super(code)
    this.name = 'InputStoreError'
  }
}
