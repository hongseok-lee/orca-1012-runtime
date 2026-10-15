import type { EventEmitter } from 'node:events'
import type { ClientOptions } from 'ws'
import type { KubernetesPodAuthHttps } from '../runtime/kubernetes-pod-auth-types.ts'
import type { CanonicalCandidate } from './canonical.ts'

export type ManagedLeafCollectorCode = 'CONFIG_INVALID' | 'INPUT_INVALID' | 'CREDENTIAL_FAILED' |
  'ABORTED' | 'TIMEOUT' | 'HTTP_FAILED' | 'TLS_FAILED' | 'NETWORK_FAILED' | 'RESPONSE_INVALID' |
  'POD_IDENTITY' | 'PVC_IDENTITY' | 'PV_IDENTITY' | 'HELPER_IDENTITY' | 'POD_CHANGED' |
  'EXEC_PROTOCOL' | 'EXEC_FAILED' | 'OUTPUT_INVALID' | 'MOUNT_CHANGED'

/** Never retains a credential, URL, response, stderr, or underlying cause. */
export class ManagedLeafCollectorError extends Error {
  constructor(readonly code: ManagedLeafCollectorCode) {
    super(`MANAGED_LEAF_COLLECTOR_${code}`)
    this.name = 'ManagedLeafCollectorError'
  }
}

export type ManagedLeafCollectorConfig = Readonly<{
  apiOrigin: string; ca: Uint8Array; clusterIdentityRef: string
  backendId: string; exportId: string; namespace: string; dataset: string
  podName: string; podUid: string; containerName: string; imageDigest: string
  pvcName: string; pvcUid: string; pvName: string; pvUid: string
  csiDriver: string; volumeHandle: string
  helperConfigMapName: string; helperConfigMapUid: string; helperSha256: string; exportsSha256: string
  timeoutMs: number
  readReviewerBearer(this: ManagedLeafCollectorConfig, signal: AbortSignal): string | Promise<string>
}>

export type ManagedLeafSocket = EventEmitter & {
  readonly protocol: string
  terminate(): void
}
// Trusted composition dependency only. Public requests supply neither transport nor raw observations.
export type ManagedLeafCollectorDependencies = Readonly<{
  https: KubernetesPodAuthHttps
  openWebSocket(url: URL, protocol: 'v5.channel.k8s.io', options: ClientOptions): ManagedLeafSocket
}>
export type ManagedLeafPod = Readonly<{
  name: string; uid: string; nodeName: string; resourceVersion: string
  containerId: string; imageId: string; restartCount: number
  dataVolume: string; helperVolume: string; exportsVolume: string; exportsConfigMapName: string
}>
export type ManagedLeafStorage = Readonly<{
  pvc: Readonly<{ name: string; uid: string; resourceVersion: string }>
  pv: Readonly<{ name: string; uid: string; resourceVersion: string; csiDriver: string; volumeHandle: string }>
  helper: Readonly<{ name: string; uid: string; resourceVersion: string; sha256: string }>
}>
export type AuthenticatedManagedLeafObservation = Readonly<{
  kind: 'AUTHENTICATED_MANAGED_LEAF_OBSERVATION'
  clusterIdentityRef: string; namespace: string; dataset: string; leafId: string
  candidate: CanonicalCandidate; pod: ManagedLeafPod; finalPodResourceVersion: string
  storage: ManagedLeafStorage; observedAt: string; evidenceDigest: string; reference: string
  // This result provides no lifetime pin, StorageEvidenceAuthority, RO mount, or writer permission.
  namespacePin: false
}>
