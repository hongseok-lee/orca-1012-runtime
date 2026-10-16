import { createHash } from 'node:crypto'
import type { JsonValue } from '../db/atomic.ts'
import { canonicalInput } from '../runtime/gateway/input.ts'
import { agentPodArray, agentPodFields } from '../runtime/agent-pod-policy.ts'
import { inventoryName, inventoryNamespace, inventoryOpaque, inventoryPod, inventoryRecord } from './kubernetes-identity.ts'
import { AgentPodCreateError } from './agent-pod-create-types.ts'
import type { AgentPodCreateInput, AgentPodCreateObservation } from './agent-pod-create-types.ts'

function invalid(): never { throw new AgentPodCreateError('PLAN_INVALID') }
/** Own JSON data only: no getters, toJSON, prototype policy or mutable caller references. */
function snapshot(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') { return value }
  if (typeof value === 'number' && Number.isFinite(value)) { return value }
  if (typeof value !== 'object' || ancestors.has(value)) { return invalid() }
  ancestors.add(value)
  let result: JsonValue
  if (Array.isArray(value)) { result = agentPodArray(value).map(item => snapshot(item, ancestors)) }
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype) { return invalid() }
    const object: Record<string, JsonValue> = {}
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor)) { return invalid() }
      Object.defineProperty(object, key, { value: snapshot(descriptor.value, ancestors), enumerable: true })
    }
    result = object
  }
  ancestors.delete(value)
  return result
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const equal = (left: unknown, right: unknown): boolean => canonicalInput(snapshot(left)) === canonicalInput(snapshot(right))

export function captureAgentPodCreateInput(original: AgentPodCreateInput, namespace: string, dataset: string) {
  try {
    const input = agentPodFields(original, ['record', 'mode', 'remainingMs'])
    const mode = input.get('mode'), remainingMs = input.get('remainingMs')
    if ((mode !== 'LOOKUP_ONLY' && mode !== 'CREATE_ONCE') || typeof remainingMs !== 'number' ||
        !Number.isSafeInteger(remainingMs) || remainingMs <= 0 || remainingMs > 2_147_483_647) { return invalid() }
    const record = agentPodFields(input.get('record'), ['plan', 'planDigest', 'recordedAt'])
    const plan = snapshot(record.get('plan')), fields = agentPodFields(plan,
      ['kind', 'identity', 'pod', 'mountExpectations', 'podSpecSHA256', 'readinessObserved', 'storageGrantIssued', 'physicalPinIssued'])
    const planDigest = record.get('planDigest')
    if (typeof planDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(planDigest) || digest(canonicalInput(plan)) !== planDigest ||
        fields.get('kind') !== 'UNAUTHORIZED_PLAN' || fields.get('readinessObserved') !== false ||
        fields.get('storageGrantIssued') !== false || fields.get('physicalPinIssued') !== false) { return invalid() }
    inventoryOpaque(record.get('recordedAt'))
    const pod = inventoryRecord(fields.get('pod')), metadata = inventoryRecord(pod.metadata), spec = inventoryRecord(pod.spec)
    const id = inventoryRecord(fields.get('identity')), labels = inventoryRecord(metadata.labels), annotations = inventoryRecord(metadata.annotations)
    const name = inventoryName(metadata.name)
    if (pod.apiVersion !== 'v1' || pod.kind !== 'Pod' || inventoryNamespace(metadata.namespace) !== namespace ||
        labels['orca.dev/role'] !== 'runtime-agent' || labels['orca.dev/dataset'] !== dataset ||
        labels['orca.dev/runtime-unit'] !== id.unitId || name !== id.resourceName ||
        annotations['orca.dev/operation-id'] !== id.operationId || annotations['orca.dev/attempt-id'] !== id.attemptId ||
        annotations['orca.dev/execution-epoch'] !== id.executionEpoch || annotations['orca.dev/intent-revision'] !== id.intentRevision ||
        annotations['orca.dev/spec-hash'] !== id.specHash || digest(JSON.stringify(spec)) !== fields.get('podSpecSHA256')) { return invalid() }
    // This body is the captured original stored plan, not a regenerated desired Pod.
    return Object.freeze({ mode, remainingMs, planDigest, namespace, dataset, name, body: JSON.stringify(pod), pod, spec })
  } catch { throw new AgentPodCreateError('INPUT_INVALID') }
}
export type CapturedAgentPodCreate = ReturnType<typeof captureAgentPodCreateInput>

