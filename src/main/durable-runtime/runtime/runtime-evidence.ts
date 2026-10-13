import type {
  AttemptId, DeliveryAttemptId, ExecutionEpoch, LogicalId, MessageId,
  ProducerId, Sequence, SessionId, SnapshotId, StorageBindingId, StorageEpoch
} from '../../../shared/durable-runtime/identity.ts'

// Physical/provider references are not logical UUIDs. No constructor or cast
// turns external strings into verified workload identities or stop proofs here.
declare const referenceBrand: unique symbol
declare const verifiedEvidenceBrand: unique symbol
declare const verifiedWorkloadBrand: unique symbol

export type RuntimeReference<Kind extends string> = string & {
  readonly [referenceBrand]: Kind
}
export type PodUid = RuntimeReference<'pod-uid'>
export type NodeUid = RuntimeReference<'node-uid'>
export type EvidenceRef = RuntimeReference<'evidence-ref'>
export type PayloadHash = RuntimeReference<'sha256'>
export type BodyRef = RuntimeReference<'sealed-body-ref'>
export type ProviderTurnId = RuntimeReference<'provider-turn-id'>
export type Incarnation = RuntimeReference<'workload-incarnation'>
export type ProducerSequence = Sequence<'producer'>
export type CheckpointId = LogicalId<'checkpoint'>

export interface WorkloadExecutionBinding {
  readonly attemptId: AttemptId
  readonly podUid: PodUid
  readonly incarnation: Incarnation
  readonly executionEpoch: ExecutionEpoch
  readonly producerId: ProducerId
}

// A future authentication boundary must supply this brand after verifying the
// actual workload and its binding. Type assertions alone are not authentication.
export interface VerifiedWorkloadIdentity extends WorkloadExecutionBinding {
  readonly [verifiedWorkloadBrand]: true
  readonly principalRef: RuntimeReference<'workload-principal'>
  readonly authenticationEvidenceRef: EvidenceRef
}

export interface VerifiedEvidence {
  readonly [verifiedEvidenceBrand]: true
  readonly evidenceRef: EvidenceRef
  readonly observedAt: string
}

export interface ComputeStoppedProof extends VerifiedEvidence {
  readonly kind: 'COMPUTE_STOPPED'
  readonly attemptId: AttemptId
  readonly podUid: PodUid
  readonly executionEpoch: ExecutionEpoch
  readonly incarnation: Incarnation
  readonly nodeUid: NodeUid
  readonly computeIdentityRef: RuntimeReference<'compute-identity'>
  readonly observationSource: 'COMPUTE_CONTROL_PLANE' | 'TRUSTED_HOST_PROCESS_EXIT'
}

export interface StorageIdentity {
  readonly backendRef: RuntimeReference<'storage-backend'>
  readonly exportRef: RuntimeReference<'storage-export'>
  readonly canonicalDirectoryRef: RuntimeReference<'canonical-directory'>
}

export interface StorageRevocationProof extends VerifiedEvidence {
  readonly kind: 'STORAGE_REVOKED'
  readonly attemptId: AttemptId
  readonly podUid: PodUid
  readonly storageBindingId: StorageBindingId
  readonly storageEpoch: StorageEpoch
  readonly storageIdentity: StorageIdentity
  readonly revokedWriterRef: RuntimeReference<'storage-writer'>
}

export interface SnapshotRef {
  readonly snapshotId: SnapshotId
  readonly manifestDigest: PayloadHash
}

export interface SnapshotReadyProof extends VerifiedEvidence {
  readonly kind: 'SNAPSHOT_READY'
  readonly snapshotRef: SnapshotRef
}

export interface CheckpointBoundaryProof extends VerifiedEvidence {
  readonly checkpointId: CheckpointId
  readonly attemptId: AttemptId
  readonly podUid: PodUid
  readonly executionEpoch: ExecutionEpoch
}

export interface StorageSeal extends VerifiedEvidence {
  readonly storageBindingId: StorageBindingId
  readonly storageEpoch: StorageEpoch
  readonly storageIdentity: StorageIdentity
  readonly sealDigest: PayloadHash
}

export interface ProviderRef {
  readonly provider: 'codex' | 'claude' | 'legacy'
  readonly nativeSessionRef: RuntimeReference<'provider-session'>
  readonly nativeTurnId?: ProviderTurnId
}

export interface ProviderAdmissionProof extends VerifiedEvidence {
  readonly kind: 'PROVIDER_ADMISSION'
  // Either source must correlate the exact message/delivery/execution/provider
  // binding below. PTY writes and uncorrelated transcripts are not evidence.
  readonly source: 'PROVIDER_PROTOCOL' | 'PROVIDER_NATIVE_RECORD'
  readonly attemptId: AttemptId
  readonly podUid: PodUid
  readonly executionEpoch: ExecutionEpoch
  readonly messageId: MessageId
  readonly deliveryAttemptId: DeliveryAttemptId
  readonly providerRef: ProviderRef
}

export type FixedProviderTarget =
  | { readonly targetMessageId: MessageId; readonly targetTurnId?: never }
  | { readonly targetMessageId?: never; readonly targetTurnId: ProviderTurnId }
  | { readonly targetMessageId: MessageId; readonly targetTurnId: ProviderTurnId }

export type ProviderStoppedProof = VerifiedEvidence & FixedProviderTarget & {
  readonly kind: 'PROVIDER_TARGET_STOPPED'
  readonly attemptId: AttemptId
  readonly podUid: PodUid
  readonly executionEpoch: ExecutionEpoch
  readonly providerRef: ProviderRef
}

export interface SessionWatermark {
  readonly sessionId: SessionId
  readonly inputSequence: Sequence<'input'>
  readonly messageSequence: Sequence<'message'>
  readonly journalSequence: Sequence<'journal'>
}

export interface UncertainEffect {
  readonly messageId: MessageId
  readonly deliveryAttemptId: DeliveryAttemptId
  readonly providerRef?: ProviderRef
  readonly evidenceRefs: readonly EvidenceRef[]
}
