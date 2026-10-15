import { inventoryName, inventoryOpaque, inventoryRecord } from '../lifecycle/kubernetes-identity.ts'
import { ManagedLeafCollectorError } from './managed-leaf-collector-types.ts'
import type { ManagedLeafCollectorConfig, ManagedLeafPod } from './managed-leaf-collector-types.ts'

export function managedLeafRecord(value: unknown): Record<string, unknown> { return inventoryRecord(value) }
export function managedLeafList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) { throw new ManagedLeafCollectorError('RESPONSE_INVALID') }
  return value.map(managedLeafRecord)
}
export function managedLeafSingle(rows: Record<string, unknown>[], key: string, expected: string): Record<string, unknown> {
  const matches = rows.filter(row => row[key] === expected)
  if (matches.length !== 1) { throw new ManagedLeafCollectorError('RESPONSE_INVALID') }
  return matches[0]
}
export function managedLeafMetadata(raw: Record<string, unknown>, kind: string, name: string, uid: string,
  config: ManagedLeafCollectorConfig, namespaced = true): Record<string, unknown> {
  const metadata = managedLeafRecord(raw.metadata)
  if (raw.apiVersion !== 'v1' || raw.kind !== kind || metadata.name !== name || metadata.uid !== uid ||
      (metadata.deletionTimestamp !== undefined && metadata.deletionTimestamp !== null) ||
      (namespaced && metadata.namespace !== config.namespace)) { throw new ManagedLeafCollectorError('RESPONSE_INVALID') }
  inventoryOpaque(metadata.resourceVersion)
  return metadata
}
export function projectManagedLeafPod(value: unknown, config: ManagedLeafCollectorConfig): ManagedLeafPod {
  try {
    const raw = managedLeafRecord(value), metadata = managedLeafMetadata(raw, 'Pod', config.podName, config.podUid, config)
    const labels = managedLeafRecord(metadata.labels), annotations = managedLeafRecord(metadata.annotations)
    if (labels['orca.dev/dataset'] !== config.dataset || annotations['orca.dev/exports-sha256'] !== config.exportsSha256 ||
        annotations['orca.dev/managed-storage-sha256'] !== config.helperSha256) { throw new Error('Identity') }
    const spec = managedLeafRecord(raw.spec), status = managedLeafRecord(raw.status)
    const container = managedLeafSingle(managedLeafList(spec.containers), 'name', config.containerName)
    const running = managedLeafSingle(managedLeafList(status.containerStatuses), 'name', config.containerName)
    const ready = managedLeafSingle(managedLeafList(status.conditions), 'type', 'Ready')
    if (status.phase !== 'Running' || ready.status !== 'True' || running.ready !== true ||
        !Number.isSafeInteger(running.restartCount) || typeof running.restartCount !== 'number' || running.restartCount < 0 ||
        !managedLeafRecord(running.state).running || typeof container.image !== 'string' ||
        !container.image.endsWith(`@${config.imageDigest}`)) { throw new Error('Identity') }
    const imageId = inventoryOpaque(running.imageID)
    if (imageId !== config.imageDigest && !imageId.endsWith(`@${config.imageDigest}`)) { throw new Error('Identity') }
    const mounts = managedLeafList(container.volumeMounts), volumes = managedLeafList(spec.volumes)
    const data = managedLeafSingle(mounts, 'mountPath', '/exports')
    const helper = managedLeafSingle(mounts, 'mountPath', '/opt/orca-nfs-tools')
    const exports = managedLeafSingle(mounts, 'mountPath', '/etc/exports')
    if (data.readOnly === true || data.subPath !== undefined || data.subPathExpr !== undefined ||
        helper.readOnly !== true || helper.subPath !== undefined || helper.subPathExpr !== undefined ||
        exports.readOnly !== true || exports.subPath !== 'exports' || exports.subPathExpr !== undefined) { throw new Error('Mount') }
    for (const mount of mounts) {
      if (mount === data || mount === helper || mount === exports) { continue }
      const mountPath = mount.mountPath
      if (typeof mountPath !== 'string' || mountPath === '/' ||
          ['/exports', '/opt/orca-nfs-tools', '/etc/exports'].some(protectedPath =>
            mountPath === protectedPath || mountPath.startsWith(`${protectedPath}/`) ||
            protectedPath.startsWith(`${mountPath}/`))) { throw new Error('Mount') }
    }
    const dataVolume = inventoryOpaque(data.name), helperVolume = inventoryOpaque(helper.name), exportsVolume = inventoryOpaque(exports.name)
    const dataSource = managedLeafRecord(managedLeafSingle(volumes, 'name', dataVolume).persistentVolumeClaim)
    const helperSource = managedLeafRecord(managedLeafSingle(volumes, 'name', helperVolume).configMap)
    const exportsSource = managedLeafRecord(managedLeafSingle(volumes, 'name', exportsVolume).configMap)
    if (dataSource.claimName !== config.pvcName || dataSource.readOnly === true ||
        helperSource.name !== config.helperConfigMapName || helperSource.defaultMode !== 0o444 || helperSource.items !== undefined) {
      throw new Error('Volume')
    }
    const uidEnv = managedLeafSingle(managedLeafList(container.env), 'name', 'ORCA_NFS_POD_UID')
    const field = managedLeafRecord(managedLeafRecord(uidEnv.valueFrom).fieldRef)
    if (uidEnv.value !== undefined || field.fieldPath !== 'metadata.uid' ||
        (field.apiVersion !== undefined && field.apiVersion !== 'v1')) { throw new Error('Environment') }
    return Object.freeze({ name: config.podName, uid: config.podUid,
      nodeName: inventoryName(spec.nodeName), resourceVersion: inventoryOpaque(metadata.resourceVersion),
      containerId: inventoryOpaque(running.containerID), imageId, restartCount: running.restartCount,
      dataVolume, helperVolume, exportsVolume, exportsConfigMapName: inventoryName(exportsSource.name) })
  } catch { throw new ManagedLeafCollectorError('POD_IDENTITY') }
}
export function managedLeafPodIncarnation(pod: ManagedLeafPod): string {
  const { resourceVersion: _resourceVersion, ...identity } = pod
  return JSON.stringify(identity)
}
