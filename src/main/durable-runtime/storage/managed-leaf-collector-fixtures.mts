import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ClientOptions } from 'ws'
import { harness, deferred, reviewerToken } from '../runtime/kubernetes-pod-auth-fixtures.mts'
import type { Step } from '../runtime/kubernetes-pod-auth-fixtures.mts'
import { managedLeafInspectCommand } from './managed-leaf-collector-exec.ts'
import type { ManagedLeafCollectorConfig, ManagedLeafCollectorDependencies, ManagedLeafSocket } from './managed-leaf-collector-types.ts'

export { deferred, reviewerToken }
export const leafId = '00000000-0000-4000-8000-00000000000a'
export const helperSource = '#!/bin/sh\n# Synthetic inspect metadata source; never executed.\n'
export const helperSha256 = createHash('sha256').update(helperSource).digest('hex')
export const config = () => ({ apiOrigin: 'https://kubernetes.invalid:6443', ca: Buffer.from('fixture-ca'),
  clusterIdentityRef: 'fixture-cluster', backendId: 'fixture-backend', exportId: 'managed', namespace: 'orca-dev',
  dataset: 'fixture-dataset', podName: 'nfs-fixture', podUid: '00000000-0000-4000-8000-000000000001',
  containerName: 'unfs3', imageDigest: `sha256:${'a'.repeat(64)}`, pvcName: 'fixture-pvc', pvcUid: 'fixture-pvc-uid',
  pvName: 'fixture-pv', pvUid: 'fixture-pv-uid', csiDriver: 'pd.csi.storage.gke.io', volumeHandle: 'fixture-volume',
  helperConfigMapName: 'fixture-helper', helperConfigMapUid: 'fixture-helper-uid', helperSha256,
  exportsSha256: 'b'.repeat(64), timeoutMs: 5000,
  readReviewerBearer(this: ManagedLeafCollectorConfig, _signal: AbortSignal): string | Promise<string> { return reviewerToken },
})
export function pod(c = config()) {
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name: c.podName, uid: c.podUid, namespace: c.namespace,
    resourceVersion: '10', labels: { 'orca.dev/dataset': c.dataset }, annotations: {
      'orca.dev/exports-sha256': c.exportsSha256, 'orca.dev/managed-storage-sha256': c.helperSha256 } },
  spec: { nodeName: 'fixture-node', containers: [{ name: c.containerName, image: `registry.invalid/unfs@${c.imageDigest}`,
    env: [{ name: 'ORCA_NFS_POD_UID', valueFrom: { fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.uid' } } }],
    volumeMounts: [{ name: 'data', mountPath: '/exports' }, { name: 'data', mountPath: '/x', subPath: 'x' },
      { name: 'tools', mountPath: '/opt/orca-nfs-tools', readOnly: true },
      { name: 'exports', mountPath: '/etc/exports', readOnly: true, subPath: 'exports' }] }],
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: c.pvcName } },
      { name: 'tools', configMap: { name: c.helperConfigMapName, defaultMode: 0o444 } },
      { name: 'exports', configMap: { name: 'fixture-exports' } }] },
  status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{
    name: c.containerName, ready: true, restartCount: 0, state: { running: {} },
    containerID: 'containerd://fixture-container', imageID: `registry.invalid/unfs@${c.imageDigest}` }] } }
}
export function pvc(c = config()) {
  return { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: c.pvcName, uid: c.pvcUid,
    namespace: c.namespace, resourceVersion: '20', labels: { 'orca.dev/dataset': c.dataset } },
  spec: { volumeName: c.pvName }, status: { phase: 'Bound' } }
}
export function pv(c = config()) {
  return { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: c.pvName, uid: c.pvUid, resourceVersion: '30' },
    spec: { claimRef: { name: c.pvcName, uid: c.pvcUid, namespace: c.namespace },
      csi: { driver: c.csiDriver, volumeHandle: c.volumeHandle } }, status: { phase: 'Bound' } }
}
export function helper(c = config()) {
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: c.helperConfigMapName, uid: c.helperConfigMapUid,
    namespace: c.namespace, resourceVersion: '40', labels: { 'orca.dev/dataset': c.dataset } },
  immutable: true, binaryData: { 'managed_storage.sh': Buffer.from(helperSource).toString('base64') } }
}
export function rawOutput(c = config()): string {
  const info = '10 1 259:13 / /exports rw - ext4 /dev/disk rw\n11 1 0:22 / /run/관측 rw - tmpfs none rw'
  const directory = (path: string, inode: string, uid = 0, gid = 0, mode = '0755') =>
    ({ path, inode, device: '66317', uid, gid, mode })
  const raw = { schemaVersion: 1, kind: 'managed-nfs-namespace-raw', operation: 'inspect-leaf',
    dataset: c.dataset, leafId, podUid: c.podUid, created: false, createdPaths: [],
    backingRoot: directory('/exports', '100'), managedRoot: directory('/exports/runtime-domains', '200'),
    parent: directory(`/exports/runtime-domains/${c.dataset}`, '300'),
    leaf: directory(`/exports/runtime-domains/${c.dataset}/${leafId}`, '400', 1000, 1000, '0700') }
  return `ORCA_MANAGED_LEAF_1\nMOUNTINFO_BEFORE\n${info}\nHELPER_JSON\n${JSON.stringify(raw)}\nMOUNTINFO_AFTER\n${info}\nORCA_MANAGED_LEAF_END\n`
}
export class Socket extends EventEmitter implements ManagedLeafSocket {
  terminated = false
  closed = false
  constructor(readonly protocol = 'v5.channel.k8s.io') { super() }
  frame(channel: number, value: string | Uint8Array = '', binary = true): void {
    if (!this.closed) { this.emit('message', Buffer.concat([Buffer.from([channel]), Buffer.from(value)]), binary) }
  }
  end(code = 1000): void {
    if (this.closed || this.terminated) { return }
    this.closed = true; this.emit('close', code)
  }
  terminate(): void {
    if (this.closed || this.terminated) { return }
    this.terminated = true
    queueMicrotask(() => {
      if (this.closed) { return }
      this.emit('error', new Error('synthetic-private-transport-error'))
      this.closed = true; this.emit('close', 1006)
    })
  }
}
export function finish(socket: Socket, output: string): void {
  socket.frame(1, output); socket.frame(3, '{"status":"Success"}')
  for (const channel of [1, 2, 3]) { socket.frame(255, Buffer.from([channel])) }
  socket.end()
}
export function fixture(steps?: Step[], play?: (socket: Socket, output: string) => void, protocol?: string) {
  const configuration = config(), output = rawOutput(configuration)
  const api = harness(steps ?? [{ body: pod(configuration) }, { body: pvc(configuration) },
    { body: pv(configuration) }, { body: helper(configuration) }, { body: pod(configuration) }])
  const sockets: Socket[] = [], opened: { url: URL; protocol: string; options: ClientOptions }[] = []
  const dependencies: ManagedLeafCollectorDependencies = { https: api.transport,
    openWebSocket(url, negotiated, options) {
      const socket = new Socket(protocol); sockets.push(socket); opened.push({ url, protocol: negotiated, options })
      queueMicrotask(() => { socket.emit('open'); if (!socket.terminated) { (play ?? finish)(socket, output) } })
      return socket
    } }
  return { configuration, dependencies, api, sockets, opened, output, command: managedLeafInspectCommand,
    async assertCleanup() {
      await Promise.resolve()
      api.assertCleanup()
      for (const socket of sockets) {
        if (!socket.closed || socket.eventNames().length !== 0) { throw new Error('Owned socket was not cleaned') }
      }
    } }
}
