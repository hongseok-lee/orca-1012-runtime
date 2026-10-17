import type {
  AttemptId, ContextRevision, EventId, ExecutionEpoch, IncidentId, IntentRevision,
  LogicalId, MessageId, MessageRevision, OperationId, ProfileRevision,
  RowRevision, RuntimeUnitId, DeliveryAttemptId, StorageBindingId, StorageEpoch
} from '../../../shared/durable-runtime/identity.ts'
import type { CommandEnvelope, CommandRequest, CommandResult } from './command-types.ts'
import type {
  BodyRef, CheckpointBoundaryProof, CheckpointId, ComputeStoppedProof, EvidenceRef,
  FixedProviderTarget, Incarnation, PayloadHash, PodUid, ProducerSequence, ProviderAdmissionProof,
  ProviderRef, ProviderStoppedProof, RuntimeReference,
  SessionWatermark, SnapshotReadyProof, SnapshotRef, StorageIdentity,
  StorageRevocationProof, StorageSeal, UncertainEffect, VerifiedWorkloadIdentity
} from './runtime-evidence.ts'

export type ResumeMode =
  | { readonly mode: 'COLD'; readonly snapshotRef?: never }
  | { readonly mode: 'RESTORE'; readonly snapshotRef: SnapshotRef }

export type EnsureAttemptRequest = CommandRequest<{
  readonly unitId: RuntimeUnitId
  readonly resourceProfileRevision: ProfileRevision
} & ResumeMode, CommandEnvelope>
export type EnsureAttemptResult = {
  readonly attemptId: AttemptId
  readonly phase: string
} & (
  | { readonly podState: 'NOT_ASSIGNED'; readonly podUid?: never }
  | { readonly podState: 'ASSIGNED'; readonly podUid: PodUid }
)

export interface RuntimeReportEnvelope {
  readonly workloadIdentity: VerifiedWorkloadIdentity
  readonly attemptId: AttemptId
  readonly podUid: PodUid
  readonly incarnation: Incarnation
  readonly executionEpoch: ExecutionEpoch
  readonly producerSeq: ProducerSequence
}
export interface ReportFailureRequest extends RuntimeReportEnvelope {
  readonly incidentIdentity: RuntimeReference<'incident-identity'>
  readonly evidenceRefs: readonly EvidenceRef[]
}
export interface ReportFailureResult {
  readonly incidentId: IncidentId
  readonly classifiedReason: string
  readonly recoveryOperationId?: OperationId
}

export type PlanRecoveryRequest = CommandRequest<{
  readonly incidentId: IncidentId
  readonly expectedIntentRevision: IntentRevision
  readonly policyRevision: RowRevision<'policy'>
}>
export interface PlanRecoveryResult {
  readonly resourceProfileRevision: ProfileRevision
  readonly reservationId?: LogicalId<'resource-reservation'>
  readonly resumeMode: ResumeMode
  readonly decision: string
}

export type FenceAttemptRequest = CommandRequest<{ readonly attemptId: AttemptId }>
export interface FenceAttemptResult {
  readonly phase: string
  readonly computeStoppedProof?: ComputeStoppedProof
  readonly storageRevocationProof?: StorageRevocationProof
}

export interface AllowedBinding {
  readonly storageBindingId: StorageBindingId
  readonly storageIdentity: StorageIdentity
  readonly storageEpoch: StorageEpoch
  readonly access: 'RO' | 'RW'
}
export type BindRequest = CommandRequest<{
  readonly attemptId: AttemptId
  readonly podUid: PodUid
  readonly incarnation: Incarnation
  readonly workloadIdentity: VerifiedWorkloadIdentity
  readonly restoreEvidence: readonly EvidenceRef[]
  readonly challengeResponse: RuntimeReference<'bind-challenge-response'>
}>
export interface BindResult {
  readonly executionEpoch: ExecutionEpoch
  readonly gate: 'CLOSED'
  readonly allowedBindings: readonly AllowedBinding[]
}

export type PrepareCheckpointRequest = CommandRequest<{
  readonly unitId: RuntimeUnitId
  readonly checkpointId: CheckpointId
  readonly targetRevision: RowRevision<'checkpoint-target'>
  readonly captureMode: 'QUIESCENT' | 'FROZEN_TURN'
}>
export type PrepareCheckpointResult = {
  readonly sessionWatermarks: readonly SessionWatermark[]
  readonly storageSeals: readonly StorageSeal[]
  readonly uncertainEffects: readonly UncertainEffect[]
} & (
  | { readonly boundary: 'QUIESCENT'; readonly quiescentProof: CheckpointBoundaryProof; readonly frozenTurnProof?: never }
  | { readonly boundary: 'FROZEN_TURN'; readonly frozenTurnProof: CheckpointBoundaryProof; readonly quiescentProof?: never }
)
export type CheckpointAndStopRequest = CommandRequest<{
  readonly checkpointId: CheckpointId
  readonly manifestDigest: PayloadHash
}>
export interface CheckpointAndStopResult {
  readonly snapshotRef: SnapshotRef
  readonly snapshotReadyProof: SnapshotReadyProof
  readonly stoppedProof: ComputeStoppedProof
}

