import type {
  MessageId,
  DeliveryAttemptId,
  RuntimeUnitId,
  AttemptId,
  ExecutionEpoch
} from '../../../shared/durable-runtime/identity.ts'
import type {
  ProviderAdmissionProof,
  ProviderStoppedProof,
  PodUid,
  VerifiedEvidence,
  EvidenceRef
} from '../runtime/runtime-evidence.ts'

export type FixedInputDelivery = {
  readonly messageId: MessageId
  readonly deliveryAttemptId: DeliveryAttemptId
  readonly runtimeUnitId: RuntimeUnitId
  readonly attemptId: AttemptId
  readonly podUid: PodUid
  readonly executionEpoch: ExecutionEpoch
}
// Actual method-specific provider verification supplies this brand; no factory.
export type ProviderCompletedProof = Omit<ProviderAdmissionProof, 'kind'> & {
  readonly kind: 'PROVIDER_TARGET_COMPLETED'
}
export type InputDeliveryObservation =
  | { readonly kind: 'ADMITTED'; readonly proof: ProviderAdmissionProof }
  | { readonly kind: 'INTERRUPTED'; readonly proof: ProviderStoppedProof }
  | { readonly kind: 'SETTLED'; readonly proof: ProviderCompletedProof }
  | {
      readonly kind: 'UNKNOWN'
      readonly uncertainty: VerifiedEvidence & {
        readonly kind: 'INPUT_EFFECT_UNCERTAIN'
        readonly reasonCode: string
        readonly evidenceRefs: readonly EvidenceRef[]
      }
    }
