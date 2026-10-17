import type { InputAttachment, InputAuthority } from '../input/types.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { SessionFence } from '../../../shared/durable-runtime/identity.ts'
import type { TerminalDraftBinding, TerminalIngressScope, TerminalIngressSnapshot } from './types'
import type { ManagedCatalogTargetPin } from './catalog-target.ts'

export class TerminalDraftStoreError extends DurableDatabaseError {
  constructor(code: string) {
    super(code)
    this.name = 'TerminalDraftStoreError'
  }
}

/** Domain pin, not a copied DB row or an issued grant. */
export type TerminalFloorPin = Readonly<{
  binding: TerminalDraftBinding
  revision: string
}>
export type TerminalDraftAttachment = Readonly<InputAttachment & { attachmentId: string }>
export type TerminalIngressOrigin = Readonly<
  | { kind: 'UNARY'; authenticatedConnectionIncarnation: string; rpcRequestId: string }
  | { kind: 'INGRESS'; authenticatedConnectionIncarnation: string; ingressIdentity: string }
>

/** Supplied by the existing authenticated server boundary. No factory is provided here. */
export type ManagedTerminalAuthorization = {
  assertAuthenticatedOrigin(scope: TerminalIngressScope, origin: TerminalIngressOrigin): void
}
export type TerminalFloorAuthorization = {
  assertClaimAllowed(next: TerminalDraftBinding, previous: TerminalFloorPin | null): void
  /** Also proves this new connection is authenticated and the old one can no longer input. */
  assertReattachAllowed(previous: TerminalFloorPin, nextConnectionId: string): void
}
export type ManagedTerminalIngressRequest = Readonly<{
  snapshot: TerminalIngressSnapshot
  origin: TerminalIngressOrigin
  authority: InputAuthority
  sessionFence: SessionFence
  expectedFloorRevision: string
  attachments: readonly TerminalDraftAttachment[]
  authorization: ManagedTerminalAuthorization
  /** Optional public Catalog fence; existing internal callers keep their floor contract. */
  catalogTargetPin?: ManagedCatalogTargetPin
}>

export function terminalCounter(value: unknown): string {
  const text = typeof value === 'bigint' ? value.toString() : value
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new TerminalDraftStoreError('TERMINAL_COUNTER')
  }
  return text
}
export function nextTerminalCounter(value: string): string {
  return (BigInt(terminalCounter(value)) + 1n).toString()
}

export function assertSynchronousTerminalAuthorization(value: unknown): void {
  if (value !== undefined) {
    throw new TerminalDraftStoreError('TERMINAL_ASYNC_AUTHORIZATION')
  }
}
