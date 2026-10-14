import type { FailureTarget } from '../evidence/types.ts'
import type { BudgetFacts, CapEvidence, GrowthInput, PolicyDecision, ProfileEvidence, ResourcePolicy } from './types.ts'
import { ceilRatio, growthBudget, integer, max, positive, roundUpMemory, text, time } from './arithmetic.ts'
import { capEndpointKnown, capacityDecision, decision, effectiveCap, profileKnown, sameTarget, usablePeak } from './guards.ts'

export function inspectBudgets(policy: ResourcePolicy, caps: CapEvidence,
  profile: ProfileEvidence, budget: BudgetFacts, target: FailureTarget): {
    readonly growthLimit: string; readonly replacementLimit: string; readonly reasons: readonly string[]
  } {
  text(budget.sourceRef); time(budget.dbNowMs); time(budget.rollingStartMs)
  const cap = effectiveCap(policy, caps)
  if (cap < positive(profile.minimumMemoryBytes)) {
    return Object.freeze({ growthLimit: '0', replacementLimit: '0', reasons: ['CAP_BELOW_MINIMUM'] })
  }
  const growth = positive(profile.minimumMemoryBytes) === cap ? 0n :
    integer(growthBudget(cap.toString(), profile.minimumMemoryBytes))
  const replacement = growth + integer(policy.replacementExtra)
  const reasons: string[] = []
  if (budget.runtimeUnitId !== target.runtimeUnitId ||
    budget.rollingStartMs !== Math.max(0, budget.dbNowMs - policy.rollingMs)) {
    reasons.push('BUDGET_IDENTITY_OR_WINDOW_MISMATCH')
  }
  if (integer(budget.episodeGrowth) >= growth) { reasons.push('EPISODE_GROWTH_EXHAUSTED') }
  if (integer(budget.rollingGrowth) >= growth) { reasons.push('ROLLING_GROWTH_EXHAUSTED') }
  if (integer(budget.episodeReplacements) >= replacement) { reasons.push('REPLACEMENTS_EXHAUSTED') }
  return Object.freeze({ growthLimit: growth.toString(), replacementLimit: replacement.toString(),
    reasons: Object.freeze(reasons) })
}

export function evaluateGrowth(input: GrowthInput): PolicyDecision {
  const { policy, target, classification, profile, caps, peak, budget } = input
  if (!profileKnown(policy, target, profile, caps) || !profile || !caps) {
    return decision(policy, 'NEEDS_ADMISSION_EVIDENCE', ['PROFILE_MINIMUM_CONFIG_OR_PROVENANCE_UNKNOWN'])
  }
  if (!input.currentAgent || !sameTarget(target, input.classificationTarget) ||
    classification.authority !== 'DATA_ONLY' || !classification.automaticGrowthCandidate ||
    classification.classification !== 'ISOLATED_NODE_MEMORY_EXHAUSTION' ||
    classification.conflicts.length > 0 ||
    classification.observationIds.length === 0) {
    return decision(policy, 'NOT_ELIGIBLE', ['REACTIVE_TARGET_NOT_ELIGIBLE',
      ...classification.reasons, ...classification.missing, ...classification.conflicts])
  }
  if (input.priorResourceWait) { return decision(policy, 'RESOURCE_WAIT', ['NO_NEW_MEMORY_CAUSE']) }
  const checks = inspectBudgets(policy, caps, profile, budget, target)
  if (checks.reasons.length > 0) { return decision(policy, 'BLOCKED', checks.reasons) }
  const current = positive(profile.memoryBytes)
  const refs = [profile.sourceRef, caps.sourceRef, budget.sourceRef]
  const reasons: string[] = [...classification.reasons, ...classification.missing]
  let candidate = ceilRatio(current, positive(policy.growth[0]), positive(policy.growth[1]))
  if (peak !== null) {
    if (usablePeak(peak, target, profile.profileRevision, budget.dbNowMs, policy)) {
      candidate = max(candidate, ceilRatio(integer(peak.bytes),
        positive(policy.growthPeak[0]), positive(policy.growthPeak[1])))
      refs.push(peak.sourceRef)
    } else { reasons.push('PEAK_REJECTED_ORIGINAL_TARGET_OR_WINDOW') }
  } else { reasons.push('PEAK_UNOBSERVED_USING_GROWTH_FACTOR') }
  const rounded = integer(roundUpMemory(candidate.toString(), profile.minimumMemoryBytes, policy))
  const cap = effectiveCap(policy, caps)
  const targetMemory = rounded < cap ? rounded : cap
  if (targetMemory <= current) { return decision(policy, 'BLOCKED', ['CAP_REACHED', ...reasons]) }
  if (!capEndpointKnown(targetMemory, profile.minimumMemoryBytes, caps, policy)) {
    return decision(policy, 'NEEDS_ADMISSION_EVIDENCE', ['CAP_ENDPOINT_NOT_ADMITTED', ...reasons])
  }
  const windowId = peak !== null && usablePeak(peak, target, profile.profileRevision,
    budget.dbNowMs, policy) ? peak.windowId : null
  // First capacity wait fixes the same validated target/provenance as the
  // candidate. The durable owner persists this plan; retries must read it.
  const capacity = capacityDecision(policy, caps)
  if (capacity) {
    return capacity.kind === 'RESOURCE_WAIT'
      ? decision(policy, 'RESOURCE_WAIT', [...capacity.reasons, ...reasons], targetMemory.toString(), refs, windowId)
      : capacity
  }
  return decision(policy, 'GROW_CANDIDATE', reasons, targetMemory.toString(), refs, windowId)
}

