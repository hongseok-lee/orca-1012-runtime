import type { AttemptId, ExecutionEpoch, RuntimeUnitId } from '../../../../shared/durable-runtime/identity.ts'
import type { Incarnation, PodUid } from '../../runtime/runtime-evidence.ts'

export const FAILURE_CLASSES = [
  'ISOLATED_NODE_MEMORY_EXHAUSTION', 'CONTAINER_LIMIT_OOM',
  'SHARED_NODE_MEMORY_PRESSURE', 'PROCESS_HEAP_LIMIT', 'CHILD_CGROUP_OOM',
  'UNKNOWN_MEMORY_FAILURE', 'OTHER_TERMINATION'
] as const
export type FailureClass = typeof FAILURE_CLASSES[number]
// Physical references and JSON data are observations, never VerifiedEvidence,
// ComputeStoppedProof, a writer grant, or a production authentication factory.
export type EvidenceJson = null | boolean | number | string |
  readonly EvidenceJson[] | { readonly [key: string]: EvidenceJson }
export interface FailureTarget {
  readonly runtimeUnitId: RuntimeUnitId
  readonly attemptId: AttemptId
  readonly podUid: PodUid
  readonly executionEpoch: ExecutionEpoch
  readonly containerName: string | null
  readonly runtimeContainerId: string | null
  readonly incarnation: Incarnation | null
}
export interface EvidenceTime {
  readonly original: string
  readonly epochNanoseconds: string
}
export interface TerminationObservation {
  readonly state: 'CURRENT' | 'LAST' | 'SUPERVISOR'
  readonly containerId: string
  readonly incarnation: string
  readonly processIdentity: string | null
  readonly finishedAt: string
  readonly startedAt: string | null
  readonly exitCode: number | null
  readonly signal: number | null
  readonly reason: string | null
}
export interface CounterTransition {
  readonly cgroupIdentity: string
  readonly processIdentity: string
  readonly incarnation: string
  readonly counter: 'oom' | 'oom_kill' | 'oom_group_kill'
  readonly previous: string
  readonly current: string
  readonly previousSampleId: string
  readonly currentSampleId: string
}
export interface MemorySignals {
  readonly oomKilled: boolean
  readonly memoryEviction: boolean
  readonly nodeOom: boolean
  readonly limitOom: boolean
  readonly heapLimit: boolean
  readonly childOom: boolean
  readonly parentAlive: boolean | null
  readonly otherTermination: boolean
}
export interface PlacementObservation {
  readonly batchId: string
  readonly nodeUid: string
  readonly targetPodUid: string
  readonly complete: boolean
  readonly otherUserPodUids: readonly string[]
  readonly platformPodUids: readonly string[]
  readonly unknownPodUids: readonly string[]
}
export interface ResourceObservation {
  readonly desiredMemoryRequest: string | null
  readonly desiredMemoryLimit: string | null
  readonly admittedMemoryRequest: string | null
  // null means absent; undefined/missing is represented by resources=null.
  readonly admittedMemoryLimit: string | null
  readonly admittedCpuRequest: string | null
  readonly admittedCpuLimit: string | null
}
export interface FailureObservationInput {
  readonly observationId: string
  readonly sourceDedupKey: string
  readonly sourceKind: 'KUBERNETES' | 'CGROUP' | 'SUPERVISOR' | 'UNTRUSTED_TEXT'
  readonly sourceRef: string
  readonly target: FailureTarget
  readonly observedAt: string | Date
  readonly sourceAuthenticated: boolean
  readonly termination: TerminationObservation | null
  readonly counterTransition: CounterTransition | null
  readonly signals: MemorySignals
  readonly resources: ResourceObservation | null
  readonly placement: PlacementObservation | null
  readonly workloadKind: 'AGENT' | 'SERVE' | 'PG' | 'NFS' | 'DEV' | 'TEST' | 'BUILD' | 'UNKNOWN'
  readonly profileVerified: boolean
  readonly defaultLimitlessProfile: boolean
  readonly affectedWorkIds: readonly string[]
  readonly gaps: readonly string[]
  // Only an allowlist projection belongs here. Raw logs, Pod env, credentials,
  // arbitrary stderr and model/chat text must not be retained in this object.
  readonly evidence: EvidenceJson
}
export interface EvidenceAlias {
  readonly kind: 'TERMINATION' | 'COUNTER_TRANSITION'
  readonly key: string
  readonly value: EvidenceJson
}
export interface PreparedFailureObservation {
  readonly schemaVersion: 1
  readonly input: FailureObservationInput & { readonly observedAt: string }
  readonly observedTime: EvidenceTime
  readonly finishedTime: EvidenceTime | null
  readonly payloadDigest: string
  readonly canonicalKey: string | null
  readonly aliases: readonly EvidenceAlias[]
  readonly resolution: 'RESOLVED' | 'TARGET_UNRESOLVED'
  readonly issues: readonly string[]
}
export interface ClassificationResult {
  readonly classification: FailureClass
  readonly reasons: readonly string[]
  readonly missing: readonly string[]
  readonly conflicts: readonly string[]
  readonly observationIds: readonly string[]
  readonly automaticGrowthCandidate: boolean
  readonly authority: 'DATA_ONLY'
}
// Incident owner performs UNIQUE alias ownership checks in PostgreSQL. This
// module never maintains an authoritative in-memory incident registry.
export interface ExistingAliasBinding {
  readonly aliasKey: string
  readonly incidentId: string
}
export interface AliasResolution {
  readonly incidentId: string | null
  readonly conflicts: readonly string[]
  readonly aliases: readonly EvidenceAlias[]
}
