import type { DownsizeInput, PolicyDecision } from './types.ts'
import { ceilRatio, integer, max, positive, roundUpMemory, time } from './arithmetic.ts'
import { capacityDecision, decision, effectiveCap, profileKnown } from './guards.ts'
import { inspectActivityWindow } from './observation.ts'

export function evaluateDownsize(input: DownsizeInput): PolicyDecision {
  const { policy, target, profile, caps, window, dbNowMs } = input
  time(dbNowMs)
  if (!profileKnown(policy, target, profile, caps) || !profile || !caps) {
    return decision(policy, 'NEEDS_ADMISSION_EVIDENCE', ['PROFILE_MINIMUM_CONFIG_OR_PROVENANCE_UNKNOWN'])
  }
  const reasons: string[] = []
  for (const [at, hold, reason] of [
    [input.lastOomMs, policy.oomHoldMs, 'OOM_HOLD'],
    [input.lastDownsizeMs, policy.downsizeIntervalMs, 'DOWNSIZE_INTERVAL'],
    [input.lastFailureMs, policy.failureHoldMs, 'DOWNSIZE_FAILURE_HOLD']
  ] as const) {
    if (at !== null && (time(at) > dbNowMs || dbNowMs - at < hold)) { reasons.push(reason) }
  }
  if (input.unresolvedRecovery) { reasons.push('RECOVERY_UNRESOLVED') }
  if (input.pendingInput || input.activeTurn || input.activeTool || input.backgroundWriter || !input.safeBoundary) {
    reasons.push('PENDING_WORK_OR_UNSAFE_BOUNDARY')
  }
  const observed = inspectActivityWindow(policy, window, target,
    profile.profileId, profile.profileRevision, dbNowMs)
  reasons.push(...observed.reasons)
  if (observed.activeMs < policy.downsizeActiveMs) { reasons.push('ACTIVE_TIME_INSUFFICIENT') }
  if (window.intervals.some(i => input.lastDownsizeMs !== null && i.startMs <= input.lastDownsizeMs)) {
    reasons.push('WINDOW_NOT_FRESH_AFTER_DOWNSIZE')
  }
  const current = positive(profile.memoryBytes)
  if (observed.peakBytes !== null && integer(observed.peakBytes) * positive(policy.lowWatermark[1]) >
    current * positive(policy.lowWatermark[0])) { reasons.push('PEAK_NOT_LOW') }
  if (reasons.length > 0) { return decision(policy, 'DEFERRED', reasons, null, [window.sourceRef], window.id) }
  if (observed.peakBytes === null || input.rollbackCapacityReserved === null) {
    return decision(policy, 'NEEDS_ADMISSION_EVIDENCE', ['PEAK_OR_ROLLBACK_RESERVATION_UNKNOWN'])
  }
  if (!input.rollbackCapacityReserved) { return decision(policy, 'RESOURCE_WAIT', ['ROLLBACK_HEADROOM_UNAVAILABLE']) }
  const capacity = capacityDecision(policy, caps)
  if (capacity) { return capacity }
  // Reducing the cap must never silently downsize an existing approved profile.
  if (current > effectiveCap(policy, caps)) { return decision(policy, 'BLOCKED', ['CURRENT_PROFILE_EXCEEDS_CAP']) }
  const floor = max(ceilRatio(current, positive(policy.downsize[0]), positive(policy.downsize[1])),
    ceilRatio(integer(observed.peakBytes), positive(policy.downsizePeak[0]), positive(policy.downsizePeak[1])),
    positive(profile.coldStartMemoryBytes), positive(profile.minimumMemoryBytes))
  const memory = integer(roundUpMemory(floor.toString(), profile.minimumMemoryBytes, policy))
  if (memory >= current) { return decision(policy, 'NOT_ELIGIBLE', ['ROUNDING_OR_SAFE_FLOOR_STALLED']) }
  return decision(policy, 'DOWNSIZE_CANDIDATE', [], memory.toString(),
    [profile.sourceRef, caps.sourceRef, window.sourceRef], window.id)
}
