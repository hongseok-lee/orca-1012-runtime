import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareFailureObservation } from './normalize.ts'
import { classifyFailureEvidence } from './classify.ts'
import { collectKubernetesEvidence } from './kubernetes.ts'
import type { KubernetesReadBatch, KubernetesCollectionRequest } from './kubernetes.ts'
import type { ResourceObservation } from './types.ts'
import { observation, signals, target, pod } from './fixtures.mts'

function request(): KubernetesCollectionRequest {
  return { target, namespace: 'agents', podName: 'agent-pod', observationId: 'original-review', sourceDedupKey: 'original-review-source',
    observedAt: '2026-10-13T11:00:00Z', workloadKind: 'AGENT', profileVerified: true, defaultLimitlessProfile: true,
    desired: { memoryRequest: '512Mi', memoryLimit: null } }
}
function batch(): KubernetesReadBatch {
  return { batchId: 'current-batch', pod: pod(), node: { metadata: { name: 'node-name', uid: 'node-uid' } },
    placementPods: [pod()], placementComplete: true, placementNodeUid: 'node-uid', platformOrigins: [] }
}
function collect(b: KubernetesReadBatch) {
  return collectKubernetesEvidence({ sourceRef: 'fixture-trusted-read', authentication: 'BOUNDARY_AUTHENTICATED', readBatch: async () => b }, request())
}
test('current mutable spec and applied status disagreement never establish original limitless resources', async () => {
  const b = batch(), p = b.pod as ReturnType<typeof pod>
  Object.assign(p.status.containerStatuses[0], { resources: { requests: { memory: '512Mi' }, limits: { memory: '512Mi' } } })
  const o = await collect(b)
  assert.equal(o.input.resources!.observedSpec!.memoryLimit, null)
  assert.equal(o.input.resources!.observedStatus!.values.memoryLimit, '512Mi')
  assert.equal(o.input.resources!.admitted, null); assert.equal(o.input.resources!.applied, null)
  assert.equal(classifyFailureEvidence([o]).automaticGrowthCandidate, false)
})
test('old lastState does not acquire the new container status resources or unbound historical planes', async () => {
  const b = batch(), p = b.pod as ReturnType<typeof pod>
  Object.assign(p.status.containerStatuses[0], { resources: { requests: { memory: '512Mi' }, limits: {} } })
  const original = observation().resources!
  const wrongTarget = { ...target, runtimeContainerId: 'containerd://new' }
  const resources: ResourceObservation = { ...original,
    applied: { ...original.applied!, provenance: { ...original.applied!.provenance, target: wrongTarget } } }
  const o = await collect({ ...b, originalResources: resources, originalPlacement: observation().placement })
  assert.equal(o.input.termination!.containerId, 'containerd://old')
  assert.equal(o.input.resources!.observedStatus!.containerId, 'containerd://new')
  const result = classifyFailureEvidence([o]); assert.equal(result.automaticGrowthCandidate, false)
  assert.ok(result.missing.includes('ORIGINAL_APPLIED_RESOURCES_UNPROVEN'))
})
test('a complete current isolated LIST is not original termination placement; bound original evidence retains the positive contract', async () => {
  const original = observation(), currentOnly = await collect({ ...batch(), originalResources: original.resources })
  assert.equal(currentOnly.input.placement!.complete, true); assert.equal(currentOnly.input.placement!.provenance, null)
  assert.equal(classifyFailureEvidence([currentOnly]).automaticGrowthCandidate, false)
  const linked = await collect({ ...batch(), originalResources: original.resources, originalPlacement: original.placement })
  assert.equal(classifyFailureEvidence([linked]).classification, 'ISOLATED_NODE_MEMORY_EXHAUSTION')
  assert.equal(classifyFailureEvidence([linked]).automaticGrowthCandidate, true)
  const gvisor = prepareFailureObservation({ ...linked.input, gaps: ['CGROUP_NOT_EXPOSED'], evidence: { lastUsageBytes: '1' } })
  assert.equal(classifyFailureEvidence([gvisor]).automaticGrowthCandidate, true)
})
test('unknown child process creates no shared parent/time alias; a known child counter keeps only its independent alias', () => {
  const raw = observation({ signals: { ...signals, childOom: true, parentAlive: true },
    termination: { ...observation().termination!, processIdentity: null }, affectedWorkIds: ['work'] })
  const missing = prepareFailureObservation(raw)
  assert.equal(missing.canonicalKey, null); assert.equal(missing.aliases.length, 0)
  assert.equal(missing.resolution, 'TARGET_UNRESOLVED'); assert.ok(missing.issues.includes('CHILD_PROCESS_IDENTITY_MISSING'))
  const known = (name: string) => prepareFailureObservation({ ...raw, sourceKind: 'CGROUP', counterTransition: {
    cgroupIdentity: 'cgroup-' + name, processIdentity: name, incarnation: target.incarnation!, counter: 'oom_kill',
    previous: '0', current: '1', previousSampleId: 'before-' + name, currentSampleId: 'after-' + name } })
  const a = known('child-a'), b = known('child-b')
  assert.deepEqual(a.aliases.map(x => x.kind), ['COUNTER_TRANSITION']); assert.notEqual(a.canonicalKey, b.canonicalKey)
})
