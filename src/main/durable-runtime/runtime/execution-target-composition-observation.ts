import { createHash } from 'node:crypto'
import { inventoryName, inventoryOpaque, inventoryRecord } from '../lifecycle/kubernetes-identity.ts'
import { canonicalCreationUint64 } from './compute-creation-identity-input.ts'
import { auditTimestamp } from './compute-deletion-audit-input.ts'
import { identityEvidenceRef, type ExecutionTargetIdentityObservation } from './execution-target-identity-provenance.ts'
import type { ComputeCreationScope } from './compute-creation-identity-types.ts'
import type { ExecutionTargetObservation } from './execution-target-records.ts'
import type { EvidenceRef, Incarnation, NodeUid, PayloadHash, PodUid, RuntimeReference } from './runtime-evidence.ts'
import type { CapturedCompositionConfiguration, CapturedCompositionInput } from './execution-target-composition-input.ts'
import { ExecutionTargetCompositionError } from './execution-target-composition-types.ts'

/** Common actual scope needed by the projection; a previously authenticated
 * owned control supplies its safe expected tuple without exposing a Pod token. */
export type CompositionScopeInput = Omit<CapturedCompositionInput, 'pod'> & Readonly<{
  pod: Readonly<{ expected: CapturedCompositionInput['pod']['expected'] }>
}>

function digest(value: unknown): string {
  if (typeof value !== 'string' || /^[0-9a-f]{64}$/.exec(value)?.[0] !== value) {
    throw new Error('Invalid observation digest')
  }
  return value
}

export function captureCompositionPod(config: CapturedCompositionConfiguration,
  input: CompositionScopeInput, value: unknown) {
  try {
    const raw = inventoryRecord(value), expected = input.pod.expected
    const kind = raw.kind, clusterIdentityRef = raw.clusterIdentityRef
    const namespace = raw.namespace, dataset = raw.dataset, audience = raw.audience
    const sa = inventoryRecord(raw.serviceAccount), pod = inventoryRecord(raw.pod)
    const node = inventoryRecord(raw.node)
    const saName = sa.name, saUid = sa.uid
    const podName = pod.name, podUid = pod.uid
    const runtimeUnitId = pod.runtimeUnitId, operationId = pod.operationId
    const executionEpoch = pod.executionEpoch, specHash = pod.specHash
    const podResourceVersion = inventoryOpaque(pod.resourceVersion)
    const nodeName = inventoryName(node.name), nodeUid = inventoryOpaque(node.uid)
    const nodeResourceVersion = inventoryOpaque(node.resourceVersion)
    const source = node.observationSource, providerId = node.providerId, instanceId = node.instanceId
    const evidenceDigest = digest(raw.evidenceDigest)
    if (kind !== 'AUTHENTICATED_POD_OBSERVATION' || clusterIdentityRef !== config.clusterIdentityRef ||
        namespace !== config.namespace || dataset !== config.dataset || audience !== config.audience ||
        saName !== expected.serviceAccountName || saUid !== expected.serviceAccountUid ||
        podName !== expected.podName || podUid !== expected.podUid ||
        runtimeUnitId !== input.runtimeUnitId || operationId !== input.operationId ||
        executionEpoch !== input.executionEpoch || specHash !== expected.specHash ||
        (expected.nodeName !== undefined && nodeName !== expected.nodeName) ||
        (expected.nodeUid !== undefined && nodeUid !== expected.nodeUid)) {
      throw new Error('Mismatched Pod observation')
    }
    return Object.freeze({ podResourceVersion, nodeName, nodeUid, nodeResourceVersion,
      source, providerId, instanceId, evidenceDigest })
  } catch {
    throw new ExecutionTargetCompositionError('POD_OBSERVATION_INVALID')
  }
}
export type CapturedCompositionPod = ReturnType<typeof captureCompositionPod>

export function compositionComputeScope(config: CapturedCompositionConfiguration,
  pod: CapturedCompositionPod): ComputeCreationScope {
  try {
    if (pod.source !== 'KUBERNETES_API' || typeof pod.providerId !== 'string' ||
        typeof pod.instanceId !== 'string' || !canonicalCreationUint64(pod.instanceId)) {
      throw new Error('Missing Node identity')
    }
    const match = /^gce:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pod.providerId)
    if (!match || match[0] !== pod.providerId || match[1] !== config.projectId ||
        /^[a-z][a-z0-9-]{0,60}-[a-z]$/.exec(match[2])?.[0] !== match[2] ||
        /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.exec(match[3])?.[0] !== match[3]) {
      throw new Error('Invalid exact provider identity')
    }
    return Object.freeze({ projectId: config.projectId, projectNumber: config.projectNumber,
      zone: match[2], instanceName: match[3], numericInstanceId: pod.instanceId })
  } catch {
    throw new ExecutionTargetCompositionError('NODE_IDENTITY_INVALID')
  }
}

