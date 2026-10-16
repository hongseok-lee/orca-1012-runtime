import { isIP } from 'node:net'
import type { JsonValue } from '../db/atomic.ts'
import { canonicalInput } from '../runtime/gateway/input.ts'
import { captureAgentPodCreateInput, projectAgentPodCreate } from '../lifecycle/agent-pod-create-projection.ts'
import { inventoryName, inventoryOpaque, inventoryRecord } from '../lifecycle/kubernetes-identity.ts'
import { agentPodArray, agentPodFields, agentPodPath, agentPodText, agentPodUuid, agentPodWithin } from '../runtime/agent-pod-policy.ts'
import type { AgentPodPlanRecord } from '../db/agent-pod-plan-record-rows.ts'
import type { AgentMountCollectorConfig, AgentMountExpectation, AgentMountPodIncarnation, AgentMountStorage } from './agent-mount-collector-types.ts'
import { AgentMountCollectorError } from './agent-mount-collector-types.ts'

export function captureAgentMountInput(record: AgentPodPlanRecord, podUid: string, config: AgentMountCollectorConfig) {
  try {
    // Reuse Backend's detached original plan/Pod capture and digest verification, never regenerate a desired Pod.
    const original = captureAgentPodCreateInput({ record, mode: 'LOOKUP_ONLY', remainingMs: config.timeoutMs }, config.namespace, config.dataset)
    const plan = agentPodFields(agentPodFields(record, ['plan', 'planDigest', 'recordedAt']).get('plan'),
      ['kind', 'identity', 'pod', 'mountExpectations', 'podSpecSHA256', 'readinessObserved', 'storageGrantIssued', 'physicalPinIssued'])
    const expectations = agentPodFields(plan.get('mountExpectations'), ['protected', 'shared'])
    const mounts: AgentMountExpectation[] = agentPodArray(expectations.get('protected')).map(value => {
      const item = agentPodFields(value, ['key', 'bindingId', 'leafId', 'claimName', 'claimUid', 'pvUid', 'serverPath', 'mode', 'clientPath', 'server'])
      const leaf = agentPodUuid(item.get('leafId')), mode = item.get('mode'), clientPath = agentPodPath(item.get('clientPath'))
      agentPodUuid(item.get('bindingId'))
      if (mode !== 'RO' && mode !== 'RW' || !agentPodWithin('/agent', clientPath) ||
          item.get('serverPath') !== `/exports/runtime-domains/${config.dataset}/${leaf}`) { throw new Error('INPUT_INVALID') }
      return Object.freeze({ kind: 'protected', key: inventoryName(item.get('key')), claimName: inventoryName(item.get('claimName')),
        claimUid: inventoryOpaque(item.get('claimUid')), pvUid: inventoryOpaque(item.get('pvUid')),
        server: server(item.get('server')), serverPath: agentPodPath(item.get('serverPath')), clientPath, mode })
    })
    const shared = agentPodFields(expectations.get('shared'), ['claimName', 'claimUid', 'pvUid', 'serverPath', 'server', 'clientPath', 'mode'])
    if (!mounts.length || shared.get('mode') !== 'RW' || shared.get('clientPath') !== '/shared' ||
        shared.get('serverPath') !== `/exports/shared/${config.dataset}`) { throw new Error('INPUT_INVALID') }
    mounts.push(Object.freeze({ kind: 'shared', key: 'shared', claimName: inventoryName(shared.get('claimName')),
      claimUid: inventoryOpaque(shared.get('claimUid')), pvUid: inventoryOpaque(shared.get('pvUid')),
      server: server(shared.get('server')), serverPath: agentPodPath(shared.get('serverPath')), clientPath: '/shared', mode: 'RW' }))
    const containers = agentPodArray(original.spec.containers), container = inventoryRecord(containers[0])
    if (containers.length !== 1) { throw new Error('INPUT_INVALID') }
    const volumes = agentPodArray(original.spec.volumes).map(inventoryRecord)
    const actualMounts = agentPodArray(container.volumeMounts).map(inventoryRecord)
    if (volumes.length !== mounts.length + 1 || actualMounts.length !== mounts.length + 1) { throw new Error('INPUT_INVALID') }
    for (let index = 0; index < mounts.length; index++) {
      const item = mounts[index], volumeName = item.kind === 'shared' ? 'shared' : `protected-${index}`
      const volume = volumes.filter(value => value.name === volumeName), mount = actualMounts.filter(value => value.name === volumeName)
      if (volume.length !== 1 || mount.length !== 1) { throw new Error('INPUT_INVALID') }
      const pvc = inventoryRecord(volume[0].persistentVolumeClaim)
      if (pvc.claimName !== item.claimName || (pvc.readOnly ?? false) !== (item.mode === 'RO') ||
          mount[0].mountPath !== item.clientPath || (mount[0].readOnly ?? false) !== (item.mode === 'RO')) { throw new Error('INPUT_INVALID') }
      for (const other of mounts.slice(0, index)) {
        if (item.claimName === other.claimName || item.claimUid === other.claimUid || item.pvUid === other.pvUid ||
            agentPodWithin(item.clientPath, other.clientPath) || agentPodWithin(other.clientPath, item.clientPath)) { throw new Error('INPUT_INVALID') }
      }
    }
    return Object.freeze({ original, podUid: inventoryOpaque(podUid), containerName: inventoryName(container.name), mounts: Object.freeze(mounts) })
  } catch { throw new AgentMountCollectorError('INPUT_INVALID') }
}
export type CapturedAgentMountInput = ReturnType<typeof captureAgentMountInput>
function server(value: unknown): string {
  const text = agentPodText(value)
  if (!isIP(text)) { inventoryName(text) }
  return text
}

function freezeJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) { freezeJson(child) }
    Object.freeze(value)
  }
  return value
}
export function projectAgentMountPod(value: unknown, input: CapturedAgentMountInput): AgentMountPodIncarnation {
  try {
    const observed = projectAgentPodCreate(value, input.original), pod = inventoryRecord(value)
    const metadata = inventoryRecord(pod.metadata), spec = inventoryRecord(pod.spec), status = inventoryRecord(pod.status)
    const statuses = agentPodArray(status.containerStatuses)
    if (observed.uid !== input.podUid || status.phase !== 'Running' || metadata.deletionTimestamp != null || statuses.length !== 1) { throw new Error('POD_IDENTITY') }
    const container = inventoryRecord(statuses[0]), state = agentPodFields(container.state, ['running']), running = inventoryRecord(state.get('running'))
    const startedAt = inventoryOpaque(running.startedAt), restartCount = container.restartCount
    if (container.name !== input.containerName || !Number.isFinite(Date.parse(startedAt)) ||
        typeof restartCount !== 'number' || !Number.isSafeInteger(restartCount) || restartCount < 0) { throw new Error('POD_IDENTITY') }
    return Object.freeze({ uid: observed.uid, name: input.original.name, resourceVersion: observed.resourceVersion,
      nodeName: inventoryName(spec.nodeName), containerName: input.containerName,
      containerId: inventoryOpaque(container.containerID), imageId: inventoryOpaque(container.imageID), restartCount, startedAt,
      admittedResources: freezeJson(observed.admittedResources) })
  } catch { throw new AgentMountCollectorError('POD_IDENTITY') }
}
export function agentMountIncarnation(value: AgentMountPodIncarnation): string {
  return canonicalInput({ uid: value.uid, nodeName: value.nodeName, containerName: value.containerName,
    containerId: value.containerId, imageId: value.imageId, restartCount: value.restartCount, startedAt: value.startedAt,
    admittedResources: value.admittedResources })
}
export function projectAgentMountPvc(value: unknown, expected: AgentMountExpectation, namespace: string) {
  try {
    const pvc = inventoryRecord(value), metadata = inventoryRecord(pvc.metadata), spec = inventoryRecord(pvc.spec)
    if (pvc.apiVersion !== 'v1' || pvc.kind !== 'PersistentVolumeClaim' || metadata.name !== expected.claimName ||
        metadata.namespace !== namespace || metadata.uid !== expected.claimUid || metadata.deletionTimestamp != null ||
        inventoryRecord(pvc.status).phase !== 'Bound' || spec.volumeMode !== undefined && spec.volumeMode !== 'Filesystem') { throw new Error('STORAGE_IDENTITY') }
    return Object.freeze({ name: expected.claimName, uid: expected.claimUid, resourceVersion: inventoryOpaque(metadata.resourceVersion),
      volumeName: inventoryName(spec.volumeName) })
  } catch { throw new AgentMountCollectorError('STORAGE_IDENTITY') }
}
export function projectAgentMountPv(value: unknown, pvc: AgentMountStorage['pvc'], expected: AgentMountExpectation, namespace: string): AgentMountStorage {
  try {
    const pv = inventoryRecord(value), metadata = inventoryRecord(pv.metadata), spec = inventoryRecord(pv.spec)
    const claim = inventoryRecord(spec.claimRef), nfs = inventoryRecord(spec.nfs)
    if (Object.keys(spec).some(key => !['capacity', 'accessModes', 'claimRef', 'nfs', 'volumeMode', 'storageClassName',
      'persistentVolumeReclaimPolicy', 'mountOptions', 'nodeAffinity'].includes(key)) ||
        Object.keys(nfs).some(key => !['server', 'path', 'readOnly'].includes(key))) { throw new Error('STORAGE_IDENTITY') }
    if (pv.apiVersion !== 'v1' || pv.kind !== 'PersistentVolume' || metadata.name !== pvc.volumeName || metadata.uid !== expected.pvUid ||
        metadata.deletionTimestamp != null || inventoryRecord(pv.status).phase !== 'Bound' ||
        spec.volumeMode !== undefined && spec.volumeMode !== 'Filesystem' || spec.csi !== undefined ||
        claim.name !== pvc.name || claim.uid !== pvc.uid || claim.namespace !== namespace ||
        nfs.server !== expected.server || nfs.path !== expected.serverPath ||
        nfs.readOnly !== undefined && typeof nfs.readOnly !== 'boolean' || expected.mode === 'RW' && nfs.readOnly === true) { throw new Error('STORAGE_IDENTITY') }
    return Object.freeze({ expected, pvc, pv: Object.freeze({ name: pvc.volumeName, uid: expected.pvUid,
      resourceVersion: inventoryOpaque(metadata.resourceVersion), claimUid: pvc.uid, server: expected.server,
      path: expected.serverPath, readOnly: nfs.readOnly === true }) })
  } catch { throw new AgentMountCollectorError('STORAGE_IDENTITY') }
}
export function agentMountMapping(value: AgentMountStorage): string {
  const { expected, pvc, pv } = value
  return JSON.stringify({ expected, claimName: pvc.name, claimUid: pvc.uid, volumeName: pvc.volumeName,
    pvUid: pv.uid, pvClaimUid: pv.claimUid, server: pv.server, path: pv.path, readOnly: pv.readOnly })
}
