import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { ListedResource } from './watch.ts'

export type KubernetesInventoryErrorCode = 'CONFIG_INVALID' | 'IDENTITY_INVALID' | 'JSON_INVALID' |
  'HTTP_FAILED' | 'CONNECTION_FAILED' | 'TOKEN_FAILED' | 'ABORTED' | 'REQUEST_TIMEOUT' |
  'LIST_VERSION_CHANGED' | 'CONTINUE_REPEATED' | 'WATCH_FAILED'

/** Carries no URL, response body, underlying error, or credential. */
export class KubernetesInventoryError extends Error {
  readonly code: KubernetesInventoryErrorCode
  constructor(code: KubernetesInventoryErrorCode) {
    super(`KUBERNETES_INVENTORY_${code}`)
    this.name = 'KubernetesInventoryError'
    this.code = code
  }
}

export function inventoryRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KubernetesInventoryError('IDENTITY_INVALID')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON object shape checked above; fields remain unknown.
  return value as Record<string, unknown>
}

/** Kubernetes UID/RV are opaque strings, never arithmetic counters. */
export function inventoryOpaque(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new KubernetesInventoryError('IDENTITY_INVALID')
  }
  return value
}

export function inventoryNamespace(value: unknown): string {
  if (typeof value !== 'string' || value.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u.test(value)) {
    throw new KubernetesInventoryError('IDENTITY_INVALID')
  }
  return value
}

export function inventoryName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 253) {
    throw new KubernetesInventoryError('IDENTITY_INVALID')
  }
  for (const label of value.split('.')) { inventoryNamespace(label) }
  return value
}

export function inventoryDataset(value: unknown): string {
  if (typeof value !== 'string' || value.length > 63 || !/^[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/u.test(value)) {
    throw new KubernetesInventoryError('IDENTITY_INVALID')
  }
  return value
}

export function inventoryPod(value: unknown, namespace: string, dataset: string, expectedName?: string): ListedResource {
  try {
    const pod = inventoryRecord(value)
    if (pod.apiVersion !== 'v1' || pod.kind !== 'Pod') { throw new KubernetesInventoryError('IDENTITY_INVALID') }
    const metadata = inventoryRecord(pod.metadata)
    const labels = inventoryRecord(metadata.labels), annotations = inventoryRecord(metadata.annotations)
    const name = inventoryName(metadata.name)
    if (inventoryNamespace(metadata.namespace) !== namespace || (expectedName !== undefined && name !== expectedName) ||
        labels['orca.dev/role'] !== 'runtime-agent' || labels['orca.dev/dataset'] !== dataset) {
      throw new KubernetesInventoryError('IDENTITY_INVALID')
    }
    const unitId = inventoryOpaque(labels['orca.dev/runtime-unit'])
    const operationId = inventoryOpaque(annotations['orca.dev/operation-id'])
    logicalId('runtime-unit', unitId)
    logicalId('operation', operationId)
    const executionEpoch = inventoryOpaque(annotations['orca.dev/execution-epoch'])
    counter('execution-epoch', executionEpoch)
    const specHash = inventoryOpaque(annotations['orca.dev/spec-hash'])
    if (!/^[0-9a-f]{64}$/u.test(specHash)) { throw new KubernetesInventoryError('IDENTITY_INVALID') }
    return Object.freeze({ namespace, name, uid: inventoryOpaque(metadata.uid),
      resourceVersion: inventoryOpaque(metadata.resourceVersion), unitId, operationId, executionEpoch, specHash })
  } catch {
    throw new KubernetesInventoryError('IDENTITY_INVALID')
  }
}
