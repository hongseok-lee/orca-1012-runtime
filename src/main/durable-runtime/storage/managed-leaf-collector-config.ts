import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { inventoryName, inventoryNamespace, inventoryOpaque } from '../lifecycle/kubernetes-identity.ts'
import { ManagedLeafCollectorError } from './managed-leaf-collector-types.ts'
import type { ManagedLeafCollectorConfig } from './managed-leaf-collector-types.ts'

export function managedLeafUuid(value: string): string {
  if (typeof value !== 'string' || value.length !== 36) { throw new ManagedLeafCollectorError('INPUT_INVALID') }
  try { return logicalId('managed-leaf', value) }
  catch { throw new ManagedLeafCollectorError('INPUT_INVALID') }
}
export function captureManagedLeafConfig(caller: ManagedLeafCollectorConfig): ManagedLeafCollectorConfig {
  try {
    const apiOrigin = caller.apiOrigin, inputCa = caller.ca, readReviewerBearer = caller.readReviewerBearer
    const origin = new URL(apiOrigin), timeoutMs = caller.timeoutMs
    const input = {
      apiOrigin: origin.origin, ca: inputCa instanceof Uint8Array ? Buffer.from(inputCa) : Buffer.alloc(0),
      clusterIdentityRef: inventoryOpaque(caller.clusterIdentityRef), backendId: inventoryOpaque(caller.backendId),
      exportId: inventoryOpaque(caller.exportId), namespace: inventoryNamespace(inventoryOpaque(caller.namespace)),
      dataset: inventoryNamespace(inventoryOpaque(caller.dataset)),
      podName: inventoryName(inventoryOpaque(caller.podName)), podUid: managedLeafUuid(caller.podUid),
      containerName: inventoryNamespace(inventoryOpaque(caller.containerName)), imageDigest: inventoryOpaque(caller.imageDigest),
      pvcName: inventoryName(inventoryOpaque(caller.pvcName)), pvcUid: inventoryOpaque(caller.pvcUid),
      pvName: inventoryName(inventoryOpaque(caller.pvName)), pvUid: inventoryOpaque(caller.pvUid),
      csiDriver: inventoryName(inventoryOpaque(caller.csiDriver)), volumeHandle: inventoryOpaque(caller.volumeHandle),
      helperConfigMapName: inventoryName(inventoryOpaque(caller.helperConfigMapName)),
      helperConfigMapUid: inventoryOpaque(caller.helperConfigMapUid), helperSha256: inventoryOpaque(caller.helperSha256),
      exportsSha256: inventoryOpaque(caller.exportsSha256), timeoutMs, readReviewerBearer: readReviewerBearer.bind(caller),
    }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash ||
        origin.pathname !== '/' || (apiOrigin !== origin.origin && apiOrigin !== `${origin.origin}/`) ||
        input.ca.byteLength === 0 || typeof readReviewerBearer !== 'function' ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 ||
        !/^sha256:[0-9a-f]{64}$/.test(input.imageDigest) ||
        !/^[0-9a-f]{64}$/.test(input.helperSha256) || !/^[0-9a-f]{64}$/.test(input.exportsSha256)) {
      throw new ManagedLeafCollectorError('CONFIG_INVALID')
    }
    return Object.freeze(input)
  } catch { throw new ManagedLeafCollectorError('CONFIG_INVALID') }
}
