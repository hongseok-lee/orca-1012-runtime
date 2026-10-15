import { createHash } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { inventoryName, inventoryOpaque, inventoryPod, inventoryRecord } from '../lifecycle/kubernetes-identity.ts'
import { KubernetesPodAuthError } from './kubernetes-pod-auth-types.ts'
import type { AuthenticatedPodObservation, KubernetesPodAuthConfig, KubernetesPodAuthExpected,
  KubernetesPodAuthInput } from './kubernetes-pod-auth-types.ts'

type Claims = Readonly<{ nodeName: string; nodeUid: string }>

export function capturePodAuthInput(input: KubernetesPodAuthInput): KubernetesPodAuthInput {
  try {
    const source = input.expected
    const expected = Object.freeze({ serviceAccountName: inventoryName(source.serviceAccountName),
      serviceAccountUid: inventoryOpaque(source.serviceAccountUid), podName: inventoryName(source.podName),
      podUid: inventoryOpaque(source.podUid), runtimeUnitId: inventoryOpaque(source.runtimeUnitId),
      operationId: inventoryOpaque(source.operationId), executionEpoch: inventoryOpaque(source.executionEpoch),
      specHash: inventoryOpaque(source.specHash), nodeName: source.nodeName, nodeUid: source.nodeUid })
    logicalId('runtime-unit', expected.runtimeUnitId)
    logicalId('operation', expected.operationId)
    counter('execution-epoch', expected.executionEpoch)
    if (!/^[0-9a-f]{64}$/u.test(expected.specHash) || !bearerValid(input.podBearer)) { throw new Error('Invalid input') }
    if (expected.nodeName !== undefined || expected.nodeUid !== undefined) {
      inventoryName(expected.nodeName)
      inventoryOpaque(expected.nodeUid)
    }
    return Object.freeze({ podBearer: input.podBearer, expected })
  } catch { throw new KubernetesPodAuthError('INPUT_INVALID') }
}
export function bearerValid(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9\-._~+/]+=*$/u.test(value)
}
function singleClaim(extra: Record<string, unknown>, name: string): string {
  const values = extra[`authentication.kubernetes.io/${name}`]
  if (!Array.isArray(values) || values.length !== 1) { throw new KubernetesPodAuthError('TOKEN_REVIEW_INVALID') }
  return inventoryOpaque(values[0])
}
export function projectTokenReview(raw: unknown, config: Readonly<KubernetesPodAuthConfig>,
  expected: KubernetesPodAuthExpected): Claims {
  try {
    const review = inventoryRecord(raw)
    if (review.apiVersion !== 'authentication.k8s.io/v1' || review.kind !== 'TokenReview') {
      throw new KubernetesPodAuthError('TOKEN_REVIEW_INVALID')
    }
    const status = inventoryRecord(review.status)
    if (status.authenticated !== true || (status.error !== undefined && status.error !== '')) {
      throw new KubernetesPodAuthError('AUTHENTICATION_DENIED')
    }
    if (!Array.isArray(status.audiences) || !status.audiences.every(a => typeof a === 'string') ||
        !status.audiences.includes(config.audience)) { throw new KubernetesPodAuthError('AUDIENCE_MISMATCH') }
    const user = inventoryRecord(status.user)
    if (user.username !== `system:serviceaccount:${config.namespace}:${expected.serviceAccountName}` ||
        user.uid !== expected.serviceAccountUid) { throw new KubernetesPodAuthError('SERVICE_ACCOUNT_MISMATCH') }
    const extra = inventoryRecord(user.extra)
    const podName = singleClaim(extra, 'pod-name'), podUid = singleClaim(extra, 'pod-uid')
    const nodeName = inventoryName(singleClaim(extra, 'node-name')), nodeUid = singleClaim(extra, 'node-uid')
    if (podName !== expected.podName || podUid !== expected.podUid) { throw new KubernetesPodAuthError('POD_IDENTITY_MISMATCH') }
    if ((expected.nodeName !== undefined && expected.nodeName !== nodeName) ||
        (expected.nodeUid !== undefined && expected.nodeUid !== nodeUid)) {
      throw new KubernetesPodAuthError('NODE_IDENTITY_MISMATCH')
    }
    return Object.freeze({ nodeName, nodeUid })
  } catch (error) {
    throw error instanceof KubernetesPodAuthError ? error : new KubernetesPodAuthError('TOKEN_REVIEW_INVALID')
  }
}
export function projectAuthenticatedPod(raw: unknown, config: Readonly<KubernetesPodAuthConfig>,
  expected: KubernetesPodAuthExpected, claims: Claims): AuthenticatedPodObservation['pod'] {
  try {
    const resource = inventoryPod(raw, config.namespace, config.dataset, expected.podName)
    const object = inventoryRecord(raw), metadata = inventoryRecord(object.metadata), spec = inventoryRecord(object.spec)
    if (metadata.deletionTimestamp !== undefined && metadata.deletionTimestamp !== null) {
      throw new KubernetesPodAuthError('RESOURCE_DELETING')
    }
    if (resource.uid !== expected.podUid || resource.unitId !== expected.runtimeUnitId ||
        resource.operationId !== expected.operationId || resource.executionEpoch !== expected.executionEpoch ||
        resource.specHash !== expected.specHash || spec.serviceAccountName !== expected.serviceAccountName ||
        spec.nodeName !== claims.nodeName) { throw new KubernetesPodAuthError('POD_IDENTITY_MISMATCH') }
    return Object.freeze({ name: resource.name, uid: resource.uid, resourceVersion: resource.resourceVersion,
      runtimeUnitId: resource.unitId, operationId: resource.operationId, executionEpoch: resource.executionEpoch,
      specHash: resource.specHash })
  } catch (error) {
    throw error instanceof KubernetesPodAuthError ? error : new KubernetesPodAuthError('POD_IDENTITY_MISMATCH')
  }
}
export function projectAuthenticatedNode(raw: unknown, claims: Claims): AuthenticatedPodObservation['node'] {
  try {
    const node = inventoryRecord(raw), metadata = inventoryRecord(node.metadata)
    if (node.apiVersion !== 'v1' || node.kind !== 'Node' || inventoryName(metadata.name) !== claims.nodeName ||
        inventoryOpaque(metadata.uid) !== claims.nodeUid) { throw new KubernetesPodAuthError('NODE_IDENTITY_MISMATCH') }
    if (metadata.deletionTimestamp !== undefined && metadata.deletionTimestamp !== null) {
      throw new KubernetesPodAuthError('RESOURCE_DELETING')
    }
    const resourceVersion = inventoryOpaque(metadata.resourceVersion)
    const providerId = node.spec === undefined ? undefined : inventoryRecord(node.spec).providerID
    const instanceId = metadata.annotations === undefined ? undefined :
      inventoryRecord(metadata.annotations)['container.googleapis.com/instance_id']
    return Object.freeze({ name: claims.nodeName, uid: claims.nodeUid, resourceVersion,
      observationSource: 'KUBERNETES_API',
      ...(providerId === undefined ? {} : { providerId: inventoryOpaque(providerId) }),
      ...(instanceId === undefined ? {} : { instanceId: inventoryOpaque(instanceId) }) })
  } catch (error) {
    throw error instanceof KubernetesPodAuthError ? error : new KubernetesPodAuthError('NODE_IDENTITY_MISMATCH')
  }
}
export function authenticatedPodObservation(config: Readonly<KubernetesPodAuthConfig>, expected: KubernetesPodAuthExpected,
  pod: AuthenticatedPodObservation['pod'], node: AuthenticatedPodObservation['node']): AuthenticatedPodObservation {
  const projection = { kind: 'AUTHENTICATED_POD_OBSERVATION' as const, clusterIdentityRef: config.clusterIdentityRef,
    namespace: config.namespace, dataset: config.dataset, audience: config.audience,
    serviceAccount: Object.freeze({ name: expected.serviceAccountName, uid: expected.serviceAccountUid }), pod, node }
  const evidenceDigest = createHash('sha256').update(JSON.stringify(projection)).digest('hex')
  return Object.freeze({ ...projection, evidenceDigest })
}