export function evaluateReplacement(policy: ResourcePolicy, target: FailureTarget,
  profile: ProfileEvidence | null, caps: CapEvidence | null, budget: BudgetFacts): PolicyDecision {
  if (!profileKnown(policy, target, profile, caps) || !profile || !caps) {
    return decision(policy, 'NEEDS_ADMISSION_EVIDENCE', ['PROFILE_UNKNOWN'])
  }
  const checks = inspectBudgets(policy, caps, profile, budget, target)
  const blockers = checks.reasons.filter(reason => reason !== 'EPISODE_GROWTH_EXHAUSTED' &&
    reason !== 'ROLLING_GROWTH_EXHAUSTED')
  if (blockers.length > 0) { return decision(policy, 'BLOCKED', blockers) }
  if (positive(profile.memoryBytes) > effectiveCap(policy, caps)) {
    return decision(policy, 'BLOCKED', ['CURRENT_PROFILE_EXCEEDS_CAP'])
  }
  return capacityDecision(policy, caps) ?? decision(policy, 'PROFILE_CANDIDATE',
    ['SAME_PROFILE_REPLACEMENT_DATA_ONLY'], profile.memoryBytes, [budget.sourceRef])
}

export function selectWakeProfile(policy: ResourcePolicy, target: FailureTarget,
  isNewAgent: boolean, profile: ProfileEvidence | null, caps: CapEvidence | null): PolicyDecision {
  if (!profileKnown(policy, target, profile, caps) || !profile || !caps) {
    return decision(policy, 'NEEDS_ADMISSION_EVIDENCE', ['PROFILE_UNKNOWN'])
  }
  const memory = isNewAgent ? profile.minimumMemoryBytes : profile.memoryBytes
  if (positive(memory) > effectiveCap(policy, caps)) {
    return decision(policy, 'BLOCKED', ['LAST_APPROVED_PROFILE_EXCEEDS_CURRENT_CAP'])
  }
  return decision(policy, 'PROFILE_CANDIDATE', [isNewAgent ? 'NEW_AGENT_MINIMUM' : 'LAST_APPROVED_PROFILE_PRESERVED'],
    memory, [profile.sourceRef, caps.sourceRef])
}
