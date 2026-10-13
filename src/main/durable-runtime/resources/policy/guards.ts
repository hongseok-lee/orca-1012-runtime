import type { FailureTarget } from '../evidence/types.ts'
import type { CapEvidence, PeakEvidence, PolicyDecision, ProfileEvidence, ResourcePolicy } from './types.ts'
import { integer, min, positive, text, time, validatePolicy } from './arithmetic.ts'

export function sameTarget(a: FailureTarget, b: FailureTarget): boolean {
  return a.runtimeUnitId === b.runtimeUnitId && a.attemptId === b.attemptId &&
    a.podUid === b.podUid && a.executionEpoch === b.executionEpoch &&
    a.containerName === b.containerName && a.runtimeContainerId === b.runtimeContainerId &&
    a.incarnation === b.incarnation
}
export function resolvedTarget(target: FailureTarget): boolean {
  return [target.runtimeUnitId, target.attemptId, target.podUid, target.containerName,
    target.runtimeContainerId, target.incarnation].every(v => typeof v === 'string' && v.length > 0) &&
    target.executionEpoch !== null && target.executionEpoch !== undefined
}
export function decision(policy: ResourcePolicy, kind: PolicyDecision['kind'], reasons: readonly string[],
  memory: string | null = null, refs: readonly string[] = [], windowId: string | null = null): PolicyDecision {
  return Object.freeze({ authority: 'DATA_ONLY', policyRevision: text(policy.revision), kind,
    targetMemoryBytes: memory, reasons: Object.freeze([...reasons]),
    sourceRefs: Object.freeze([...refs]), windowId })
}
export function profileKnown(policy: ResourcePolicy, target: FailureTarget,
  p: ProfileEvidence | null, caps: CapEvidence | null): boolean {
  validatePolicy(policy)
  if (!p || !caps || !p.verified || !caps.verified || !resolvedTarget(target) ||
    !sameTarget(p.target, target) || !p.sourceRef || !p.profileId || !p.profileRevision ||
    !p.ratio.sourceRef || !caps.sourceRef) { return false }
  const memory = positive(p.memoryBytes)
  const cpu = positive(p.cpuMillicores)
  const minimum = positive(p.minimumMemoryBytes)
  const ratioMin = integer(p.ratio.minBytesPerMillicore)
  const ratioMax = positive(p.ratio.maxBytesPerMillicore)
  if (ratioMin > ratioMax || memory < minimum || cpu < positive(p.minimumCpuMillicores) ||
    memory < cpu * ratioMin || memory > cpu * ratioMax ||
    !p.memoryLimitOmitted || !p.cpuLimitOmitted || !p.spot || !p.isolated) { return false }
  positive(p.coldStartMemoryBytes)
  for (const cap of [caps.policyBytes, caps.unitBudgetBytes, caps.quotaBytes,
    caps.ratioBytes, caps.reservationBytes]) { integer(cap) }
  for (const endpoint of caps.admittedEndpoints) { positive(endpoint) }
  return true
}
export function effectiveCap(policy: ResourcePolicy, caps: CapEvidence): bigint {
  return min(positive(policy.capBytes), integer(caps.policyBytes), integer(caps.unitBudgetBytes),
    integer(caps.quotaBytes), integer(caps.ratioBytes), integer(caps.reservationBytes))
}
export function capEndpointKnown(value: bigint, minimum: string, caps: CapEvidence,
  policy: ResourcePolicy): boolean {
  const step = value >= positive(policy.roundingThresholdBytes)
    ? positive(policy.largeStepBytes) : positive(policy.smallStepBytes)
  return value === positive(minimum) || value % step === 0n ||
    caps.admittedEndpoints.some(n => positive(n) === value)
}
export function usablePeak(peak: PeakEvidence, target: FailureTarget, revision: string,
  now: number, policy: ResourcePolicy): boolean {
  integer(peak.bytes); time(peak.startMs); time(peak.endMs); time(now)
  return sameTarget(peak.target, target) && peak.verified && !peak.cumulative &&
    peak.profileRevision === revision && !!peak.sourceRef && !!peak.windowId &&
    ['WORKING_SET', 'RSS'].includes(peak.metric) && peak.endMs > peak.startMs &&
    peak.endMs <= now && peak.startMs >= now - policy.rollingMs
}
export function capacityDecision(policy: ResourcePolicy, caps: CapEvidence): PolicyDecision | null {
  if (caps.capacityAvailable === null || caps.singleWriterBudgetAvailable === null) {
    return decision(policy, 'NEEDS_ADMISSION_EVIDENCE', ['CAPACITY_OR_SINGLE_WRITER_UNOBSERVED'])
  }
  if (!caps.singleWriterBudgetAvailable) {
    return decision(policy, 'BLOCKED', ['SINGLE_WRITER_OR_TOTAL_BUDGET'])
  }
  if (!caps.capacityAvailable) { return decision(policy, 'RESOURCE_WAIT', ['CAPACITY_UNAVAILABLE']) }
  return null
}
