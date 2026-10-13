import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailureEvidence } from './classify.ts'
import { prepareFailureObservation, resolveEvidenceAliases, evidenceTime } from './normalize.ts'
import { collectCgroupSample, cgroupCounterTransition } from './cgroup.ts'
import { collectKubernetesEvidence, collectUnboundPodSample } from './kubernetes.ts'
import type { FailureObservationInput, CounterTransition } from './types.ts'
import type { KubernetesReadBatch, KubernetesCollectionRequest } from './kubernetes.ts'
import { observation, signals, target, pod } from './fixtures.mts'

function classify(patch: Partial<FailureObservationInput> = {}) {
  return classifyFailureEvidence([prepareFailureObservation(observation(patch))])
}
const transition: CounterTransition = { cgroupIdentity: 'child-cgroup', processIdentity: 'child-process', incarnation: target.incarnation!,
  counter: 'oom_kill', previous: '0', current: '1', previousSampleId: 'before', currentSampleId: 'after' }
const cases: [string, Partial<FailureObservationInput>][] = [
  ['ISOLATED_NODE_MEMORY_EXHAUSTION', {}],
  ['CONTAINER_LIMIT_OOM', { resources: { ...observation().resources!, admittedMemoryLimit: '512Mi' }, signals: { ...signals, oomKilled: true, limitOom: true } }],
  ['SHARED_NODE_MEMORY_PRESSURE', { signals: { ...signals, memoryEviction: true }, placement: { ...observation().placement!, otherUserPodUids: ['user-2'] } }],
  ['PROCESS_HEAP_LIMIT', { sourceKind: 'SUPERVISOR', signals: { ...signals, heapLimit: true } }],
  ['CHILD_CGROUP_OOM', { sourceKind: 'CGROUP', termination: null, counterTransition: transition,
    signals: { ...signals, childOom: true, parentAlive: true }, affectedWorkIds: ['affected-work'] }],
  ['UNKNOWN_MEMORY_FAILURE', { signals: { ...signals } }],
  ['OTHER_TERMINATION', { sourceKind: 'SUPERVISOR', signals: { ...signals, otherTermination: true } }]
]
for (const [expected, patch] of cases) test('classifies ' + expected + ' as data only', () => {
  const result = classify(patch)
  assert.equal(result.classification, expected); assert.equal(result.authority, 'DATA_ONLY')
  assert.equal(result.automaticGrowthCandidate, expected === 'ISOLATED_NODE_MEMORY_EXHAUSTION')
})
test('missing gVisor cgroup and low periodic usage do not negate explicit memory eviction', () => {
  const result = classify({ signals: { ...signals, memoryEviction: true }, gaps: ['CGROUP_NOT_EXPOSED'], evidence: { lastUsageBytes: '1' } })
  assert.equal(result.classification, 'ISOLATED_NODE_MEMORY_EXHAUSTION'); assert.ok(result.missing.includes('CGROUP_NOT_EXPOSED'))
})
test('OOMKilled plus a finite limit is insufficient to exclude global OOM', () => {
  const result = classify({ resources: { ...observation().resources!, admittedMemoryLimit: '512Mi' } })
  assert.equal(result.classification, 'UNKNOWN_MEMORY_FAILURE'); assert.equal(result.automaticGrowthCandidate, false)
})
test('arbitrary stderr, unverified source, non-Agent and absent placement cannot authorize growth', () => {
  for (const patch of [ { sourceKind: 'UNTRUSTED_TEXT' as const, evidence: { errorClass: 'UNTRUSTED_OOM_TEXT_IGNORED' } },
    { sourceAuthenticated: false }, { workloadKind: 'DEV' as const }, { placement: null } ]) {
    assert.equal(classify(patch).automaticGrowthCandidate, false)
    assert.equal(classify(patch).classification, 'UNKNOWN_MEMORY_FAILURE')
  }
})
test('conflicting memory/other termination and heap/kernel evidence are preserved', () => {
  for (const patch of [{ ...signals, oomKilled: true, otherTermination: true }, { ...signals, oomKilled: true, heapLimit: true }]) {
    const result = classify({ signals: patch }); assert.equal(result.classification, 'UNKNOWN_MEMORY_FAILURE'); assert.ok(result.conflicts.length > 0)
  }
})
test('precise same termination deduplicates independent sources and observed resource versions', () => {
  const a = prepareFailureObservation(observation())
  const b = prepareFailureObservation(observation({ observationId: 'observation-2', sourceDedupKey: 'source-2', sourceKind: 'SUPERVISOR',
    observedAt: '2026-10-13T11:05:00Z', evidence: { resourceVersion: 'not-numeric' } }))
  assert.equal(a.canonicalKey, b.canonicalKey)
  assert.equal(a.finishedTime!.epochNanoseconds, evidenceTime('2026-10-13T12:59:59.123456789+02:00').epochNanoseconds)
  const mutated = observation(); const c = prepareFailureObservation(mutated)
  ;(mutated.affectedWorkIds as string[]).push('mutated'); (mutated.target as { runtimeContainerId: string }).runtimeContainerId = 'other'
  assert.equal(c.input.affectedWorkIds.length, 0); assert.equal(c.input.target.runtimeContainerId, 'containerd://old')
})
test('restart/container and different child processes remain distinct; alias collisions block reassignment', () => {
  const a = prepareFailureObservation(observation())
  const t = { ...target, runtimeContainerId: 'containerd://new', incarnation: 'next-incarnation' as typeof target.incarnation }
  const b = prepareFailureObservation(observation({ target: t, termination: { ...observation().termination!, containerId: t.runtimeContainerId, incarnation: t.incarnation! } }))
  assert.notEqual(a.canonicalKey, b.canonicalKey)
  const child = (name: string) => prepareFailureObservation(observation({ sourceKind: 'SUPERVISOR', signals: { ...signals, childOom: true, parentAlive: true },
    termination: { ...observation().termination!, processIdentity: name }, counterTransition: { ...transition, processIdentity: name }, affectedWorkIds: ['work'] }))
  const c = child('child-1'), d = child('child-2'); assert.notEqual(c.canonicalKey, d.canonicalKey); assert.equal(c.aliases.length, 2)
  const conflict = resolveEvidenceAliases(c, [{ aliasKey: c.aliases[0].key, incidentId: 'incident-a' }, { aliasKey: c.aliases[1].key, incidentId: 'incident-b' }])
  assert.deepEqual(conflict.conflicts, ['ALIAS_OWNERSHIP_CONFLICT']); assert.equal(conflict.incidentId, null)
})
test('counter reset, duplicate and unproven process link remain explicit', () => {
  for (const [current, expected] of [['0', 'COUNTER_NO_TRANSITION'], ['1', 'ALIAS_LINK_UNPROVEN']] as const) {
    const o = prepareFailureObservation(observation({ counterTransition: { ...transition, current } })); assert.ok(o.issues.includes(expected))
  }
  const reset = prepareFailureObservation(observation({ counterTransition: { ...transition, previous: '2', current: '1' } }))
  assert.ok(reset.issues.includes('COUNTER_RESET'))
})
test('same source key with another immutable payload remains a conflict', () => {
  const a = prepareFailureObservation(observation()), b = prepareFailureObservation(observation({ evidence: { changed: true } }))
  const result = classifyFailureEvidence([a,b]); assert.ok(result.conflicts.includes('SOURCE_KEY_PAYLOAD_CONFLICT'))
})

