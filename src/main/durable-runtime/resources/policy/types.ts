import type { ClassificationResult, FailureTarget } from '../evidence/types.ts'

// Decimal strings carry bytes/counters; CPU is explicitly integer millicores.
// `verified` fields are supplied by a trusted caller, never an auth factory.
export type Decimal = string
export type ResourcePolicy = {
  readonly revision: string
  readonly capBytes: Decimal
  readonly growth: readonly [Decimal, Decimal]
  readonly growthPeak: readonly [Decimal, Decimal]
  readonly downsize: readonly [Decimal, Decimal]
  readonly downsizePeak: readonly [Decimal, Decimal]
  readonly lowWatermark: readonly [Decimal, Decimal]
  readonly roundingThresholdBytes: Decimal
  readonly largeStepBytes: Decimal
  readonly smallStepBytes: Decimal
  readonly replacementExtra: Decimal
  readonly rollingMs: number
  readonly oomHoldMs: number
  readonly episodeActiveMs: number
  readonly downsizeActiveMs: number
  readonly downsizeIntervalMs: number
  readonly failureHoldMs: number
  readonly sampleIntervalMs: number
  readonly maxGapMs: number
  readonly coveragePercent: Decimal
  readonly rollbackPerOperation: Decimal
  readonly memoryMetric: 'WORKING_SET' | 'RSS'
}
export type ProfileEvidence = {
  readonly profileId: string
  readonly profileRevision: string
  readonly sourceRef: string
  readonly verified: boolean
  readonly target: FailureTarget
  readonly memoryBytes: Decimal
  readonly cpuMillicores: Decimal
  readonly minimumMemoryBytes: Decimal
  readonly minimumCpuMillicores: Decimal
  readonly coldStartMemoryBytes: Decimal
  readonly memoryLimitOmitted: boolean
  readonly cpuLimitOmitted: boolean
  readonly spot: boolean
  readonly isolated: boolean
  readonly ratio: {
    readonly sourceRef: string
    readonly minBytesPerMillicore: Decimal
    readonly maxBytesPerMillicore: Decimal
  }
}
export type CapEvidence = {
  readonly verified: boolean
  readonly sourceRef: string
  readonly policyBytes: Decimal
  readonly unitBudgetBytes: Decimal
  readonly quotaBytes: Decimal
  readonly ratioBytes: Decimal
  readonly reservationBytes: Decimal
  // A non-grid endpoint must have a specifically verified admissible profile.
  readonly admittedEndpoints: readonly Decimal[]
  readonly capacityAvailable: boolean | null
  readonly singleWriterBudgetAvailable: boolean | null
}
export type PeakEvidence = {
  readonly target: FailureTarget
  readonly profileRevision: string
  readonly bytes: Decimal
  readonly metric: 'WORKING_SET' | 'RSS'
  readonly sourceRef: string
  readonly verified: boolean
  readonly cumulative: boolean
  readonly windowId: string
  readonly startMs: number
  readonly endMs: number
}
export type BudgetFacts = {
  readonly runtimeUnitId: string
  readonly sourceRef: string
  readonly dbNowMs: number
  readonly rollingStartMs: number
  readonly episodeGrowth: Decimal
  readonly rollingGrowth: Decimal
  readonly episodeReplacements: Decimal
}
export type PolicyDecision = {
  readonly authority: 'DATA_ONLY'
  readonly policyRevision: string
  readonly kind: 'GROW_CANDIDATE' | 'DOWNSIZE_CANDIDATE' | 'ROLLBACK_CANDIDATE' |
    'PROFILE_CANDIDATE' | 'NEEDS_ADMISSION_EVIDENCE' | 'RESOURCE_WAIT' |
    'BLOCKED' | 'DEFERRED' | 'NOT_ELIGIBLE'
  readonly targetMemoryBytes: Decimal | null
  readonly reasons: readonly string[]
  readonly sourceRefs: readonly string[]
  readonly windowId: string | null
}
export type GrowthInput = {
  readonly policy: ResourcePolicy
  readonly target: FailureTarget
  readonly classification: ClassificationResult
  readonly classificationTarget: FailureTarget
  readonly currentAgent: boolean
  readonly profile: ProfileEvidence | null
  readonly caps: CapEvidence | null
  readonly peak: PeakEvidence | null
  readonly budget: BudgetFacts
  readonly priorResourceWait: boolean
}
export type ActiveInterval = {
  readonly startMs: number
  readonly endMs: number
  readonly target: FailureTarget
  readonly active: boolean
  readonly profileRevision: string
  readonly sourceRef: string
  readonly verified: boolean
  readonly expectedSamples: Decimal
  readonly observedSamples: Decimal
  readonly maxGapMs: number
  readonly peak: PeakEvidence | null
}
export type ActivityWindow = {
  readonly id: string
  readonly sourceRef: string
  readonly workloadProfileId: string
  readonly used: boolean
  readonly intervals: readonly ActiveInterval[]
}
export type DownsizeInput = {
  readonly policy: ResourcePolicy
  readonly target: FailureTarget
  readonly profile: ProfileEvidence | null
  readonly caps: CapEvidence | null
  readonly window: ActivityWindow
  readonly dbNowMs: number
  readonly lastOomMs: number | null
  readonly lastDownsizeMs: number | null
  readonly lastFailureMs: number | null
  readonly unresolvedRecovery: boolean
  readonly pendingInput: boolean
  readonly activeTurn: boolean
  readonly activeTool: boolean
  readonly backgroundWriter: boolean
  readonly safeBoundary: boolean
  readonly rollbackCapacityReserved: boolean | null
}
