import { logicalId, counter } from '../../../../shared/durable-runtime/identity.ts'
import type { FailureTarget, FailureObservationInput, MemorySignals } from './types.ts'
import { prepareFailureObservation } from './normalize.ts'

export const target: FailureTarget = Object.freeze({
  runtimeUnitId: logicalId('runtime-unit', '10000000-0000-0000-0000-000000000001'),
  attemptId: logicalId('attempt', '20000000-0000-0000-0000-000000000001'),
  executionEpoch: counter('execution-epoch', '7'), podUid: 'original-pod' as FailureTarget['podUid'],
  containerName: 'agent', runtimeContainerId: 'containerd://old', incarnation: 'original-incarnation' as FailureTarget['incarnation']
})
export const signals: MemorySignals = { oomKilled: false, memoryEviction: false, nodeOom: false,
  limitOom: false, heapLimit: false, childOom: false, parentAlive: null, otherTermination: false }
export function observation(patch: Partial<FailureObservationInput> = {}): FailureObservationInput {
  const raw: FailureObservationInput = { observationId: 'observation-1', sourceDedupKey: 'source-1', sourceKind: 'KUBERNETES', sourceRef: 'fixture-read-boundary',
    target: { ...target }, observedAt: '2026-10-13T11:00:00Z', sourceAuthenticated: true,
    termination: { state: 'LAST', containerId: target.runtimeContainerId!, incarnation: target.incarnation!, processIdentity: 'original-main-process',
      finishedAt: '2026-10-13T10:59:59.123456789Z', startedAt: '2026-10-13T10:00:00Z', exitCode: 137, signal: 9, reason: 'OOMKilled' },
    counterTransition: null, signals: { ...signals, oomKilled: true },
    resources: null,
    placement: { batchId: 'batch-original', nodeUid: 'node-original', targetPodUid: target.podUid, complete: true,
      otherUserPodUids: [], platformPodUids: ['platform-1'], unknownPodUids: [], provenance: null },
    workloadKind: 'AGENT', profileVerified: true, defaultLimitlessProfile: true, affectedWorkIds: [], gaps: [], evidence: { fixture: true } }
  const eventKey = prepareFailureObservation(raw).canonicalKey!
  const provenance = { target: raw.target, eventKey, sourceRef: 'fixture-original-resource-and-placement', observedAt: '2026-10-13T10:59:59.123456789Z' }
  const values = { memoryRequest: '512Mi', memoryLimit: null, cpuRequest: '250m', cpuLimit: null }
  return { ...raw, resources: { desired: values, observedSpec: values, observedStatus: null,
    admitted: { values, provenance }, applied: { values, provenance } },
    placement: { ...raw.placement!, provenance }, ...patch }
}
export function pod() {
  return { metadata: { name: 'agent-pod', namespace: 'agents', uid: target.podUid, resourceVersion: 'opaque:rv:a' },
    spec: { nodeName: 'node-name', containers: [{ name: 'agent', resources: { requests: { memory: '512Mi', cpu: '250m' }, limits: {} } }] },
    status: { phase: 'Running', containerStatuses: [{ name: 'agent', restartCount: 2, containerID: 'containerd://new',
      state: { running: { startedAt: '2026-10-13T11:00:00Z' } },
      lastState: { terminated: { containerID: 'containerd://old', reason: 'OOMKilled', exitCode: 137, signal: 9,
        startedAt: '2026-10-13T10:00:00Z', finishedAt: '2026-10-13T10:59:59.123456789Z' } } }] } }
}
