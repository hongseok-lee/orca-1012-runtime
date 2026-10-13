import type { ClassificationResult, FailureClass, PreparedFailureObservation } from './types.ts'
import { targetKey } from './normalize.ts'

export function classifyFailureEvidence(observations: readonly PreparedFailureObservation[]): ClassificationResult {
  const reasons = new Set<string>(), missing = new Set<string>(), conflicts = new Set<string>()
  const ids = observations.map(o => o.input.observationId)
  if (!observations.length) missing.add('NO_OBSERVATIONS')
  const keys = new Set(observations.map(o => targetKey(o.input.target)))
  if (keys.size > 1) conflicts.add('DIFFERENT_EXECUTION_TARGETS')
  const digests = new Map<string, string>()
  for (const o of observations) {
    const old = digests.get(o.input.sourceDedupKey)
    if (old && old !== o.payloadDigest) conflicts.add('SOURCE_KEY_PAYLOAD_CONFLICT')
    digests.set(o.input.sourceDedupKey, o.payloadDigest)
    for (const issue of o.issues) {
      if (issue.includes('MISMATCH') || issue === 'COUNTER_RESET') conflicts.add(issue)
      else missing.add(issue)
    }
  }
  const trusted = observations.filter(o => o.input.sourceAuthenticated && o.input.sourceKind !== 'UNTRUSTED_TEXT' &&
    o.resolution === 'RESOLVED' && !o.issues.some(s => s.includes('MISMATCH') || s === 'COUNTER_RESET' ||
      s === 'CONTAINER_STATUS_INCOMPLETE_OR_DUPLICATE' || s === 'DUPLICATE_TERMINATION_MATCH' || s === 'KUBERNETES_RESPONSE_INCOMPLETE'))
  const any = (key: keyof PreparedFailureObservation['input']['signals']): boolean =>
    trusted.some(o => o.input.signals[key] === true)
  const memory = any('oomKilled') || any('memoryEviction') || any('nodeOom') || any('limitOom') || any('childOom')
  if (memory && any('otherTermination')) conflicts.add('MEMORY_AND_OTHER_TERMINATION')
  if (any('heapLimit') && memory) conflicts.add('HEAP_AND_KERNEL_MEMORY_EVIDENCE')
  if (trusted.some(o => o.input.signals.childOom) && trusted.some(o => o.input.termination?.state !== 'SUPERVISOR' && o.input.signals.oomKilled)) {
    conflicts.add('CHILD_AND_CONTAINER_TERMINATION')
  }
  const termKeys = new Set(trusted.flatMap(o => o.aliases.filter(a => a.kind === 'TERMINATION').map(a => a.key)))
  if (termKeys.size > 1) conflicts.add('DIFFERENT_TERMINATIONS')
  const placements = trusted.flatMap(o => o.input.placement ? [o.input.placement] : [])
  const complete = placements.filter(p => p.complete && !p.unknownPodUids.length)
  if (new Set(complete.map(p => p.nodeUid)).size > 1) conflicts.add('PLACEMENT_NODE_CHANGED')
  if (complete.some(p => p.otherUserPodUids.length) && complete.some(p => !p.otherUserPodUids.length)) conflicts.add('PLACEMENT_DISAGREEMENT')
  const resourceSamples = trusted.flatMap(o => o.input.resources ? [o.input.resources] : [])
  if (new Set(resourceSamples.map(r => r.admittedMemoryLimit)).size > 1) conflicts.add('ADMITTED_LIMIT_CHANGED')
  if (!trusted.length) missing.add('NO_AUTHENTICATED_RESOLVED_EVIDENCE')
  const finish = (classification: FailureClass, candidate = false): ClassificationResult => Object.freeze({
    classification, reasons: Object.freeze([...reasons]), missing: Object.freeze([...missing]),
    conflicts: Object.freeze([...conflicts]), observationIds: Object.freeze([...new Set(ids)]),
    automaticGrowthCandidate: candidate && conflicts.size === 0, authority: 'DATA_ONLY'
  })
  if (conflicts.size || !trusted.length) return finish('UNKNOWN_MEMORY_FAILURE')
  if (any('childOom')) {
    const child = trusted.some(o => o.input.signals.childOom && o.input.signals.parentAlive === true &&
      o.input.affectedWorkIds.length > 0 && ((o.input.sourceKind === 'SUPERVISOR' && o.input.termination?.processIdentity) ||
      (o.input.sourceKind === 'CGROUP' && o.input.counterTransition && o.input.counterTransition.counter !== 'oom' && !o.issues.includes('COUNTER_NO_TRANSITION'))))
    if (!child) { missing.add('CHILD_PROCESS_OR_PARENT_LIVENESS_UNPROVEN'); return finish('UNKNOWN_MEMORY_FAILURE') }
    reasons.add('EXACT_CHILD_OOM_PARENT_ALIVE'); return finish('CHILD_CGROUP_OOM')
  }
  if (any('heapLimit')) {
    if (!trusted.some(o => o.input.sourceKind === 'SUPERVISOR' && o.input.signals.heapLimit && o.input.termination?.processIdentity)) {
      missing.add('SUPERVISOR_PROCESS_IDENTITY_REQUIRED'); return finish('UNKNOWN_MEMORY_FAILURE')
    }
    reasons.add('SUPERVISOR_PROCESS_HEAP_LIMIT'); return finish('PROCESS_HEAP_LIMIT')
  }
  if (any('otherTermination')) { reasons.add('AUTHENTICATED_NON_MEMORY_TERMINATION'); return finish('OTHER_TERMINATION') }
  if (!memory) { missing.add('NO_MEMORY_CAUSE_EXIT137_IS_INSUFFICIENT'); return finish('UNKNOWN_MEMORY_FAILURE') }
  const nodeFailure = any('memoryEviction') || any('nodeOom')
  if (nodeFailure && complete.some(p => p.otherUserPodUids.length > 0)) {
    reasons.add('NODE_MEMORY_FAILURE_AND_USER_COLOCATION'); return finish('SHARED_NODE_MEMORY_PRESSURE')
  }
  const finiteLimit = resourceSamples.some(r => r.admittedMemoryLimit !== null && r.admittedMemoryLimit !== 'max')
  if (any('limitOom') && finiteLimit && !nodeFailure) {
    reasons.add('EXPLICIT_CONTAINER_LIMIT_OOM')
    if (trusted.some(o => o.input.defaultLimitlessProfile)) reasons.add('MEMORY_LIMIT_PROFILE_DRIFT')
    return finish('CONTAINER_LIMIT_OOM')
  }
  if (finiteLimit) {
    missing.add('OOMKILLED_WITH_LIMIT_DOES_NOT_EXCLUDE_GLOBAL_OOM'); return finish('UNKNOWN_MEMORY_FAILURE')
  }
  const isolated = complete.some(p => p.targetPodUid === trusted[0].input.target.podUid && p.otherUserPodUids.length === 0)
  const limitless = resourceSamples.length > 0 && resourceSamples.every(r => r.admittedMemoryLimit === null || r.admittedMemoryLimit === 'max')
  const eligible = trusted.every(o => o.input.workloadKind === 'AGENT' && o.input.profileVerified && o.input.defaultLimitlessProfile)
  if (isolated && limitless && eligible && (any('oomKilled') || nodeFailure)) {
    reasons.add('ISOLATED_AGENT_LIMITLESS_MEMORY_FAILURE')
    // Missing counters or a low periodic sample do not negate explicit OOM/eviction.
    return finish('ISOLATED_NODE_MEMORY_EXHAUSTION', true)
  }
  if (!isolated) missing.add('PLACEMENT_INCOMPLETE_OR_NOT_ISOLATED')
  if (!limitless) missing.add('ADMITTED_LIMIT_NOT_OBSERVED')
  if (!eligible) missing.add('AGENT_PROFILE_SCOPE_NOT_VERIFIED')
  return finish('UNKNOWN_MEMORY_FAILURE')
}
