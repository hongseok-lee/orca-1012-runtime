import test from 'node:test'
import assert from 'node:assert/strict'
import { logicalId, counter } from '../../../../shared/durable-runtime/identity.ts'
import type { ClassificationResult, FailureTarget } from '../evidence/types.ts'
import { classifyFailureEvidence } from '../evidence/classify.ts'
import { prepareFailureObservation } from '../evidence/normalize.ts'
import { observation } from '../evidence/fixtures.mts'
import { createInitialPolicy, roundUpMemory, growthBudget, evaluateGrowth, evaluateReplacement,
  evaluateDownsize, evaluateRollback, selectWakeProfile, episodeStability, circuitRelease,
  compareAdmission, podDemand } from './index.ts'
import type { AdmissionShape, CapEvidence, DownsizeInput, GrowthInput, ProfileEvidence } from './index.ts'

const mib = (n: number | bigint) => (BigInt(n) * 1048576n).toString()
const policy = createInitialPolicy('synthetic-policy-v1')
const now = 100000000
const target: FailureTarget = {
  runtimeUnitId: logicalId('runtime-unit', '10000000-0000-0000-0000-000000000001'),
  attemptId: logicalId('attempt', '20000000-0000-0000-0000-000000000001'),
  executionEpoch: counter('execution-epoch', '7'), podUid: 'original-pod' as FailureTarget['podUid'],
  containerName: 'agent', runtimeContainerId: 'containerd://old',
  incarnation: 'original-incarnation' as FailureTarget['incarnation']
}
const classification: ClassificationResult = {
  classification: 'ISOLATED_NODE_MEMORY_EXHAUSTION', reasons: ['synthetic-limitless-isolated'],
  missing: [], conflicts: [], observationIds: ['synthetic-observation'],
  automaticGrowthCandidate: true, authority: 'DATA_ONLY'
}
function profile(size = 1024, minimum = 256): ProfileEvidence {
  return { profileId: 'synthetic-workload', profileRevision: 'synthetic-profile-1',
    sourceRef: 'synthetic-original-admission', verified: true, target, memoryBytes: mib(size),
    cpuMillicores: '1000', minimumMemoryBytes: mib(minimum), minimumCpuMillicores: '50',
    coldStartMemoryBytes: mib(minimum), memoryLimitOmitted: true, cpuLimitOmitted: true,
    spot: true, isolated: true, ratio: { sourceRef: 'synthetic-compute-config',
      minBytesPerMillicore: '0', maxBytesPerMillicore: mib(1024) } }
}
function caps(): CapEvidence {
  return { verified: true, sourceRef: 'synthetic-cap-reservation-facts', policyBytes: mib(16384),
    unitBudgetBytes: mib(16384), quotaBytes: mib(16384), ratioBytes: mib(16384),
    reservationBytes: mib(16384), admittedEndpoints: [], capacityAvailable: true,
    singleWriterBudgetAvailable: true }
}
function growth(): GrowthInput {
  return { policy, target, classification, classificationTarget: target, currentAgent: true,
    profile: profile(), caps: caps(), peak: null, priorResourceWait: false,
    budget: { runtimeUnitId: target.runtimeUnitId, sourceRef: 'synthetic-PG-budget',
      dbNowMs: now, rollingStartMs: now - 86400000,
      episodeGrowth: '0', rollingGrowth: '0', episodeReplacements: '0' } }
}
function downsize(size = 1024, minimum = 256): DownsizeInput {
  return { policy, target, profile: profile(size, minimum), caps: caps(), dbNowMs: now,
    window: { id: 'synthetic-window', sourceRef: 'synthetic-active-observations',
      workloadProfileId: 'synthetic-workload', used: false, intervals: [{
        startMs: now - 3600000, endMs: now, target, active: true,
        profileRevision: 'synthetic-profile-1', sourceRef: 'synthetic-interval', verified: true,
        expectedSamples: '240', observedSamples: '240', maxGapMs: 15000,
        peak: { target, profileRevision: 'synthetic-profile-1', bytes: '1', metric: 'WORKING_SET',
          sourceRef: 'synthetic-container-window', verified: true, cumulative: false,
          windowId: 'synthetic-window', startMs: now - 3600000, endMs: now }
      }] }, lastOomMs: null, lastDownsizeMs: null, lastFailureMs: null,
    unresolvedRecovery: false, pendingInput: false, activeTurn: false, activeTool: false,
    backgroundWriter: false, safeBoundary: true, rollbackCapacityReserved: true }
}
function admission(): AdmissionShape {
  return { sourceRef: 'synthetic-shape', profileId: 'synthetic-workload', runtimeUnitId: target.runtimeUnitId,
    containerIdentity: 'synthetic-agent-manifest', observed: true, complete: true,
    containers: [{ name: 'agent', memoryBytes: mib(1024), cpuMillicores: '1000',
      memoryLimitPresent: false, cpuLimitPresent: false, restartableInit: false },
    { name: 'sidecar', memoryBytes: mib(64), cpuMillicores: '100',
      memoryLimitPresent: false, cpuLimitPresent: false, restartableInit: false }],
    initContainers: [{ name: 'init', memoryBytes: mib(2048), cpuMillicores: '500',
      memoryLimitPresent: false, cpuLimitPresent: false, restartableInit: false }],
    overheadMemoryBytes: mib(16), overheadCpuMillicores: '10', spot: true, oneUnitPerNode: true }
}
test('initial policy is immutable and uses exact documented values', () => {
  assert.equal(policy.capBytes, mib(16384)); assert.deepEqual(policy.growthPeak, ['5', '4'])
  assert.equal(policy.downsizeActiveMs, 3600000); assert.equal(policy.sampleIntervalMs, 15000)
  assert.equal(policy.maxGapMs, 60000); assert.equal(policy.coveragePercent, '95')
  assert.equal(Object.isFrozen(policy), true); assert.equal(Object.isFrozen(policy.growth), true)
  assert.throws(() => createInitialPolicy(''))
})
test('integer arithmetic preserves huge bytes, rejects lossy and invalid input', () => {
  const value = '9007199254740993123456789'
  const rounded = roundUpMemory(value, '1', policy)
  assert.ok(BigInt(rounded) >= BigInt(value))
  assert.ok(BigInt(rounded) - BigInt(value) < BigInt(mib(64)))
  for (const bad of ['1.5', '-1', '01', '1e9']) { assert.throws(() => roundUpMemory(bad, '1', policy)) }
  assert.equal(growthBudget(mib(16384), mib(256)), '6')
  assert.equal(growthBudget(mib(16384), mib(52)), '9')
})
test('exact minimum endpoints and full downsize ladder reach 256 Mi and 52 Mi', () => {
  const expected = [768, 576, 448, 384, 320, 256]
  let size = 1024
  for (const next of expected) {
    const result = evaluateDownsize(downsize(size))
    assert.equal(result.kind, 'DOWNSIZE_CANDIDATE'); assert.equal(result.targetMemoryBytes, mib(next))
    size = next
  }
  assert.equal(evaluateDownsize(downsize(64, 52)).targetMemoryBytes, mib(52))
  assert.equal(evaluateDownsize(downsize(256)).kind, 'NOT_ELIGIBLE')
})
test('growth uses 2R without peak; valid peak can skip steps; stale peak is not substituted', () => {
  const base = growth()
  assert.equal(evaluateGrowth(base).targetMemoryBytes, mib(2048))
  const p = { target, profileRevision: 'synthetic-profile-1', bytes: mib(3000), metric: 'WORKING_SET' as const,
    sourceRef: 'synthetic-peak', verified: true, cumulative: false, windowId: 'growth-window', startMs: now - 1000, endMs: now }
  assert.equal(evaluateGrowth({ ...base, peak: p }).targetMemoryBytes, mib(3776))
  const stale = evaluateGrowth({ ...base, peak: { ...p, target: { ...target, runtimeContainerId: 'containerd://different' } } })
  assert.equal(stale.targetMemoryBytes, mib(2048)); assert.ok(stale.reasons.includes('PEAK_REJECTED_ORIGINAL_TARGET_OR_WINDOW'))
  assert.equal(evaluateGrowth({ ...base, peak: { ...p, cumulative: true } }).targetMemoryBytes, mib(2048))
})
test('actual PR26 classifier positive with missing gVisor counters remains a data-only candidate', () => {
  const raw = observation({ gaps: ['CGROUP_NOT_EXPOSED'] })
  const classified = classifyFailureEvidence([prepareFailureObservation(raw)])
  assert.equal(classified.automaticGrowthCandidate, true)
  const result = evaluateGrowth({ ...growth(), classification: classified })
  assert.equal(result.kind, 'GROW_CANDIDATE'); assert.equal(result.authority, 'DATA_ONLY')
  assert.ok(result.reasons.includes('CGROUP_NOT_EXPOSED'))
})
test('other classifications, old targets, conflicts and dev scope cannot trigger growth', () => {
  for (const c of ['CONTAINER_LIMIT_OOM', 'PROCESS_HEAP_LIMIT', 'CHILD_CGROUP_OOM',
    'SHARED_NODE_MEMORY_PRESSURE', 'UNKNOWN_MEMORY_FAILURE', 'OTHER_TERMINATION'] as const) {
    assert.equal(evaluateGrowth({ ...growth(), classification: { ...classification, classification: c } }).kind, 'NOT_ELIGIBLE')
  }
  assert.equal(evaluateGrowth({ ...growth(), currentAgent: false }).kind, 'NOT_ELIGIBLE')
  assert.equal(evaluateGrowth({ ...growth(), classificationTarget: { ...target, runtimeContainerId: 'new' } }).kind, 'NOT_ELIGIBLE')
  assert.equal(evaluateGrowth({ ...growth(), classification: { ...classification, conflicts: ['SOURCE_CONFLICT'] } }).kind, 'NOT_ELIGIBLE')
})
test('missing admission/minimum/config evidence is never an admitted result', () => {
  assert.equal(evaluateGrowth({ ...growth(), profile: null }).kind, 'NEEDS_ADMISSION_EVIDENCE')
  assert.equal(evaluateGrowth({ ...growth(), profile: { ...profile(), verified: false } }).kind, 'NEEDS_ADMISSION_EVIDENCE')
  assert.equal(evaluateGrowth({ ...growth(), profile: { ...profile(), ratio: { ...profile().ratio, sourceRef: '' } } }).kind, 'NEEDS_ADMISSION_EVIDENCE')
  assert.equal(evaluateDownsize({ ...downsize(), caps: null }).kind, 'NEEDS_ADMISSION_EVIDENCE')
})
test('cap truncation requires known endpoint and cannot force an unverified profile', () => {
  const base = growth(), c = { ...caps(), quotaBytes: mib(1500) }
  assert.equal(evaluateGrowth({ ...base, caps: c }).kind, 'NEEDS_ADMISSION_EVIDENCE')
  assert.equal(evaluateGrowth({ ...base, caps: { ...c, admittedEndpoints: [mib(1500)] } }).targetMemoryBytes, mib(1500))
  assert.equal(evaluateGrowth({ ...base, profile: profile(16384) }).kind, 'BLOCKED')
  assert.equal(evaluateGrowth({ ...base, caps: { ...caps(), quotaBytes: '0' } }).kind, 'BLOCKED')
})
test('episode, rolling and replacement counters are finite, original and unchanged', () => {
  const base = growth(), saved = JSON.stringify(base.budget)
  for (const key of ['episodeGrowth', 'rollingGrowth'] as const) {
    assert.equal(evaluateGrowth({ ...base, budget: { ...base.budget, [key]: '6' } }).kind, 'BLOCKED')
  }
  assert.equal(evaluateReplacement(policy, target, profile(), caps(), { ...base.budget, episodeReplacements: '9' }).kind, 'BLOCKED')
  assert.equal(evaluateReplacement(policy, target, profile(), caps(), { ...base.budget, rollingGrowth: '6' }).kind, 'PROFILE_CANDIDATE')
  assert.equal(evaluateGrowth({ ...base, budget: { ...base.budget, rollingStartMs: now - 1000 } }).kind, 'BLOCKED')
  assert.equal(evaluateGrowth({ ...base, budget: { ...base.budget, runtimeUnitId: 'another-unit' } }).kind, 'BLOCKED')
  assert.equal(JSON.stringify(base.budget), saved)
})
test('capacity wait and unobserved single-writer remain separate from cap or budget exhaustion', () => {
  assert.equal(evaluateGrowth({ ...growth(), caps: { ...caps(), capacityAvailable: false } }).kind, 'RESOURCE_WAIT')
  assert.equal(evaluateGrowth({ ...growth(), priorResourceWait: true }).kind, 'RESOURCE_WAIT')
  assert.equal(evaluateGrowth({ ...growth(), caps: { ...caps(), singleWriterBudgetAvailable: false } }).kind, 'BLOCKED')
  assert.equal(evaluateGrowth({ ...growth(), caps: { ...caps(), capacityAvailable: null } }).kind, 'NEEDS_ADMISSION_EVIDENCE')
})
test('only new Agent selects minimum; existing wake retains last approved size', () => {
  assert.equal(selectWakeProfile(policy, target, true, profile(), caps()).targetMemoryBytes, mib(256))
  assert.equal(selectWakeProfile(policy, target, false, profile(), caps()).targetMemoryBytes, mib(1024))
  assert.equal(circuitRelease(policy.revision, policy, null).releasable, false)
  assert.equal(circuitRelease('previous-revision', policy, null).releasable, true)
})
test('episode stability needs resolved work and actual OOM-free activity, never idle or Ready', () => {
  const d = downsize()
  assert.equal(episodeStability(policy, d.window, target, 'synthetic-workload', 'synthetic-profile-1', now, true, now - 3600000).stable, true)
  assert.equal(episodeStability(policy, d.window, target, 'synthetic-workload', 'synthetic-profile-1', now, false, now - 3600000).stable, false)
  const idle = { ...d.window, intervals: d.window.intervals.map(i => ({ ...i, active: false })) }
  assert.equal(episodeStability(policy, idle, target, 'synthetic-workload', 'synthetic-profile-1', now, true, now - 3600000).stable, false)
  assert.equal(episodeStability(policy, d.window, target, 'synthetic-workload', 'synthetic-profile-1', now, true, now - 1000).stable, false)
})
test('per-interval metric coverage 95 percent and max gap 60 seconds are exact boundaries', () => {
  const base = downsize(), i = base.window.intervals[0]
  const candidate = { ...base, window: { ...base.window, intervals: [{ ...i, observedSamples: '228', maxGapMs: 60000 }] } }
  assert.equal(evaluateDownsize(candidate).kind, 'DOWNSIZE_CANDIDATE')
  assert.equal(evaluateDownsize({ ...candidate, window: { ...candidate.window, intervals: [{ ...i, observedSamples: '227' }] } }).kind, 'DEFERRED')
  assert.equal(evaluateDownsize({ ...candidate, window: { ...candidate.window, intervals: [{ ...i, maxGapMs: 60001 }] } }).kind, 'DEFERRED')
})
test('missing metrics, stale cumulative peak and overlapping activity cannot inflate evidence', () => {
  const base = downsize(), i = base.window.intervals[0]
  for (const changed of [{ ...i, peak: null }, { ...i, active: false },
    { ...i, expectedSamples: '1' }, { ...i, profileRevision: 'old' }]) {
    assert.equal(evaluateDownsize({ ...base, window: { ...base.window, intervals: [changed] } }).kind, 'DEFERRED')
  }
  assert.equal(evaluateDownsize({ ...base, window: { ...base.window, intervals: [i, i] } }).kind, 'DEFERRED')
  assert.equal(evaluateDownsize({ ...base, window: { ...base.window, intervals: [{ ...i, peak: { ...i.peak!, cumulative: true } }] } }).kind, 'DEFERRED')
})
test('fresh unused profile windows and OOM/downsize/failure protections are required', () => {
  const base = downsize()
  for (const key of ['lastOomMs', 'lastDownsizeMs', 'lastFailureMs'] as const) {
    assert.equal(evaluateDownsize({ ...base, [key]: now - 1000 }).kind, 'DEFERRED')
  }
  assert.equal(evaluateDownsize({ ...base, lastOomMs: now - 86400000 }).kind, 'DOWNSIZE_CANDIDATE')
  assert.equal(evaluateDownsize({ ...base, window: { ...base.window, used: true } }).kind, 'DEFERRED')
  assert.equal(evaluateDownsize({ ...base, window: { ...base.window, workloadProfileId: 'different' } }).kind, 'DEFERRED')
})
test('pending input, turn, tool, writer, recovery and unsafe boundary defer application', () => {
  const base = downsize()
  for (const key of ['pendingInput', 'activeTurn', 'activeTool', 'backgroundWriter', 'unresolvedRecovery'] as const) {
    assert.equal(evaluateDownsize({ ...base, [key]: true }).kind, 'DEFERRED')
  }
  assert.equal(evaluateDownsize({ ...base, safeBoundary: false }).kind, 'DEFERRED')
})
test('representative peak and cold start floor can stop rounding without forcing reduction', () => {
  const base = downsize(), i = base.window.intervals[0]
  assert.equal(evaluateDownsize({ ...base, profile: { ...profile(), coldStartMemoryBytes: mib(1024) } }).kind, 'NOT_ELIGIBLE')
  assert.equal(evaluateDownsize({ ...base, window: { ...base.window, intervals: [{ ...i, peak: { ...i.peak!, bytes: mib(513) } }] } }).kind, 'DEFERRED')
  assert.equal(evaluateDownsize({ ...base, rollbackCapacityReserved: false }).kind, 'RESOURCE_WAIT')
})
test('one rollback outside exhausted growth budget preserves protection; additional growth uses normal budget', () => {
  const g = growth()
  const input = { growthInput: { ...g, profile: profile(768), budget: { ...g.budget, rollingGrowth: '6' } },
    operationId: 'synthetic-downsize-op', operationSourceRef: 'synthetic-original-operation',
    previousNormal: profile(1024), usedRollbacks: '0', failedBeforeStable: true,
    failureClass: 'OOM' as const, failedAtMs: now, additionalGrowthRequired: true }
  const result = evaluateRollback(input)
  assert.equal(result.rollback.kind, 'ROLLBACK_CANDIDATE'); assert.equal(result.rollback.targetMemoryBytes, mib(1024))
  assert.equal(result.additionalGrowth?.kind, 'BLOCKED'); assert.equal(result.countersMutated, false)
  assert.equal(result.downsizeProtectedUntilMs, now + 86400000)
  assert.equal(evaluateRollback({ ...input, usedRollbacks: '1' }).rollback.kind, 'BLOCKED')
  assert.equal(evaluateRollback({ ...input, failedBeforeStable: false }).rollback.kind, 'NOT_ELIGIBLE')
})
test('rollback cannot bypass capacity, cap, single-writer or unknown previous profile', () => {
  const input = { growthInput: { ...growth(), profile: profile(768) }, operationId: 'synthetic-op',
    operationSourceRef: 'synthetic-operation', previousNormal: profile(), usedRollbacks: '0',
    failedBeforeStable: true, failureClass: 'MEMORY_EVICTION' as const, failedAtMs: now, additionalGrowthRequired: false }
  assert.equal(evaluateRollback({ ...input, previousNormal: null }).rollback.kind, 'NEEDS_ADMISSION_EVIDENCE')
  assert.equal(evaluateRollback({ ...input, growthInput: { ...input.growthInput, caps: { ...caps(), capacityAvailable: false } } }).rollback.kind, 'RESOURCE_WAIT')
  assert.equal(evaluateRollback({ ...input, growthInput: { ...input.growthInput, caps: { ...caps(), unitBudgetBytes: mib(768) } } }).rollback.kind, 'BLOCKED')
})
test('admission compares actual requests, limits, Spot and isolation without opening an execution gate', () => {
  const desired = admission()
  const match = compareAdmission(desired, admission(), admission())
  assert.equal(match.status, 'MATCH_DATA_ONLY'); assert.equal(match.authority, 'DATA_ONLY')
  assert.equal(match.externalControllerCapacityGuaranteed, false)
  assert.equal(compareAdmission(desired, null, null).status, 'NEEDS_ADMISSION_EVIDENCE')
  const drift = { ...admission(), spot: false, oneUnitPerNode: false,
    containers: admission().containers.map(c => ({ ...c, memoryBytes: mib(2048), memoryLimitPresent: true })) }
  const result = compareAdmission(desired, drift, null)
  assert.equal(result.status, 'DRIFT'); assert.ok(result.differences.includes('agent:MEMORY_REQUEST'))
  assert.ok(result.differences.includes('agent:MEMORY_LIMIT_NOT_OMITTED'))
  assert.equal(compareAdmission(desired, { ...admission(), complete: false }, null).steady, null)
})
test('init/sidecar demand, overhead and old/new overlap are distinct integer projections', () => {
  const d = admission()
  assert.deepEqual(podDemand(d), { memoryBytes: mib(2064), cpuMillicores: '1110' })
  const result = compareAdmission(d, d, d)
  assert.deepEqual(result.overlap, { memoryBytes: mib(4128), cpuMillicores: '2220' })
  const sideInit = { ...d, initContainers: [{ ...d.initContainers[0], memoryBytes: mib(128), restartableInit: true },
    { ...d.initContainers[0], name: 'later-init', memoryBytes: mib(2048) }] }
  assert.equal(podDemand(sideInit).memoryBytes, mib(2192))
  assert.throws(() => podDemand({ ...d, containers: [d.containers[0], d.containers[0]] }))
})
