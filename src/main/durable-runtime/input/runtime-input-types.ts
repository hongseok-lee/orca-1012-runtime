import type { ReceiptRecord } from '../db/atomic.ts'
import type { DurableTransaction } from '../db/connection.ts'
import type { InputAuthority } from './types.ts'
import type { SessionFence } from '../../../shared/durable-runtime/identity.ts'
import type { TerminalDraftBinding } from '../terminal/types.ts'
import type { ManagedCatalogTargetPin } from '../terminal/catalog-target.ts'
import type { GatewayContext, ExecutorId } from '../runtime/gateway/types.ts'
import type { ReadyProviderBinding, ProviderDispatchRequest, ProviderDispatchResult } from '../providers/shared/contracts.ts'

/** Issued only after the existing authenticated Terminal owner observes intake COMMIT.
 * A stored principal/receipt alone is not an authenticated intake producer. */
export type CommittedTerminalInput = Readonly<{
  authority: InputAuthority
  binding: TerminalDraftBinding
  targetPin: ManagedCatalogTargetPin
  sessionFence: SessionFence
  receipt: ReceiptRecord
}>
export type TerminalInputCommittedSink = (input: CommittedTerminalInput) => void

/** Borrow the original ready owner; never cold/recreate a driver or mint a controller. */
export type ReadyTerminalInputPort = Readonly<{
  binding: ReadyProviderBinding
  context: GatewayContext
  executorId: ExecutorId
  dispatch(context: GatewayContext, request: ProviderDispatchRequest,
    guard: (tx: DurableTransaction) => Promise<void>): Promise<ProviderDispatchResult>
}>
export type TerminalInputRuntimeHost = Readonly<{
  current(): ReadyTerminalInputPort | null
}>
