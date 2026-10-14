import type { GrowthInput, PolicyDecision, ProfileEvidence } from './types.ts'
import { integer, positive, text, time } from './arithmetic.ts'
import { capacityDecision, decision, effectiveCap, profileKnown, sameTarget } from './guards.ts'
import { evaluateGrowth } from './growth.ts'

export type RollbackInput = {
  readonly growthInput: GrowthInput
  readonly operationId: string
  readonly operationSourceRef: string
  readonly previousNormal: ProfileEvidence | null
  readonly usedRollbacks: string
  readonly failedBeforeStable: boolean
  readonly failureClass: 'OOM' | 'MEMORY_EVICTION' | 'OTHER' | 'UNKNOWN'
  readonly failedAtMs: number
  readonly additionalGrowthRequired: boolean
}
export type RollbackResult = {
  readonly rollback: PolicyDecision
  readonly additionalGrowth: PolicyDecision | null
  readonly downsizeProtectedUntilMs: number
  readonly countersMutated: false
}
export function evaluateRollback(input: RollbackInput): RollbackResult {
  const { policy, target, profile, caps } = input.growthInput
  text(input.operationId); text(input.operationSourceRef); time(input.failedAtMs)
  const until = time(input.failedAtMs + policy.failureHoldMs)
  const wrap = (rollback: PolicyDecision, additionalGrowth: PolicyDecision | null = null): RollbackResult =>
    Object.freeze({ rollback, additionalGrowth, downsizeProtectedUntilMs: until, countersMutated: false })
  if (!input.failedBeforeStable || input.failedAtMs > time(input.growthInput.budget.dbNowMs) ||
    !['OOM', 'MEMORY_EVICTION'].includes(input.failureClass)) {
    return wrap(decision(policy, 'NOT_ELIGIBLE', ['NOT_PRE_STABILITY_MEMORY_FAILURE']))
  }
  if (integer(input.usedRollbacks) >= integer(policy.rollbackPerOperation)) {
    return wrap(decision(policy, 'BLOCKED', ['OPERATION_ROLLBACK_ALREADY_USED']))
  }
  const old = input.previousNormal
  if (!profileKnown(policy, target, profile, caps) || !profile || !caps || !old ||
    !profileKnown(policy, old.target, old, caps) || !old.verified ||
    !old.sourceRef || !old.profileRevision || old.profileId !== profile.profileId ||
    old.target.runtimeUnitId !== target.runtimeUnitId || old.target.containerName !== target.containerName || !old.memoryLimitOmitted ||
    !old.cpuLimitOmitted || !old.spot || !old.isolated) {
    return wrap(decision(policy, 'NEEDS_ADMISSION_EVIDENCE', ['PREVIOUS_NORMAL_PROFILE_UNKNOWN']))
  }
  const previous = positive(old.memoryBytes)
  if (previous < positive(profile.memoryBytes) || previous > effectiveCap(policy, caps)) {
    return wrap(decision(policy, 'BLOCKED', ['ROLLBACK_CAP_OR_PREVIOUS_SIZE']))
  }
  const wait = capacityDecision(policy, caps)
  if (wait) { return wrap(wait) }
  const rollback = decision(policy, 'ROLLBACK_CANDIDATE', ['ONE_OPERATION_ROLLBACK_OUTSIDE_GROWTH_COUNTER'],
    previous.toString(), [old.sourceRef, input.operationSourceRef, caps.sourceRef])
  if (!input.additionalGrowthRequired) { return wrap(rollback) }
  // Additional bytes above the prior profile require the ordinary growth
  // budget and evidence. Never use rollback as an unlimited growth channel.
  if (!sameTarget(input.growthInput.classificationTarget, target)) {
    return wrap(rollback, decision(policy, 'NOT_ELIGIBLE', ['ADDITIONAL_GROWTH_TARGET_MISMATCH']))
  }
  return wrap(rollback, evaluateGrowth({ ...input.growthInput,
    profile: { ...profile, memoryBytes: previous.toString() } }))
}