function conflict(): never { throw new AgentPodCreateError('POD_CONFLICT') }
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) { conflict() }
}
function normalizedMount(value: unknown) {
  const mount = inventoryRecord(value)
  keys(mount, ['name', 'mountPath', 'readOnly', 'mountPropagation'])
  if (mount.mountPropagation !== undefined && mount.mountPropagation !== 'None' ||
      mount.readOnly !== undefined && typeof mount.readOnly !== 'boolean') { conflict() }
  return { name: mount.name, mountPath: mount.mountPath, readOnly: mount.readOnly ?? false }
}
function normalizedVolume(value: unknown) {
  const volume = inventoryRecord(value)
  if (volume.persistentVolumeClaim !== undefined) {
    keys(volume, ['name', 'persistentVolumeClaim'])
    const pvc = inventoryRecord(volume.persistentVolumeClaim)
    keys(pvc, ['claimName', 'readOnly'])
    if (pvc.readOnly !== undefined && typeof pvc.readOnly !== 'boolean') { conflict() }
    return { name: volume.name, persistentVolumeClaim: { claimName: pvc.claimName, readOnly: pvc.readOnly ?? false } }
  }
  keys(volume, ['name', 'emptyDir'])
  const empty = inventoryRecord(volume.emptyDir)
  keys(empty, ['medium', 'sizeLimit'])
  if (empty.medium !== undefined && empty.medium !== '') { conflict() }
  return { name: volume.name, emptyDir: { sizeLimit: empty.sizeLimit } }
}
function resources(value: unknown): JsonValue {
  const object = inventoryRecord(value)
  keys(object, ['requests', 'limits'])
  for (const field of ['requests', 'limits']) {
    if (object[field] === undefined) { continue }
    const quantities = inventoryRecord(object[field])
    keys(quantities, ['cpu', 'memory', 'ephemeral-storage'])
    for (const quantity of Object.values(quantities)) {
      if (typeof quantity !== 'string' || !/^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+|[numkKMGTEP]i?)?$/u.test(quantity)) { conflict() }
    }
  }
  return snapshot(object)
}

function tolerations(actual: unknown, expected: unknown): void {
  const desired = agentPodArray(expected), remaining = [...agentPodArray(actual)]
  for (const original of desired) {
    const index = remaining.findIndex(value => equal(value, original))
    if (index === -1) { conflict() }
    remaining.splice(index, 1)
  }
  const seen = new Set<unknown>()
  for (const value of remaining) {
    const extra = inventoryRecord(value)
    keys(extra, ['key', 'operator', 'effect', 'tolerationSeconds', 'value'])
    if (!['node.kubernetes.io/not-ready', 'node.kubernetes.io/unreachable'].includes(String(extra.key)) ||
        seen.has(extra.key) || extra.operator !== 'Exists' || extra.effect !== 'NoExecute' ||
        extra.tolerationSeconds !== 300 || extra.value !== undefined && extra.value !== '') { conflict() }
    seen.add(extra.key)
  }
}

