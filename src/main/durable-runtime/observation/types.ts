import type {
  AttemptId, ExecutionEpoch, LogicalId, OperationId, RowRevision, RuntimeUnitId, Sequence
} from '../../../shared/durable-runtime/identity.ts'
import type { JsonValue, ReceiptIdentity } from '../db/atomic.ts'
import type { ProducerStream } from '../events/types.ts'
import type { PodUid, VerifiedWorkloadIdentity } from '../runtime/runtime-evidence.ts'

declare const authorityBrand: unique symbol
declare const preparedResponseBrand: unique symbol
declare const pinOwnerBrand: unique symbol

// These are internal request/transport contracts, not copies of DB016 rows.
export type ObservationEpisodeId = LogicalId<'observation-episode'>
export type ObservationTarget = {
  readonly runtimeUnitId: RuntimeUnitId
  readonly attemptId: AttemptId
  readonly podUid: PodUid
  readonly executionEpoch: ExecutionEpoch
}
export type ObservationAuthority = {
  readonly principalId: string
  readonly scope: string
  readonly [authorityBrand]: true
}
export type ObservationSource = {
  readonly kind: 'K8S_LIST' | 'K8S_WATCH' | 'TRUSTED_RUNTIME'
  readonly reference: string
  readonly stream: ProducerStream | null
  readonly watermark: Sequence<'observation'> | null
}
export type ObservationLossRequest = {
  readonly authority: ObservationAuthority
  readonly operationKey: string
  readonly target: ObservationTarget
  readonly source: ObservationSource
}

// Only an authenticated runtime transport owning the current request may
// supply this immutable prepared response. No production issuer/factory exists
// here; raw HTTP/K8s/spool/text/verified=true cannot be promoted by this module.
export type PreparedFreshObservation = {
  readonly [preparedResponseBrand]: true
  readonly target: ObservationTarget
  readonly workload: VerifiedWorkloadIdentity
  readonly episodeId: ObservationEpisodeId
  readonly expectedEpisodeRevision: RowRevision<'observation-episode'>
  readonly challengeId: string
  readonly requestSourceRef: string
  readonly responseSourceRef: string
  readonly state: 'RUNNING' | 'IDLE' | 'WAITING_INPUT'
  readonly observedAt: Date
  readonly stream: ProducerStream | null
  readonly watermark: Sequence<'observation'> | null
  readonly body: JsonValue
}
export type CurrentObservationPin = {
  readonly [pinOwnerBrand]: true
  // Synchronous lookup in the trusted owner's current registry, not an I/O call.
  isCurrent(response: PreparedFreshObservation, frozenPayloadHash: string): boolean
}
export type ObservationRecoveryRequest = {
  readonly authority: ObservationAuthority
  readonly operationKey: string
  readonly prepared: PreparedFreshObservation
  readonly pin: CurrentObservationPin
}
export type RecoverySnapshot = {
  readonly target: ObservationTarget
  readonly workload: Readonly<Pick<VerifiedWorkloadIdentity,
    'attemptId' | 'podUid' | 'executionEpoch' | 'incarnation' | 'producerId' | 'principalRef' | 'authenticationEvidenceRef'>>
  readonly episodeId: ObservationEpisodeId
  readonly expectedEpisodeRevision: RowRevision<'observation-episode'>
  readonly challengeId: string
  readonly requestSourceRef: string
  readonly responseSourceRef: string
  readonly state: PreparedFreshObservation['state']
  readonly observedAtISO: string
  readonly stream: ProducerStream | null
  readonly watermark: Sequence<'observation'> | null
  readonly body: JsonValue
}
export type PreparedRecoveryRequest = {
  readonly authority: Pick<ObservationAuthority, 'principalId' | 'scope'>
  readonly operationKey: string
  readonly value: RecoverySnapshot
  readonly identity: ReceiptIdentity
  // The accepting transaction must call this after SQL binding checks and
  // immediately before the accepting UPDATE. It is not a prepared proof factory.
  readonly assertCurrentPin: () => void
}

export type EpisodeMutationRequest = {
  readonly authority: ObservationAuthority
  readonly operationKey: string
  readonly target: ObservationTarget
  readonly episodeId: ObservationEpisodeId
  readonly expectedEpisodeRevision: RowRevision<'observation-episode'>
}
export type IssueObservationChallengeRequest = EpisodeMutationRequest & {
  readonly challengeId: string
  readonly requestSourceRef: string
  readonly expectedStream: ProducerStream | null
  readonly expectedWatermark: Sequence<'observation'> | null
  readonly supersedeChallengeId: string | null
}
export type ReserveObservationFenceRequest = EpisodeMutationRequest & {
  readonly policy: {
    readonly revisionRef: string
    readonly operationDeadlineMs: number
  }
}
export type ObservationFenceBlockedRequest = EpisodeMutationRequest & {
  readonly fenceOperationId: OperationId
  readonly reason: string
  readonly failureSourceRef: string
}
