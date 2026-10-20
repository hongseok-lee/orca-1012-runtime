import { defaultPodAuthHttps, exchangePodAuth } from '../runtime/kubernetes-pod-auth-transport.ts'
import type { KubernetesPodAuthHttps } from '../runtime/kubernetes-pod-auth-types.ts'
import { agentPodUuid, captureAgentPodPolicy } from '../runtime/agent-pod-policy.ts'

type VolumeRecord = {
  kind?: string
  metadata?: { name?: string; namespace?: string; uid?: string; deletionTimestamp?: unknown; labels?: Record<string, string> }
  spec?: { volumeName?: string; storageClassName?: string; volumeMode?: string; accessModes?: unknown;
    capacity?: { storage?: string }; mountOptions?: string[]; persistentVolumeReclaimPolicy?: string;
    nfs?: { server?: string; path?: string; readOnly?: boolean }; claimRef?: { namespace?: string; name?: string; uid?: string };
    resources?: { requests?: { storage?: string } }; selector?: unknown; dataSource?: unknown; dataSourceRef?: unknown }
  status?: { phase?: string }
}
const object = (value: unknown): VolumeRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as VolumeRecord : {}
const fail = (): never => { throw new Error('UNIT_STORAGE_VOLUME_CONFLICT') }

/** Static NFS consumer volumes allocate no disk. Stable names plus exact reads
 * reconcile a lost CREATE response; existing resources are never patched or deleted.
 * This supplies mount identity only, never a storage writer grant. */
export async function ensureUnitStorageVolume(input: {
  apiOrigin: string; ca: Uint8Array; reviewer: string; policy: unknown;
  unitId: string; bindingId: string; template: Record<string, unknown>; signal: AbortSignal
}, transport: KubernetesPodAuthHttps = defaultPodAuthHttps): Promise<Record<string, unknown>> {
  const policy = captureAgentPodPolicy(input.policy), unitId = agentPodUuid(input.unitId)
  const bindingId = agentPodUuid(input.bindingId), template = input.template
  const name = `orca-home-${unitId}`, serverPath = `${policy.protectedExportRoot}/${unitId}`
  const claims = `/api/v1/namespaces/${encodeURIComponent(policy.namespace)}/persistentvolumeclaims`
  const volumes = '/api/v1/persistentvolumes'
  const exchange = (path: string, body?: unknown) => exchangePodAuth(transport, input.apiOrigin, input.ca,
    path, input.reviewer, body === undefined ? undefined : JSON.stringify(body), 'POD_NOT_FOUND', input.signal)
  const get = async (path: string): Promise<VolumeRecord | null> => {
    try { return object(await exchange(path)) } catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'POD_NOT_FOUND') { return null }
      throw error
    }
  }
  // Authenticate the configured deployment source before borrowing its capacity
  // and NFS mount options. Never copy credentials, owner refs or arbitrary spec.
  const sourceClaim = await get(`${claims}/${encodeURIComponent(String(template.claimName))}`)
  if (!sourceClaim || sourceClaim.metadata?.uid !== template.claimUid || !sourceClaim.spec?.volumeName) { fail() }
  const sourceVolume = await get(`${volumes}/${encodeURIComponent(sourceClaim.spec!.volumeName!)}`)
  if (!sourceVolume || sourceVolume.metadata?.uid !== template.pvUid || sourceVolume.metadata?.deletionTimestamp ||
      sourceClaim.metadata?.deletionTimestamp || sourceVolume.spec?.nfs?.server !== policy.nfsServer ||
      sourceVolume.spec?.nfs?.path !== template.serverPath || sourceVolume.spec?.claimRef?.uid !== template.claimUid ||
      sourceVolume.spec?.claimRef?.namespace !== policy.namespace || sourceVolume.spec?.claimRef?.name !== template.claimName ||
      !sourceVolume.spec?.capacity?.storage || !Array.isArray(sourceVolume.spec?.mountOptions)) { fail() }
  const storage = sourceVolume.spec!.capacity!.storage!, mountOptions = sourceVolume.spec!.mountOptions!
  const labels = { 'orca.dev/dataset': policy.dataset, 'orca.dev/runtime-unit': unitId }
  const pv = { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name, labels }, spec: {
    capacity: { storage }, accessModes: ['ReadWriteMany'], volumeMode: 'Filesystem', storageClassName: '',
    persistentVolumeReclaimPolicy: 'Retain', mountOptions,
    claimRef: { namespace: policy.namespace, name }, nfs: { server: policy.nfsServer, path: serverPath, readOnly: false }
  } }
  const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name, namespace: policy.namespace, labels }, spec: {
    accessModes: ['ReadWriteMany'], volumeMode: 'Filesystem', storageClassName: '', volumeName: name,
    resources: { requests: { storage } }
  } }
  const common = (v: VolumeRecord, kind: string) => {
    if (v.kind !== kind || v.metadata?.name !== name || !v.metadata?.uid || v.metadata?.deletionTimestamp ||
        v.metadata?.labels?.['orca.dev/dataset'] !== policy.dataset || v.metadata?.labels?.['orca.dev/runtime-unit'] !== unitId ||
        (kind === 'PersistentVolume' ? (v.spec?.storageClassName ?? '') !== '' : v.spec?.storageClassName !== '') || v.spec?.volumeMode !== 'Filesystem' ||
        JSON.stringify(v.spec?.accessModes) !== JSON.stringify(['ReadWriteMany'])) { fail() }
  }
  const checkVolume = (v: VolumeRecord) => {
    common(v, 'PersistentVolume')
    if (v.spec?.capacity?.storage !== storage || v.spec?.persistentVolumeReclaimPolicy !== 'Retain' ||
        v.spec?.nfs?.server !== policy.nfsServer || v.spec?.nfs?.path !== serverPath || v.spec?.nfs?.readOnly === true ||
        v.spec?.claimRef?.namespace !== policy.namespace || v.spec?.claimRef?.name !== name ||
        JSON.stringify(v.spec?.mountOptions) !== JSON.stringify(mountOptions) || v.status?.phase === 'Released' || v.status?.phase === 'Failed') { fail() }
  }
  const checkClaim = (v: VolumeRecord) => {
    common(v, 'PersistentVolumeClaim')
    if (v.metadata?.namespace !== policy.namespace || v.spec?.volumeName !== name || v.spec?.resources?.requests?.storage !== storage ||
        v.spec?.selector || v.spec?.dataSource || v.spec?.dataSourceRef || v.status?.phase === 'Lost') { fail() }
  }
  const ensure = async (collection: string, body: unknown, check: (v: VolumeRecord) => void) => {
    let value = await get(`${collection}/${name}`)
    if (!value) {
      try { value = object(await exchange(collection, body)) }
      catch (error) { value = await get(`${collection}/${name}`); if (!value) { throw error } }
    }
    check(value)
    return value
  }
  const volume = await ensure(volumes, pv, checkVolume), claim = await ensure(claims, pvc, checkClaim)
  // Binding may be asynchronous. Any existing UID reservation must match.
  if (volume.spec?.claimRef?.uid && volume.spec.claimRef.uid !== claim.metadata!.uid!) { fail() }
  return Object.freeze({ ...template, bindingId, leafId: unitId, claimName: name,
    claimUid: claim.metadata!.uid!, pvUid: volume.metadata!.uid!, serverPath })
}