export function captureCompositionCreation(scope: ComputeCreationScope, value: unknown): ExecutionTargetIdentityObservation {
  try {
    const result = inventoryRecord(value)
    if (result.ok !== true) {
      throw new Error('Creation observation failed')
    }
    const observation = inventoryRecord(result.observation)
    const status = observation.status, source = observation.source
    const identity = inventoryRecord(observation.identity)
    const projectId = identity.projectId, projectNumber = identity.projectNumber
    const zone = identity.zone, instanceName = identity.instanceName, numericInstanceId = identity.numericInstanceId
    const evidenceDigest = digest(observation.evidenceDigest)
    const operationId = inventoryOpaque(observation.operationId)
    const first = inventoryRecord(observation.first), last = inventoryRecord(observation.last)
    const firstId = inventoryOpaque(first.insertId), lastId = inventoryOpaque(last.insertId)
    const firstTime = inventoryOpaque(first.timestamp), lastTime = inventoryOpaque(last.timestamp)
    const start = auditTimestamp(firstTime), end = auditTimestamp(lastTime)
    if (status !== 'CREATE_OPERATION_COMPLETED' || source !== 'CLOUD_AUDIT_LOGS' ||
        projectId !== scope.projectId || projectNumber !== scope.projectNumber || zone !== scope.zone ||
        instanceName !== scope.instanceName || numericInstanceId !== scope.numericInstanceId ||
        observation.producer !== 'compute.googleapis.com' || operationId.startsWith('node-identity:') ||
        firstId === 'node-identity' || lastId === 'node-identity' || start === null || end === null || start > end) {
      throw new Error('Creation identity not confirmed')
    }
    const evidence = { source, identity: { ...scope }, operationId, producer: observation.producer,
      first: { insertId: firstId, timestamp: firstTime }, last: { insertId: lastId, timestamp: lastTime } }
    if (createHash('sha256').update(JSON.stringify(evidence)).digest('hex') !== evidenceDigest) {
      throw new Error('Creation receipt digest mismatch')
    }
    return Object.freeze({ kind: 'CLOUD_AUDIT_CREATION_COMPLETED', evidenceDigest })
  } catch {
    throw new ExecutionTargetCompositionError('CREATION_NOT_CONFIRMED')
  }
}

/** Called only after captureCompositionPod and compositionComputeScope validated
 * the authenticated Pod/Node tuple. No Google operation, producer or time is inferred. */
export function captureCompositionNodeIdentity(pod: CapturedCompositionPod): ExecutionTargetIdentityObservation {
  return Object.freeze({ kind: 'AUTHENTICATED_KUBERNETES_NODE', evidenceDigest: pod.evidenceDigest })
}

export function compositionObservation(config: CapturedCompositionConfiguration,
  input: CompositionScopeInput, pod: CapturedCompositionPod,
  scope: ComputeCreationScope, identity: ExecutionTargetIdentityObservation): ExecutionTargetObservation {
  const computeIdentityRef = `gce-identity:sha256:${createHash('sha256').update(JSON.stringify([
    scope.projectNumber, scope.zone, scope.instanceName, scope.numericInstanceId
  ])).digest('hex')}` as RuntimeReference<'compute-identity'>
  const observedAt = new Date().toISOString()
  const kubernetesEvidenceRef = `kubernetes-pod-auth:sha256:${pod.evidenceDigest}` as EvidenceRef
  const computeIdentityEvidenceRef = identityEvidenceRef(identity) as EvidenceRef
  const fields = {
    attemptId: input.attemptId, runtimeUnitId: input.runtimeUnitId, executionEpoch: input.executionEpoch,
    podUid: input.pod.expected.podUid as PodUid, incarnation: input.incarnation as Incarnation,
    clusterIdentityRef: config.clusterIdentityRef as RuntimeReference<'cluster-identity'>,
    namespace: config.namespace, podName: input.pod.expected.podName,
    podResourceVersion: pod.podResourceVersion, nodeName: pod.nodeName, nodeUid: pod.nodeUid as NodeUid,
    nodeResourceVersion: pod.nodeResourceVersion, projectId: scope.projectId, projectNumber: scope.projectNumber,
    zone: scope.zone, instanceName: scope.instanceName, numericInstanceId: scope.numericInstanceId,
    computeIdentityRef, observedAt, kubernetesEvidenceRef, computeIdentityEvidenceRef
  }
  const observationDigest = createHash('sha256').update(JSON.stringify([
    'execution-target-observation-v1', fields.attemptId, fields.runtimeUnitId, fields.executionEpoch,
    fields.podUid, fields.incarnation, fields.clusterIdentityRef, fields.namespace, fields.podName,
    fields.podResourceVersion, fields.nodeName, fields.nodeUid, fields.nodeResourceVersion,
    fields.projectId, fields.projectNumber, fields.zone, fields.instanceName, fields.numericInstanceId,
    fields.computeIdentityRef, fields.observedAt, fields.kubernetesEvidenceRef, fields.computeIdentityEvidenceRef
  ])).digest('hex') as PayloadHash
  return Object.freeze({ ...fields, observationDigest })
}
