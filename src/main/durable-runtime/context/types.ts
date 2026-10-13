import type { JsonValue } from '../db/atomic.ts'
import type {
  SessionId,
  ContextRevision,
  RowRevision,
  RuntimeUnitId,
  AttemptId,
  ExecutionEpoch
} from '../../../shared/durable-runtime/identity.ts'
import type { VerifiedEvidence, PodUid, ProviderRef } from '../runtime/runtime-evidence.ts'

/** Immutable facts, not a replay command or provider prompt/continuation policy. */
export type RecoveryContextFrame = {
  readonly version: 1
  readonly sessionId: SessionId
  readonly revision: ContextRevision
  readonly payload: JsonValue
  readonly hash: string
}
/** Supplied by actual method-specific verification; no string/boolean factory exists here. */
export type VerifiedContextDeliveryProof = VerifiedEvidence & {
  readonly kind: 'PROVIDER_CONTEXT_DELIVERY'
  readonly source: 'PROVIDER_PROTOCOL' | 'PROVIDER_NATIVE_RECORD'
  readonly sessionId: SessionId
  readonly contextRevision: ContextRevision
  readonly contextHash: string
  readonly providerBindingRevision: RowRevision<'provider-binding'>
  readonly runtimeUnitId: RuntimeUnitId
  readonly attemptId: AttemptId
  readonly podUid: PodUid
  readonly executionEpoch: ExecutionEpoch
  readonly providerRef: ProviderRef
}
