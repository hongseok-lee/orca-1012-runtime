import type {
  AttemptId, DeliveryAttemptId, ExecutionEpoch, MessageId, RowRevision,
  RuntimeUnitId, SessionId, TabId
} from '../../../../shared/durable-runtime/identity.ts'
import type { RecoveryContextFrame, VerifiedContextDeliveryProof } from '../../context/types.ts'
import type { SealedInputMessage } from '../../input/types.ts'
import type { CommandClaim } from '../../runtime/gateway/types.ts'
import type {
  PodUid, ProviderAdmissionProof, ProviderRef, ProviderStoppedProof
} from '../../runtime/runtime-evidence.ts'
import type { InputDeliveryObservation, ProviderCompletedProof } from '../../input/observation-types.ts'

export type ProviderBinding = {
  readonly sessionId: SessionId
  readonly tabId: TabId
  readonly terminalHandle: string
  readonly providerBindingRevision: RowRevision<'provider-binding'>
  readonly runtimeUnitId: RuntimeUnitId
  readonly attemptId: AttemptId
  readonly podUid: PodUid
  readonly executionEpoch: ExecutionEpoch
  /** Transport instance, never a logical Session or native Session substitute. */
  readonly connectionInstanceId: string
}
export type ReadyProviderBinding = ProviderBinding & { readonly providerRef: ProviderRef }

export type ProviderColdRequest<Launch> = {
  readonly mode: 'COLD'
  readonly binding: ProviderBinding
  readonly native:
    | { readonly kind: 'NEW'; readonly initialization?:Readonly<{generation:string;previousNativeSessionRef:string|null}> }
    | { readonly kind: 'RESUME'; readonly providerRef: ProviderRef }
  readonly persistentHome: string
  readonly checkout: string
  /** Caller-selected settings; explicit empty values are preserved. */
  readonly launch: Launch
}

export type MaterializedProviderAttachment = {
  readonly inputId: string
  readonly position: string
  readonly aliasPath: string
  readonly contentHash: string
  readonly path: string
}
export type ProviderDispatchRequest = {
  readonly sealed: SealedInputMessage
  readonly deliveryAttemptId: DeliveryAttemptId
  readonly context: RecoveryContextFrame
  readonly attachments: readonly MaterializedProviderAttachment[]
  /** Original ledger lineage only. TRANSACTION_LOCAL is not an effect permit. */
  readonly commandClaim: CommandClaim
}
export type ProviderEffectIdentity = {
  readonly kind: 'COLD' | 'DISPATCH' | 'CANCEL'
  readonly binding: ProviderBinding
  readonly commandClaim: CommandClaim
  /** Exact owned cold request consumed by the callback; private memory only.
   * This may contain launch environment secrets and must never be audited/hashed. */
  readonly coldRequest?: ProviderColdRequest<unknown>
  readonly messageId?: MessageId
  readonly deliveryAttemptId?: DeliveryAttemptId
  readonly sealedRevision?: string
  readonly sealedPayloadHash?: string
  readonly contextRevision?: string
  readonly contextHash?: string
  readonly nativeTurnId?: string
}

/**
 * Upper executor capability: authenticates ownership/writer grant and confirms COMMIT
 * before invoking effect once, outside the transaction. No shape/string/boolean here
 * authenticates a grant. The production input/executor implementation is unconnected.
 */
export type ProviderEffectPermit = {
  invoke<T>(identity: ProviderEffectIdentity, effect: () => Promise<T>): Promise<T>
}

export type ProviderSubmissionIdentity = {
  readonly binding: ReadyProviderBinding
  readonly messageId: MessageId
  readonly deliveryAttemptId: DeliveryAttemptId
  readonly sealedRevision: string
  readonly sealedPayloadHash: string
  readonly contextRevision: string
  readonly contextHash: string
  readonly commandClaim: CommandClaim
  readonly nativeRequestId: string
  /** Hash of the actual serialized submission, including attachment bytes/order. */
  readonly submissionHash: string
}
export type ProviderObservation = {
  readonly source: 'PROVIDER_PROTOCOL'
  readonly identity: ProviderSubmissionIdentity
  readonly observedAt: string
  readonly providerRef?: ProviderRef
  readonly nativeEventId?: string
} & (
  | { readonly kind: 'ADMITTED'; readonly admission: ProviderAdmissionProof;
      readonly contextDelivery: VerifiedContextDeliveryProof }
  | { readonly kind: 'COMPLETED'; readonly completed?: ProviderCompletedProof }
  | { readonly kind: 'TARGET_STOPPED'; readonly stopped: ProviderStoppedProof }
  | { readonly kind: 'UNKNOWN'; readonly reason: 'CONNECTION_LOST' | 'WRITE_OUTCOME_LOST';
      readonly uncertainty?: Extract<InputDeliveryObservation, {kind: 'UNKNOWN'}>['uncertainty'] }
)
/** Append/spool/PG acknowledgement belongs to P112; this callback does not commit PG. */
export type ProviderObservationSink = (observation: ProviderObservation) => void

export type ProviderDispatchResult =
  | { readonly state: 'UNSUPPORTED'; readonly reason: string }
  | { readonly state: 'PENDING'; readonly identity: ProviderSubmissionIdentity }
  | { readonly state: 'UNKNOWN'; readonly identity: ProviderSubmissionIdentity }
  | { readonly state: 'ADMITTED'; readonly identity: ProviderSubmissionIdentity;
      readonly admission: ProviderAdmissionProof; readonly contextDelivery: VerifiedContextDeliveryProof }
export type ProviderCancelTarget = {
  readonly identity: ProviderSubmissionIdentity
  readonly providerRef: ProviderRef
}
export type ProviderCancelResult =
  | { readonly state: 'UNCONFIRMED'; readonly requested: boolean }
  | { readonly state: 'OBSERVED'; readonly requested: boolean; readonly stopped: ProviderStoppedProof }
