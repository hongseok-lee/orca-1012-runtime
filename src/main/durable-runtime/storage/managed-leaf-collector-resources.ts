import { createHash } from 'node:crypto'
import { inventoryOpaque } from '../lifecycle/kubernetes-identity.ts'
import { managedLeafMetadata, managedLeafRecord } from './managed-leaf-collector-pod.ts'
import { ManagedLeafCollectorError } from './managed-leaf-collector-types.ts'
import type { ManagedLeafCollectorConfig, ManagedLeafStorage } from './managed-leaf-collector-types.ts'

export function projectManagedLeafStorage(pvcValue: unknown, pvValue: unknown, helperValue: unknown,
  config: ManagedLeafCollectorConfig): ManagedLeafStorage {
  let pvc: ManagedLeafStorage['pvc'], pv: ManagedLeafStorage['pv'], helper: ManagedLeafStorage['helper']
  try {
    const raw = managedLeafRecord(pvcValue), metadata = managedLeafMetadata(raw, 'PersistentVolumeClaim', config.pvcName, config.pvcUid, config)
    if (managedLeafRecord(metadata.labels)['orca.dev/dataset'] !== config.dataset ||
        managedLeafRecord(raw.spec).volumeName !== config.pvName || managedLeafRecord(raw.status).phase !== 'Bound') { throw new Error('Claim') }
    pvc = Object.freeze({ name: config.pvcName, uid: config.pvcUid, resourceVersion: inventoryOpaque(metadata.resourceVersion) })
  } catch { throw new ManagedLeafCollectorError('PVC_IDENTITY') }
  try {
    const raw = managedLeafRecord(pvValue), metadata = managedLeafMetadata(raw, 'PersistentVolume', config.pvName, config.pvUid, config, false)
    const spec = managedLeafRecord(raw.spec), claim = managedLeafRecord(spec.claimRef), csi = managedLeafRecord(spec.csi)
    if (claim.name !== config.pvcName || claim.uid !== config.pvcUid || claim.namespace !== config.namespace ||
        csi.driver !== config.csiDriver || csi.volumeHandle !== config.volumeHandle ||
        managedLeafRecord(raw.status).phase !== 'Bound') { throw new Error('Volume') }
    pv = Object.freeze({ name: config.pvName, uid: config.pvUid, resourceVersion: inventoryOpaque(metadata.resourceVersion),
      csiDriver: config.csiDriver, volumeHandle: config.volumeHandle })
  } catch { throw new ManagedLeafCollectorError('PV_IDENTITY') }
  try {
    const raw = managedLeafRecord(helperValue), metadata = managedLeafMetadata(raw, 'ConfigMap', config.helperConfigMapName, config.helperConfigMapUid, config)
    if (raw.immutable !== true || managedLeafRecord(metadata.labels)['orca.dev/dataset'] !== config.dataset) { throw new Error('Helper') }
    let bytes: Buffer
    if (raw.data !== undefined) {
      const data = managedLeafRecord(raw.data)
      if (raw.binaryData !== undefined || Object.keys(data).length !== 1 || typeof data['managed_storage.sh'] !== 'string') { throw new Error('Helper') }
      bytes = Buffer.from(data['managed_storage.sh'])
    } else {
      const data = managedLeafRecord(raw.binaryData), encoded = data['managed_storage.sh']
      if (Object.keys(data).length !== 1 || typeof encoded !== 'string') { throw new Error('Helper') }
      bytes = Buffer.from(encoded, 'base64')
      if (bytes.toString('base64') !== encoded) { throw new Error('Helper') }
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== config.helperSha256) { throw new Error('Helper') }
    helper = Object.freeze({ name: config.helperConfigMapName, uid: config.helperConfigMapUid,
      resourceVersion: inventoryOpaque(metadata.resourceVersion), sha256 })
  } catch { throw new ManagedLeafCollectorError('HELPER_IDENTITY') }
  return Object.freeze({ pvc, pv, helper })
}