function batch(): KubernetesReadBatch {
  return { batchId: 'batch', pod: pod(), node: { metadata: { name: 'node-name', uid: 'node-uid' } },
    placementPods: [pod()], placementComplete: true, placementNodeUid: 'node-uid', platformOrigins: [] }
}
function request(): KubernetesCollectionRequest {
  return { target: { ...target }, namespace: 'agents', podName: 'agent-pod', observationId: 'read-1', sourceDedupKey: 'read-source-1',
    observedAt: new Date('2026-10-13T11:00:00Z'), workloadKind: 'AGENT', profileVerified: true, defaultLimitlessProfile: true,
    desired: { memoryRequest: '512Mi', memoryLimit: null } }
}
test('collector preserves old lastState container instead of assigning old termination to current ID', async () => {
  const o = await collectKubernetesEvidence({ sourceRef: 'fixture', authentication: 'BOUNDARY_AUTHENTICATED', readBatch: async () => batch() }, request())
  assert.equal(o.input.termination!.containerId, 'containerd://old'); assert.equal(o.input.termination!.state, 'LAST')
  assert.equal(o.input.evidence && typeof o.input.evidence === 'object' && !Array.isArray(o.input.evidence) ? o.input.evidence.currentContainerId : null, 'containerd://new')
  const r = { ...request(), target: { ...target, runtimeContainerId: 'containerd://new' } }
  const newer = await collectKubernetesEvidence({ sourceRef: 'fixture', authentication: 'BOUNDARY_AUTHENTICATED', readBatch: async () => batch() }, r)
  assert.equal(newer.input.termination, null); assert.equal(newer.canonicalKey, null)
})
test('collector snapshots target, Date and desired resources before await; opaque resourceVersion survives', async () => {
  const r = request(); const oldDate = r.observedAt as Date
  const o = await collectKubernetesEvidence({ sourceRef: 'fixture', authentication: 'BOUNDARY_AUTHENTICATED', readBatch: async captured => {
    ;(r.target as {runtimeContainerId: string}).runtimeContainerId = 'changed'; oldDate.setFullYear(2030)
    ;(r.desired as { memoryRequest: string }).memoryRequest = '9Gi'
    assert.equal(captured.target.runtimeContainerId, 'containerd://old'); return batch()
  } }, r)
  assert.equal(o.input.observedAt, '2026-10-13T11:00:00.000Z'); assert.equal(o.input.resources!.desiredMemoryRequest, '512Mi')
})
test('duplicates, Pod replacement, placement gap and read failures preserve UNKNOWN', async () => {
  const bad = batch(); const p = bad.pod as ReturnType<typeof pod>; p.status.containerStatuses.push(p.status.containerStatuses[0])
  const read = (b: KubernetesReadBatch) => collectKubernetesEvidence({ sourceRef: 'fixture', authentication: 'BOUNDARY_AUTHENTICATED', readBatch: async () => b }, request())
  const duplicate = await read(bad); assert.ok(duplicate.issues.includes('CONTAINER_STATUS_INCOMPLETE_OR_DUPLICATE'))
  const replaced = batch(); (replaced.pod as ReturnType<typeof pod>).metadata.uid = 'replacement' as typeof target.podUid
  assert.ok((await read(replaced)).issues.includes('POD_IDENTITY_MISMATCH'))
  const gap = await read({ ...batch(), placementComplete: false }); assert.equal(classifyFailureEvidence([gap]).automaticGrowthCandidate, false)
  const failed = await collectKubernetesEvidence({ sourceRef: 'fixture', authentication: 'BOUNDARY_AUTHENTICATED', readBatch: async () => { throw new Error('private-error-not-copied') } }, request())
  assert.ok(failed.issues.includes('KUBERNETES_READ_FAILED')); assert.ok(!JSON.stringify(failed).includes('private-error-not-copied'))
})
test('only verified platform origins exclude workloads; namespace/name/DaemonSet hints do not', async () => {
  const system = pod(); system.metadata.uid = 'platform-pod' as typeof target.podUid; system.metadata.namespace = 'kube-system'; system.metadata.name = 'balloon';
  const b = { ...batch(), placementPods: [pod(), system] }
  const read = (v: KubernetesReadBatch) => collectKubernetesEvidence({ sourceRef: 'fixture', authentication: 'BOUNDARY_AUTHENTICATED', readBatch: async () => v }, request())
  const unknownOrigin = await read(b); assert.deepEqual(unknownOrigin.input.placement!.otherUserPodUids, ['platform-pod'])
  const verified = await read({ ...b, platformOrigins: [{ podUid: 'platform-pod', nodeUid: 'node-uid', batchId: 'batch', kind: 'PLATFORM_BALLOON', provenanceRef: 'verified-platform-boundary-ref' }] })
  assert.deepEqual(verified.input.placement!.platformPodUids, ['platform-pod']); assert.equal(verified.input.placement!.otherUserPodUids.length, 0)
})
test('Pod eviction without original container identity has no fabricated alias or growth target', async () => {
  const b = batch(); const p = b.pod as ReturnType<typeof pod>
  Object.assign(p.status, { reason: 'Evicted', message: 'The node was low on resource: memory.' }); p.status.containerStatuses = []
  const r = { ...request(), target: { ...target, containerName: null, runtimeContainerId: null, incarnation: null } }
  const o = await collectKubernetesEvidence({ sourceRef: 'fixture', authentication: 'BOUNDARY_AUTHENTICATED', readBatch: async () => b }, r)
  assert.equal(o.resolution, 'TARGET_UNRESOLVED'); assert.equal(o.aliases.length, 0); assert.equal(o.input.signals.memoryEviction, true)
})
test('cgroup reads only allowed files, distinguishes missing/permission, and deltas require identical incarnation', async () => {
  const identity = { target, cgroupIdentity: 'cg', processIdentity: 'proc', incarnation: target.incarnation! }
  const files: string[] = []
  const before = await collectCgroupSample({ readFile: async (_, file) => { files.push(file); return file === 'memory.events.local' ? 'oom 0\noom_kill 0\n' : file === 'memory.max' ? 'max' : '1' } }, identity, 'before', '2026-10-13T11:00:00Z')
  const after = await collectCgroupSample({ readFile: async (_, file) => file === 'memory.events.local' ? 'oom 1\noom_kill 1\n' : '1' }, identity, 'after', '2026-10-13T11:00:01Z')
  assert.deepEqual(files, ['memory.events.local', 'memory.peak', 'memory.max']); assert.equal(cgroupCounterTransition(before, after, 'oom_kill').status, 'INCREASED')
  assert.equal(cgroupCounterTransition(before, { ...after, identity: { ...identity, incarnation: 'other' } }, 'oom_kill').status, 'UNKNOWN')
  assert.equal(cgroupCounterTransition(after, { ...after, sampleId: 'later', observedAt: '2026-10-13T11:00:02Z', counters: { oom_kill: '0' } }, 'oom_kill').status, 'RESET')
  const missing = await collectCgroupSample({ readFile: async (_,file) => { throw Object.assign(new Error('private-path'), { code: file === 'memory.peak' ? 'EACCES' : 'ENOENT' }) } }, identity, 'missing', '2026-10-13T11:00:02Z')
  assert.equal(missing.counters, null); assert.equal(missing.files['memory.events.local'].status, 'NOT_EXPOSED'); assert.equal(missing.files['memory.peak'].status, 'PERMISSION_DENIED')
  assert.equal(cgroupCounterTransition(before, missing, 'oom_kill').status, 'UNKNOWN'); assert.ok(!JSON.stringify(missing).includes('private-path'))
})
test('unbound dev Pod diagnostic excludes Agent policy without fictional Unit or attempt IDs', async () => {
  const result = await collectUnboundPodSample({ readPod: async () => pod() }, { namespace: 'agents', podName: 'agent-pod', podUid: target.podUid,
    containerName: 'agent', observedAt: '2026-10-13T11:00:00Z', workloadKind: 'DEV' })
  assert.equal(result.status, 'OBSERVED'); assert.equal(result.logicalBinding, null); assert.equal(result.automaticGrowthCandidate, false)
})
