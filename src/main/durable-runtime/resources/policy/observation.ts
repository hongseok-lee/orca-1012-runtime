import type { FailureTarget } from '../evidence/types.ts'
import type { ActivityWindow, ResourcePolicy } from './types.ts'
import { integer, max, positive, text, time, validatePolicy } from './arithmetic.ts'
import { resolvedTarget, usablePeak } from './guards.ts'

export type WindowResult = {
  readonly authority: 'DATA_ONLY'
  readonly windowId: string
  readonly sourceRef: string
  readonly activeMs: number
  readonly peakBytes: string | null
  readonly reasons: readonly string[]
}

export function inspectActivityWindow(policy: ResourcePolicy, window: ActivityWindow,
  target: FailureTarget, profileId: string, profileRevision: string, now: number,
  requireMetrics = true): WindowResult {
  validatePolicy(policy); text(window.id); text(window.sourceRef); time(now)
  const reasons: string[] = []
  if (window.used) { reasons.push('WINDOW_ALREADY_USED') }
  if (window.workloadProfileId !== profileId) { reasons.push('WORKLOAD_PROFILE_CHANGED') }
  const intervals = [...window.intervals].sort((a, b) => a.startMs - b.startMs)
  let active = 0
  let peak: bigint | null = null
  let previousEnd = -1
  if (intervals.length === 0) { reasons.push('ACTIVITY_UNOBSERVED') }
  for (const interval of intervals) {
    time(interval.startMs); time(interval.endMs); time(interval.maxGapMs)
    if (interval.startMs < now - policy.rollingMs || interval.endMs > now ||
      interval.endMs <= interval.startMs) { reasons.push('WINDOW_STALE_OR_INVALID') }
    if (interval.startMs < previousEnd) { reasons.push('OVERLAPPING_ACTIVITY') }
    previousEnd = Math.max(previousEnd, interval.endMs)
    // Multiple activations are permitted; each metric must match its own exact
    // container execution, with a common Runtime Unit/workload profile.
    if (!interval.active || !interval.verified || !interval.sourceRef ||
      !resolvedTarget(interval.target) || interval.target.runtimeUnitId !== target.runtimeUnitId ||
      interval.target.containerName !== target.containerName || interval.profileRevision !== profileRevision) {
      reasons.push('ACTIVITY_IDENTITY_OR_PROVENANCE_UNKNOWN')
    }
    const duration = interval.endMs - interval.startMs
    if (duration > 0) { active += duration }
    if (!Number.isSafeInteger(active)) { throw new RangeError('Activity duration overflow') }
    if (requireMetrics) {
      const expected = positive(interval.expectedSamples)
      const observed = integer(interval.observedSamples)
      const required = (BigInt(Math.max(0, duration)) + BigInt(policy.sampleIntervalMs) - 1n) /
        BigInt(policy.sampleIntervalMs)
      if (expected !== required || observed > expected ||
        observed * 100n < expected * positive(policy.coveragePercent)) { reasons.push('METRIC_COVERAGE_GAP') }
      if (interval.maxGapMs > policy.maxGapMs) { reasons.push('METRIC_GAP_TOO_LARGE') }
      const p = interval.peak
      if (p === null || !usablePeak(p, interval.target, profileRevision, now, policy) ||
        p.windowId !== window.id || p.startMs !== interval.startMs || p.endMs !== interval.endMs) {
        reasons.push('WINDOW_PEAK_UNOBSERVED_OR_STALE')
      } else { peak = peak === null ? integer(p.bytes) : max(peak, integer(p.bytes)) }
    }
  }
  return Object.freeze({ authority: 'DATA_ONLY', windowId: window.id, sourceRef: window.sourceRef,
    activeMs: reasons.length === 0 ? active : 0, peakBytes: reasons.length === 0 && peak !== null ? peak.toString() : null,
    reasons: Object.freeze([...new Set(reasons)]) })
}

export function episodeStability(policy: ResourcePolicy, window: ActivityWindow, target: FailureTarget,
  profileId: string, revision: string, now: number, affectedWorkResolved: boolean,
  oomFreeSinceMs: number): { readonly authority: 'DATA_ONLY'; readonly stable: boolean; readonly reasons: readonly string[] } {
  time(oomFreeSinceMs)
  const observed = inspectActivityWindow(policy, window, target, profileId, revision, now, false)
  const reasons = [...observed.reasons]
  if (!affectedWorkResolved) { reasons.push('AFFECTED_WORK_UNRESOLVED') }
  if (oomFreeSinceMs > now || window.intervals.some(i => i.startMs < oomFreeSinceMs)) {
    reasons.push('OOM_DURING_ACTIVITY_OR_UNKNOWN')
  }
  if (observed.activeMs < policy.episodeActiveMs) { reasons.push('ACTIVE_STABILITY_INSUFFICIENT') }
  return Object.freeze({ authority: 'DATA_ONLY', stable: reasons.length === 0, reasons: Object.freeze(reasons) })
}

export function circuitRelease(previousPolicyRevision: string, policy: ResourcePolicy,
  explicitRecoveryDecisionRef: string | null): { readonly authority: 'DATA_ONLY'; readonly releasable: boolean } {
  text(previousPolicyRevision); validatePolicy(policy)
  if (explicitRecoveryDecisionRef !== null) { text(explicitRecoveryDecisionRef) }
  return Object.freeze({ authority: 'DATA_ONLY',
    releasable: policy.revision !== previousPolicyRevision || explicitRecoveryDecisionRef !== null })
}