/** API object observation only; PVC names do not prove their current backend or a physical pin. */
export function projectAgentPodCreate(value: unknown, input: CapturedAgentPodCreate): NonNullable<AgentPodCreateObservation['pod']> {
  let pod: Record<string, unknown>, metadata: Record<string, unknown>
  try {
    pod = inventoryRecord(snapshot(value)); metadata = inventoryRecord(pod.metadata)
    if (pod.apiVersion !== 'v1' || pod.kind !== 'Pod') { throw new Error() }
    inventoryOpaque(metadata.uid); inventoryOpaque(metadata.resourceVersion)
    inventoryName(metadata.name); inventoryNamespace(metadata.namespace)
    inventoryRecord(pod.spec)
  } catch { throw new AgentPodCreateError('RESPONSE_INVALID') }
  try {
    const listed = inventoryPod(pod, input.namespace, input.dataset, input.name)
    if (metadata.deletionTimestamp != null) { conflict() }
    const originalMetadata = inventoryRecord(input.pod.metadata)
    for (const field of ['labels', 'annotations']) {
      const expected = inventoryRecord(originalMetadata[field]), actual = inventoryRecord(metadata[field])
      for (const key of Object.keys(expected)) { if (actual[key] !== expected[key]) { conflict() } }
    }
    const actual = inventoryRecord(pod.spec), desired = input.spec
    // Only the exact defaults reviewed by Root supplement the stored desired spec.
    keys(actual, [...Object.keys(desired), 'hostPID', 'hostIPC', 'shareProcessNamespace', 'nodeName',
      'dnsPolicy', 'schedulerName', 'initContainers', 'ephemeralContainers', 'serviceAccountName', 'serviceAccount',
      'enableServiceLinks', 'priority', 'preemptionPolicy'])
    for (const field of ['hostNetwork', 'hostPID', 'hostIPC', 'shareProcessNamespace']) {
      if (actual[field] !== undefined && actual[field] !== false) { conflict() }
    }
    if (actual.nodeName !== undefined) { inventoryName(actual.nodeName) }
    if (actual.dnsPolicy !== undefined && actual.dnsPolicy !== 'ClusterFirst' ||
        actual.schedulerName !== undefined && !['default-scheduler', 'gke.io/optimize-utilization-scheduler'].includes(String(actual.schedulerName)) ||
        actual.serviceAccountName !== undefined && actual.serviceAccountName !== 'default' ||
        actual.serviceAccount !== undefined && actual.serviceAccount !== 'default' ||
        actual.enableServiceLinks !== undefined && actual.enableServiceLinks !== true ||
        actual.priority !== undefined && actual.priority !== 0 ||
        actual.preemptionPolicy !== undefined && actual.preemptionPolicy !== 'PreemptLowerPriority') { conflict() }
    for (const field of ['initContainers', 'ephemeralContainers']) {
      if (actual[field] !== undefined && agentPodArray(actual[field]).length !== 0) { conflict() }
    }
    for (const field of Object.keys(desired)) {
      if (['hostNetwork', 'containers', 'volumes', 'tolerations'].includes(field)) { continue }
      if (!equal(actual[field], desired[field])) { conflict() }
    }
    tolerations(actual.tolerations, desired.tolerations)
    const actualContainers = agentPodArray(actual.containers), desiredContainers = agentPodArray(desired.containers)
    if (actualContainers.length !== 1 || desiredContainers.length !== 1) { conflict() }
    const container = inventoryRecord(actualContainers[0]), expectedContainer = inventoryRecord(desiredContainers[0])
    keys(container, [...Object.keys(expectedContainer), 'terminationMessagePath', 'terminationMessagePolicy', 'stdin', 'tty'])
    if (container.terminationMessagePath !== undefined && container.terminationMessagePath !== '/dev/termination-log' ||
        container.terminationMessagePolicy !== undefined && container.terminationMessagePolicy !== 'File' ||
        container.stdin !== undefined && container.stdin !== false || container.tty !== undefined && container.tty !== false) { conflict() }
    for (const field of Object.keys(expectedContainer)) {
      if (field === 'resources' || field === 'volumeMounts') { continue }
      if (!equal(container[field], expectedContainer[field])) { conflict() }
    }
    const mounts = agentPodArray(container.volumeMounts).map(normalizedMount)
    if (!equal(mounts, agentPodArray(expectedContainer.volumeMounts).map(normalizedMount)) ||
        !equal(agentPodArray(actual.volumes).map(normalizedVolume), agentPodArray(desired.volumes).map(normalizedVolume))) { conflict() }
    const admittedResources = resources(container.resources), desiredResources = resources(expectedContainer.resources)
    const admittedLimits = inventoryRecord(container.resources).limits
    if (admittedLimits !== undefined) {
      const limits = inventoryRecord(admittedLimits)
      if (limits.cpu !== undefined || limits.memory !== undefined) { conflict() }
    }
    return Object.freeze({ uid: listed.uid, resourceVersion: listed.resourceVersion, desiredResources, admittedResources })
  } catch { throw new AgentPodCreateError('POD_CONFLICT') }
}
