import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { inventoryDataset, inventoryNamespace, inventoryOpaque } from '../lifecycle/kubernetes-identity.ts'
import { auditTimestamp } from './compute-deletion-audit-input.ts'
import { capturePodAuthInput } from './kubernetes-pod-auth-projection.ts'
import type { KubernetesPodAuthInput } from './kubernetes-pod-auth-types.ts'
import type { GatewayContext } from './gateway/types.ts'
import type { ExecutionTargetCompositionConfiguration, ExecutionTargetPrepareInput } from './execution-target-composition-types.ts'
import { ExecutionTargetCompositionError } from './execution-target-composition-types.ts'

export type CapturedCompositionConfiguration = Readonly<{
  clusterIdentityRef: string; namespace: string; dataset: string; audience: string
  projectId: string; projectNumber: string; timeoutMs: number
  authenticatePod: ExecutionTargetCompositionConfiguration['podAuthenticator']['authenticatePod']
  observeCreation: ExecutionTargetCompositionConfiguration['creationObserver']['observe']
}>

export function captureCompositionConfiguration(
  original: ExecutionTargetCompositionConfiguration
): CapturedCompositionConfiguration {
  try {
    const clusterIdentityRef = inventoryOpaque(original.clusterIdentityRef)
    const namespace = inventoryNamespace(inventoryOpaque(original.namespace))
    const dataset = inventoryDataset(inventoryOpaque(original.dataset))
    const audience = inventoryOpaque(original.audience)
    const projectId = inventoryOpaque(original.projectId)
    const projectNumber = inventoryOpaque(original.projectNumber)
    const timeoutMs = original.timeoutMs
    const pod = original.podAuthenticator, creation = original.creationObserver
    const authenticatePod = pod.authenticatePod, observeCreation = creation.observe
    if (/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.exec(projectId)?.[0] !== projectId ||
        /^[1-9][0-9]*$/.exec(projectNumber)?.[0] !== projectNumber ||
        !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
        typeof authenticatePod !== 'function' || typeof observeCreation !== 'function') {
      throw new ExecutionTargetCompositionError('CONFIG_INVALID')
    }
    return Object.freeze({ clusterIdentityRef, namespace, dataset, audience, projectId,
      projectNumber, timeoutMs, authenticatePod: authenticatePod.bind(pod),
      observeCreation: observeCreation.bind(creation) })
  } catch {
    throw new ExecutionTargetCompositionError('CONFIG_INVALID')
  }
}

export function captureCompositionInput(original: ExecutionTargetPrepareInput) {
  try {
    const attemptId = logicalId('attempt', inventoryOpaque(original.attemptId))
    const incarnation = inventoryOpaque(original.incarnation)
    const source = original.expected
    const expected = Object.freeze({
      serviceAccountName: inventoryOpaque(source.serviceAccountName),
      serviceAccountUid: inventoryOpaque(source.serviceAccountUid),
      podName: inventoryOpaque(source.podName), podUid: inventoryOpaque(source.podUid),
      runtimeUnitId: inventoryOpaque(source.runtimeUnitId),
      operationId: inventoryOpaque(source.operationId), executionEpoch: inventoryOpaque(source.executionEpoch),
      specHash: inventoryOpaque(source.specHash), nodeName: source.nodeName, nodeUid: source.nodeUid
    })
    const podBearer = inventoryOpaque(original.podBearer)
    const startTime = inventoryOpaque(original.creationStartTime)
    const endTime = inventoryOpaque(original.creationEndTime)
    const start = auditTimestamp(startTime), end = auditTimestamp(endTime)
    if (start === null || end === null || start > end) {
      throw new ExecutionTargetCompositionError('INPUT_INVALID')
    }
    // The existing validator only sees our plain snapshot, never the caller's getters.
    const pod: KubernetesPodAuthInput = capturePodAuthInput({ podBearer, expected })
    const runtimeUnitId = logicalId('runtime-unit', expected.runtimeUnitId)
    const operationId = logicalId('operation', expected.operationId)
    const executionEpoch = counter('execution-epoch', expected.executionEpoch)
    return Object.freeze({ attemptId, incarnation, runtimeUnitId, operationId,
      executionEpoch, pod, startTime, endTime })
  } catch {
    throw new ExecutionTargetCompositionError('INPUT_INVALID')
  }
}
export type CapturedCompositionInput = ReturnType<typeof captureCompositionInput>

export function captureCompositionContext(original: GatewayContext): GatewayContext {
  try {
    const runtimeUnitId = logicalId('runtime-unit', inventoryOpaque(original.runtimeUnitId))
    const operationId = logicalId('operation', inventoryOpaque(original.operationId))
    const controller = original.controller
    const scope = inventoryOpaque(controller.scope), owner = inventoryOpaque(controller.owner)
    const term = counter('controller-term', inventoryOpaque(controller.term))
    // Snapshot only the existing trusted context's validated scalars. This type
    // conversion neither authenticates a new controller nor issues a new brand.
    return Object.freeze({ runtimeUnitId, operationId,
      controller: Object.freeze({ scope, owner, term }) as GatewayContext['controller'] })
  } catch {
    throw new ExecutionTargetCompositionError('CONTEXT_INVALID')
  }
}
