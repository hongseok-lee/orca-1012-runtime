import { logicalId, counter } from '../../../../shared/durable-runtime/identity.ts'
import type { FailureTarget, FailureObservationInput, MemorySignals } from './types.ts'

export const target: FailureTarget = Object.freeze({
  runtimeUnitId: logicalId('runtime-unit', '10000000-0000-0000-0000-000000000001'),
  attemptId: logicalId('attempt', '20000000-0000-0000-0000-000000000001'),
  executionEpoch: counter('execution-epoch', '7'), podUid: 'original-pod' as FailureTarget['podUid'],
  containerName: 'agent', runtimeContainerId: 'containerd://old', incarnation: 'original-incarnation' as FailureTarget['incarnation']
})
export const signals: MemorySignals = { oomKilled: false, memoryEviction: false, nodeOom: false,
  limitOom: false, heapLimit: false, childOom: false, parentAlive: null, otherTermination: false }
export function observation(patch: Partial<FailureObservationInput> = {}): FailureObservationInput {
  return { observationId: 'observation-1', sourceDedupKey: 'source-1', sourceKind: 'KUBERNETES', sourceRef: 'fixture-read-boundary',
    target: { ...target }, observedAt: '2026-10-13T11:00:00Z', sourceAuthenticated: true,
    termination: { state: 'LAST', containerId: target.runtimeContainerId!, incarnation: target.incarnation!, processIdentity: 'original-main-process',
      finishedAt: '2026-10-13T10:59:59.123456789Z', startedAt: '2026-10-13T10:00:00Z', exitCode: 137, signal: 9, reason: 'OOMKilled' },
    counterTransition: null, signals: { ...signals, oomKilled: true },
    resources: { desiredMemoryRequest: '512Mi', desiredMemoryLimit: null, admittedMemoryRequest: '512Mi', admittedMemoryLimit: null,
      admittedCpuRequest: '250m', admittedCpuLimit: null },
    placement: { batchId: 'batch-original', nodeUid: 'node-original', targetPodUid: target.podUid, complete: true,
      otherUserPodUids: [], platformPodUids: ['platform-1'], unknownPodUids: [] },
    workloadKind: 'AGENT', profileVerified: true, defaultLimitlessProfile: true, affectedWorkIds: [], gaps: [], evidence: { fixture: true }, ...patch }
}
export function pod() {
  return { metadata: { name: 'agent-pod', namespace: 'agents', uid: target.podUid, resourceVersion: 'opaque:rv:a' },
    spec: { nodeName: 'node-name', containers: [{ name: 'agent', resources: { requests: { memory: '512Mi', cpu: '250m' }, limits: {} } }] },
    status: { phase: 'Running', containerStatuses: [{ name: 'agent', restartCount: 2, containerID: 'containerd://new',
      state: { running: { startedAt: '2026-10-13T11:00:00Z' } },
      lastState: { terminated: { containerID: 'containerd://old', reason: 'OOMKilled', exitCode: 137, signal: 9,
        startedAt: '2026-10-13T10:00:00Z', finishedAt: '2026-10-13T10:59:59.123456789Z' } } }] } }
}
