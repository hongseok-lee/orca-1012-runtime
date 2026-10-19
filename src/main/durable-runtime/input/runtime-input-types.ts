import type { AgentTerminalControl } from '../runtime/agent-terminal-protocol.ts'
import type { ReceiptRecord } from '../db/atomic.ts'
import type { DurableTransaction } from '../db/connection.ts'
import type { InputAuthority } from './types.ts'
import type { SessionFence } from '../../../shared/durable-runtime/identity.ts'
import type { TerminalDraftBinding } from '../terminal/types.ts'
import type { ManagedCatalogTargetPin } from '../terminal/catalog-target.ts'
import type { GatewayContext, ExecutorId, CommandClaim } from '../runtime/gateway/types.ts'
import type { ReadyProviderBinding, ProviderDispatchRequest, ProviderDispatchResult, ProviderCancelTarget, ProviderCancelResult } from '../providers/shared/contracts.ts'

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
  terminal?: AgentTerminalControl['terminal']
  context: GatewayContext
  executorId: ExecutorId
  cancelTarget?(deliveryAttemptId: string, nativeTurnId: string): ProviderCancelTarget | null
  cancel?(context: GatewayContext, target: ProviderCancelTarget, claim: CommandClaim,
    guard: (tx: DurableTransaction) => Promise<void>): Promise<ProviderCancelResult>
  dispatch(context: GatewayContext, request: ProviderDispatchRequest,
    guard: (tx: DurableTransaction) => Promise<void>): Promise<ProviderDispatchResult>
}>
export type TerminalInputRuntimeHost = Readonly<{
  current(): ReadyTerminalInputPort | null
}>

/** Routing only: callers still authenticate the target and validate current PG execution. */
export type TerminalRuntimeLookup = (sessionId: string) => ReadyTerminalInputPort | null
