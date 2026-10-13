import type {
  ControllerTerm, ExecutionEpoch, IntentRevision, OperationId, StepRevision
} from '../../../shared/durable-runtime/identity.ts'
import type { PayloadHash, PodUid } from './runtime-evidence.ts'

export interface CommandAuthority {
  readonly operationId: OperationId
  readonly controllerTerm: ControllerTerm
  readonly stepRevision: StepRevision
  readonly executionEpoch: ExecutionEpoch
  readonly intentRevision: IntentRevision
}

export type CommandEnvelope = CommandAuthority & (
  | { readonly podTarget: 'CREATE_WITHOUT_POD'; readonly expectedPodUid: null }
  | { readonly podTarget: 'EXISTING_POD'; readonly expectedPodUid: PodUid }
)
export type ExistingPodEnvelope = Extract<CommandEnvelope, { podTarget: 'EXISTING_POD' }>

export type RuntimeCommandName =
  | 'ensureAttempt' | 'planRecovery' | 'fenceAttempt' | 'bind'
  | 'prepareCheckpoint' | 'checkpointAndStop' | 'releaseGate'
  | 'resizeAttempt' | 'stageInput' | 'dispatchInput' | 'cancel'

// The original identity/hash survives takeover by a new controller term.
export interface ExternalCommandIdentity {
  readonly command: RuntimeCommandName
  readonly originalEnvelope: CommandEnvelope
  readonly inputHash: PayloadHash
}

export interface UnresolvedCommandReceipt {
  readonly identity: ExternalCommandIdentity
  readonly state: 'ACCEPTED_UNRESOLVED' | 'UNKNOWN'
}

export type SettledCommandReceipt<Result> =
  | { readonly identity: ExternalCommandIdentity; readonly state: 'RESOLVED'; readonly result: Result }
  | { readonly identity: ExternalCommandIdentity; readonly state: 'REFUSED'; readonly reason: string }

export type CommandRequest<Input, Envelope extends CommandEnvelope = ExistingPodEnvelope> = {
  readonly envelope: Envelope
} & (
  | {
      readonly receiptAction: 'SUBMIT'
      readonly inputHash: PayloadHash
      readonly input: Input
      // An opposite command may only cite a reconciled predecessor. The actual
      // PG/gateway serialization still has to enforce this; declarations do not.
      readonly predecessor: { readonly kind: 'NONE' } | {
        readonly kind: 'RECONCILED'; readonly receipt: SettledCommandReceipt<unknown>
      }
    }
  | {
      readonly receiptAction: 'LOOKUP' | 'TAKE_OVER'
      readonly original: ExternalCommandIdentity
    }
)

export type CommandResult<Result> =
  | { readonly disposition: 'RESOLVED'; readonly receipt: Extract<SettledCommandReceipt<Result>, { state: 'RESOLVED' }> }
  | { readonly disposition: 'REFUSED'; readonly receipt: Extract<SettledCommandReceipt<Result>, { state: 'REFUSED' }> }
  | { readonly disposition: 'UNRESOLVED'; readonly receipt: UnresolvedCommandReceipt }
  | {
      readonly disposition: 'BLOCKED_BY_UNRESOLVED_COMMAND'
      readonly blockingReceipt: UnresolvedCommandReceipt
      readonly newCommandAccepted: false
    }
