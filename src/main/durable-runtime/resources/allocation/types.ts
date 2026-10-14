import type { RuntimeUnitId, OperationId, SessionId } from '../../../../shared/durable-runtime/identity.ts'
import type { JsonValue } from '../../db/atomic.ts'
import type { VerifiedEvidence } from '../../runtime/runtime-evidence.ts'
import type { ControllerAuthority } from '../../lifecycle/types.ts'
import type { ResourcePolicy, ProfileEvidence, CapEvidence, PeakEvidence } from '../policy/types.ts'
import type { AdmissionShape, Demand } from '../policy/admission.ts'
import type { FailureTarget, ClassificationResult } from '../evidence/types.ts'

declare const resourceAuthority: unique symbol
/** An authenticated upper domain must supply this brand and scope binding.
 * No boolean/string-to-authority constructor or production issuer is installed. */
export type ResourceAuthority = {
  readonly [resourceAuthority]: true
  readonly principalId: string
  readonly datasetName: string
  readonly domainIdentity: string
  readonly budgetScope: string
  readonly runtimeUnitId: RuntimeUnitId | null
  readonly evidence: VerifiedEvidence
}
export type ScopeAuthorizer = {
  authorize(authority: ResourceAuthority, action: 'REGISTER' | 'PLAN' | 'RESERVE' | 'READ'): Promise<void>
}
export type Envelope = {
  readonly authority: ResourceAuthority
  readonly controller: ControllerAuthority
  readonly operationKey: string
  readonly authorizer: ScopeAuthorizer
}
export type ResourceFacts = {
  readonly verification: VerifiedEvidence
  readonly target: FailureTarget
  readonly classification: ClassificationResult
  readonly profile: ProfileEvidence
  readonly caps: CapEvidence
  readonly peak: PeakEvidence | null
  readonly declared: AdmissionShape
  readonly admitted: AdmissionShape | null
  readonly old: AdmissionShape | null
  readonly protectedDemand: Demand
  readonly completeAccountingEvidence: VerifiedEvidence
}
export type PrepareResourceRequest = Envelope & {
  readonly kind: 'GROW' | 'REPLACE'
  readonly incidentId: string
  readonly policyRevision: string
  readonly workloadProfileKey: string
  readonly expectedUnitRevision: string
  readonly expectedIntentRevision: string
  readonly expectedApprovedProfileRevision: string
  readonly expectedClassificationRevision: string
  readonly reservationDurationMs: number
  readonly facts: ResourceFacts
}
export type ReserveResourceRequest = Envelope & {
  readonly operationId: OperationId
  readonly expectedUnitRevision: string
  readonly expectedIntentRevision: string
  readonly facts: ResourceFacts
}
export type AllocationResult = {
  readonly authority: 'DATA_ONLY'
  readonly status: 'RESERVED' | 'RESOURCE_WAIT' | 'BLOCKED' | 'DEFERRED' | 'NEEDS_ADMISSION_EVIDENCE' | 'NOT_ELIGIBLE'
  readonly operationId: string | null
  readonly incidentId: string | null
  readonly targetProfileRevision: string | null
  readonly targetMemoryBytes: string | null
  readonly targetCpuMillicores: string | null
  readonly reasons: readonly string[]
  readonly applied: false
  readonly externalCapacityGuaranteed: false
}
export type PolicyRegistration = Envelope & { readonly policy: ResourcePolicy }
export type BudgetRegistration = Envelope & {
  readonly expectedRevision: string | null
  readonly memoryLimitBytes: string
  readonly cpuLimitMillicores: string
  readonly settings: JsonValue
  readonly evidence: VerifiedEvidence
}
export type UnitRegistration = Envelope & {
  readonly approvedProfileRevision: string
  readonly policyRevision: string
  readonly approvedShape: AdmissionShape
  readonly accounted: Demand
  readonly evidence: VerifiedEvidence
  readonly bootstrap: 'NO_EXECUTION_HISTORY' | 'CURRENT_ACCOUNTED'
}
export type LockedContext = {
  readonly unitId: RuntimeUnitId
  readonly members: readonly SessionId[]
  readonly operationId: OperationId
  readonly controller: ControllerAuthority
  readonly budgetScope: string
}
