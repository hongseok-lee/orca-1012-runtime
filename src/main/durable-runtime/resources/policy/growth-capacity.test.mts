import test from 'node:test'
import assert from 'node:assert/strict'
import { logicalId, counter } from '../../../../shared/durable-runtime/identity.ts'
import type { FailureTarget } from '../evidence/types.ts'
import { createInitialPolicy, evaluateGrowth } from './index.ts'
import type { GrowthInput } from './index.ts'

// One new focused boundary; the original 21-case file is not imported/run.
test('first capacity wait preserves the validated target; retries do not recalculate', () => {
  const mib = (n: bigint) => (n * 1048576n).toString()
  const policy = createInitialPolicy('synthetic-capacity-v1')
  const now = 100000000
  const target: FailureTarget = {
    runtimeUnitId: logicalId('runtime-unit', '10000000-0000-0000-0000-000000000001'),
    attemptId: logicalId('attempt', '20000000-0000-0000-0000-000000000001'),
    executionEpoch: counter('execution-epoch', '7'),
    podUid: 'capacity-fixture-pod' as FailureTarget['podUid'], containerName: 'agent',
    runtimeContainerId: 'containerd://capacity-fixture',
    incarnation: 'capacity-fixture-incarnation' as FailureTarget['incarnation']
  }
  const base: GrowthInput = {
    policy, target, currentAgent: true, priorResourceWait: false, classificationTarget: target,
    classification: { classification: 'ISOLATED_NODE_MEMORY_EXHAUSTION',
      reasons: ['synthetic-original-memory-cause'], missing: [], conflicts: [],
      observationIds: ['synthetic-original-observation'], automaticGrowthCandidate: true, authority: 'DATA_ONLY' },
    profile: { target, profileId: 'synthetic-profile', profileRevision: 'synthetic-profile-1',
      sourceRef: 'synthetic-original-admission', verified: true,
      memoryBytes: mib(1024n), cpuMillicores: '1000', minimumMemoryBytes: mib(256n),
      minimumCpuMillicores: '50', coldStartMemoryBytes: mib(256n), memoryLimitOmitted: true,
      cpuLimitOmitted: true, spot: true, isolated: true, ratio: { sourceRef: 'synthetic-original-config',
        minBytesPerMillicore: '0', maxBytesPerMillicore: mib(1024n) } },
    caps: { verified: true, sourceRef: 'synthetic-original-budget-and-quota', policyBytes: mib(16384n),
      unitBudgetBytes: mib(16384n), quotaBytes: mib(16384n), ratioBytes: mib(16384n),
      reservationBytes: mib(16384n), admittedEndpoints: [], capacityAvailable: false, singleWriterBudgetAvailable: true },
    peak: { target, profileRevision: 'synthetic-profile-1', bytes: mib(2048n),
      metric: 'WORKING_SET', sourceRef: 'synthetic-original-container-peak', verified: true,
      cumulative: false, windowId: 'synthetic-original-peak-window', startMs: now - 1000, endMs: now },
    budget: { runtimeUnitId: target.runtimeUnitId, sourceRef: 'synthetic-original-PG-budget',
      dbNowMs: now, rollingStartMs: now - policy.rollingMs, episodeGrowth: '0', rollingGrowth: '0', episodeReplacements: '0' }
  }
  const before = JSON.stringify(base)
  const wait = evaluateGrowth(base)
  assert.equal(wait.kind, 'RESOURCE_WAIT')
  assert.equal(wait.authority, 'DATA_ONLY')
  assert.equal(wait.targetMemoryBytes, mib(2560n))
  assert.deepEqual(wait.sourceRefs, [base.profile!.sourceRef, base.caps!.sourceRef,
    base.budget.sourceRef, base.peak!.sourceRef])
  assert.equal(wait.windowId, base.peak!.windowId)
  assert.ok(wait.reasons.includes('CAPACITY_UNAVAILABLE'))
  assert.ok(Object.isFrozen(wait.sourceRefs))
  const candidate = evaluateGrowth({ ...base, caps: { ...base.caps!, capacityAvailable: true } })
  assert.equal(candidate.kind, 'GROW_CANDIDATE')
  assert.equal(candidate.targetMemoryBytes, wait.targetMemoryBytes)
  assert.deepEqual(candidate.sourceRefs, wait.sourceRefs)
  assert.equal(JSON.stringify(base), before)

  // Capacity false must not mask cap failure or an unverified endpoint.
  const cap = evaluateGrowth({ ...base, caps: { ...base.caps!, quotaBytes: mib(1024n) } })
  assert.equal(cap.kind, 'BLOCKED'); assert.ok(cap.reasons.includes('CAP_REACHED'))
  assert.equal(cap.targetMemoryBytes, null)
  const endpoint = evaluateGrowth({ ...base, caps: { ...base.caps!, quotaBytes: mib(1500n) } })
  assert.equal(endpoint.kind, 'NEEDS_ADMISSION_EVIDENCE')
  assert.ok(endpoint.reasons.includes('CAP_ENDPOINT_NOT_ADMITTED'))
  assert.equal(endpoint.targetMemoryBytes, null)
  assert.equal(evaluateGrowth({ ...base, profile: null }).kind, 'NEEDS_ADMISSION_EVIDENCE')
  assert.equal(evaluateGrowth({ ...base, caps: { ...base.caps!, capacityAvailable: null } }).kind,
    'NEEDS_ADMISSION_EVIDENCE')
  assert.throws(() => evaluateGrowth({ ...base, peak: { ...base.peak!, bytes: 'invalid-decimal' } }))

  // Poison unused inputs: a prior wait reads its original durable plan rather
  // than recalculating a new growth target, peak or counter budget here.
  const prior = evaluateGrowth({ ...base, priorResourceWait: true,
    peak: { ...base.peak!, bytes: 'invalid-decimal' },
    budget: { ...base.budget, episodeGrowth: 'invalid-decimal' } })
  assert.equal(prior.kind, 'RESOURCE_WAIT')
  assert.deepEqual(prior.reasons, ['NO_NEW_MEMORY_CAUSE'])
  assert.equal(prior.targetMemoryBytes, null)
  assert.deepEqual(prior.sourceRefs, [])
})
