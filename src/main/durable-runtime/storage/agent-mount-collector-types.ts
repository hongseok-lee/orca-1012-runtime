import type { AgentPodPlanRecord } from '../db/agent-pod-plan-record-rows.ts'
import type { JsonValue } from '../db/atomic.ts'
import type { KubernetesPodAuthHttps } from '../runtime/kubernetes-pod-auth-types.ts'
import type { ManagedLeafSocket } from './managed-leaf-collector-types.ts'
import type { ClientOptions } from 'ws'

export type AgentMountCollectorCode = 'CONFIG_INVALID' | 'INPUT_INVALID' | 'CREDENTIAL_FAILED' |
  'ABORTED' | 'TIMEOUT' | 'HTTP_FAILED' | 'HTTP_FORBIDDEN' | 'TLS_FAILED' | 'NETWORK_FAILED' |
  'RESPONSE_INVALID' | 'POD_IDENTITY' | 'POD_CHANGED' | 'STORAGE_IDENTITY' | 'STORAGE_CHANGED' |
  'EXEC_PROTOCOL' | 'EXEC_FAILED' | 'OUTPUT_INVALID' | 'MOUNT_CHANGED' | 'MOUNT_MISMATCH'

/** Fixed codes only; never retains a bearer, URL, stderr, response or underlying cause. */
export class AgentMountCollectorError extends Error {
  constructor(readonly code: AgentMountCollectorCode) {
    super(`AGENT_MOUNT_COLLECTOR_${code}`)
    this.name = 'AgentMountCollectorError'
  }
}
export type AgentMountCollectorConfig = Readonly<{
  apiOrigin: string; ca: Uint8Array; namespace: string; dataset: string; timeoutMs: number
  readReviewerBearer(this: AgentMountCollectorConfig, signal: AbortSignal): string | Promise<string>
}>
export type AgentMountCollectorDependencies = Readonly<{
  https: KubernetesPodAuthHttps
  openWebSocket(url: URL, protocol: 'v5.channel.k8s.io', options: ClientOptions): ManagedLeafSocket
}>
export type AgentMountExpectation = Readonly<{
  kind: 'protected' | 'shared'; key: string; claimName: string; claimUid: string; pvUid: string
  server: string; serverPath: string; clientPath: string; mode: 'RO' | 'RW'
}>
export type AgentMountPodIncarnation = Readonly<{
  uid: string; name: string; resourceVersion: string; nodeName: string; containerName: string
  containerId: string; imageId: string; restartCount: number; startedAt: string
  admittedResources: JsonValue
}>
export type AgentMountStorage = Readonly<{
  expected: AgentMountExpectation
  pvc: Readonly<{ name: string; uid: string; resourceVersion: string; volumeName: string }>
  pv: Readonly<{ name: string; uid: string; resourceVersion: string; claimUid: string
    server: string; path: string; readOnly: boolean }>
}>
export type AgentMountClientStat = Readonly<{
  device: string; inode: string; uid: number; gid: number; mode: string
}>
export type AgentMountRootObservation = Readonly<{
  kind: 'protected' | 'shared'; key: string; clientPath: string; realPath: string
  mode: 'RO' | 'RW'; filesystem: 'nfs' | 'nfs4'; mountId: string; mountDevice: string
  nfsSource: string; serverPath: string; superMode: 'RO' | 'RW'; clientStat: AgentMountClientStat
}>
export type AuthenticatedAgentMountObservation = Readonly<{
  kind: 'AUTHENTICATED_AGENT_MOUNT_OBSERVATION'; namespace: string; dataset: string; planDigest: string
  pod: AgentMountPodIncarnation; finalPod: AgentMountPodIncarnation
  storage: readonly AgentMountStorage[]; finalStorage: readonly AgentMountStorage[]
  mounts: readonly AgentMountRootObservation[]; observedAt: string
  probeDigest: string; evidenceDigest: string; reference: string
  // Consumer namespace snapshots are neither server identity nor transaction-lifetime authority.
  namespacePin: false; writerGrantIssued: false; providerReady: false
}>
export type AgentMountCollect = (record: AgentPodPlanRecord, podUid: string, signal: AbortSignal) => Promise<AuthenticatedAgentMountObservation>