export type ReleaseGateInput = {
  readonly attemptId: AttemptId
} & ({
  readonly manifestDecisionRevision: RowRevision<'manifest-decision'>
  readonly coldStart?: never
} | {
  readonly coldStart: Readonly<{ kind: 'INITIAL_NEW'; planDigest: string }>
  readonly manifestDecisionRevision?: never
})
export type ReleaseGateRequest = CommandRequest<ReleaseGateInput>
export interface ReleaseGateResult {
  readonly ready: boolean
  readonly providerBindings: readonly ProviderRef[]
}
export interface ObservedResources {
  readonly requests: Readonly<{ cpu: string; memory: string; ephemeralStorage?: string }>
  readonly limits: Readonly<{ cpu?: string; memory?: string; ephemeralStorage?: string }>
  readonly observationRef: EvidenceRef
}
export type ResizeAttemptRequest = CommandRequest<{
  readonly attemptId: AttemptId
  readonly targetProfileRevision: ProfileRevision
}>
export interface ResizeAttemptResult {
  readonly operationId: OperationId
  readonly phase: string
  readonly admittedResources: ObservedResources
  readonly appliedResources?: ObservedResources
  readonly continuityEvidence?: readonly EvidenceRef[]
}

export type StageInputRequest = CommandRequest<{
  readonly messageId: MessageId
  readonly sealedRevision: MessageRevision
  readonly deliveryAttemptId: DeliveryAttemptId
  readonly payloadHash: PayloadHash
  readonly contextRevision: ContextRevision
  readonly bodyRef: BodyRef
}>
export interface StageInputResult { readonly receipt: 'STAGED' }
export type DispatchInputRequest = CommandRequest<{
  readonly messageId: MessageId
  readonly deliveryAttemptId: DeliveryAttemptId
}>
export type DispatchInputResult =
  | { readonly effect: 'PENDING'; readonly providerRef?: ProviderRef }
  | { readonly effect: 'ADMITTED'; readonly providerRef: ProviderRef; readonly admissionProof: ProviderAdmissionProof }
  | { readonly effect: 'UNKNOWN'; readonly providerRef?: ProviderRef; readonly evidenceRefs: readonly EvidenceRef[] }

export type CancelTarget = FixedProviderTarget
export type CancelRequest = CommandRequest<{
  readonly attemptId: AttemptId
  readonly target: CancelTarget
}>
export type CancelResult =
  | { readonly cancelRequested: false; readonly stoppedEvidence?: never; readonly reason: string }
  | { readonly cancelRequested: true; readonly stopped: 'UNCONFIRMED'; readonly stoppedEvidence?: never }
  | { readonly cancelRequested: true; readonly stopped: 'OBSERVED'; readonly stoppedEvidence: ProviderStoppedProof }

export interface RuntimeEvent {
  readonly eventId: EventId
  readonly producerSeq: ProducerSequence
  readonly kind: string
  readonly payload: Readonly<Record<string, unknown>>
}
export interface EventsRequest extends RuntimeReportEnvelope {
  readonly events: readonly RuntimeEvent[]
}
export interface EventsResult {
  readonly durablyCommittedThrough: ProducerSequence
  readonly acknowledgement: 'CONTIGUOUS_PG_ENQUEUE_PREFIX'
}

// Pure internal declarations. No adapter instance, gateway, PG call, provider
// effect, capability advertisement or successful mock response is supplied.
export interface RuntimePort {
  ensureAttempt(request: EnsureAttemptRequest): Promise<CommandResult<EnsureAttemptResult>>
  reportFailure(request: ReportFailureRequest): Promise<ReportFailureResult>
  planRecovery(request: PlanRecoveryRequest): Promise<CommandResult<PlanRecoveryResult>>
  fenceAttempt(request: FenceAttemptRequest): Promise<CommandResult<FenceAttemptResult>>
  bind(request: BindRequest): Promise<CommandResult<BindResult>>
  prepareCheckpoint(request: PrepareCheckpointRequest): Promise<CommandResult<PrepareCheckpointResult>>
  checkpointAndStop(request: CheckpointAndStopRequest): Promise<CommandResult<CheckpointAndStopResult>>
  releaseGate(request: ReleaseGateRequest): Promise<CommandResult<ReleaseGateResult>>
  resizeAttempt(request: ResizeAttemptRequest): Promise<CommandResult<ResizeAttemptResult>>
  stageInput(request: StageInputRequest): Promise<CommandResult<StageInputResult>>
  dispatchInput(request: DispatchInputRequest): Promise<CommandResult<DispatchInputResult>>
  cancel(request: CancelRequest): Promise<CommandResult<CancelResult>>
  events(request: EventsRequest): Promise<EventsResult>
}
