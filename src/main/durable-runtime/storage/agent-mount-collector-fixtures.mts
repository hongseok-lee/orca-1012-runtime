import { createHash } from 'node:crypto'
import type { ClientOptions } from 'ws'
import { canonicalInput } from '../runtime/gateway/input.ts'
import { createAgentPodPlanner } from '../runtime/agent-pod-plan.ts'
import { harness, reviewerToken } from '../runtime/kubernetes-pod-auth-fixtures.mts'
import type { Step } from '../runtime/kubernetes-pod-auth-fixtures.mts'
import { Socket, finish } from './managed-leaf-collector-fixtures.mts'
import type { AgentMountCollectorConfig, AgentMountCollectorDependencies } from './agent-mount-collector-types.ts'

export { Socket, finish, reviewerToken }
export const uuid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
export const config = (): AgentMountCollectorConfig => ({ apiOrigin: 'https://kubernetes.invalid:6443', ca: Buffer.from('fixture-ca'),
  namespace: 'agent-fixture', dataset: 'dataset-fixture', timeoutMs: 1000, readReviewerBearer: () => reviewerToken })
export function original(mode: 'RO' | 'RW' = 'RO', multiple = false) {
  const policy = { namespace: 'agent-fixture', dataset: 'dataset-fixture', image: `example.invalid/agent@sha256:${'1'.repeat(64)}`,
    entrypoint: { command: ['/opt/agent/entrypoint'], args: ['--resume-mode', 'cold'] },
    paths: { home: '/agent/home', claudeState: '/agent/home/.claude', codexState: '/agent/home/.codex', checkout: '/agent/project' },
    protectedMounts: multiple ? [{ key: 'home', clientPath: '/agent/home' }, { key: 'project', clientPath: '/agent/project' }] : [{ key: 'main', clientPath: '/agent' }],
    nfsServer: 'nfs.fixture.svc.cluster.local', protectedExportRoot: '/exports/runtime-domains/dataset-fixture',
    shared: { claimName: 'shared-fixture', claimUid: 'shared-claim-opaque', pvUid: 'shared-pv-opaque', serverPath: '/exports/shared/dataset-fixture' } }
  const binding = (n: number, key: string, bindingMode: 'RO' | 'RW') => ({ key, bindingId: uuid(n + 30), leafId: uuid(n + 40),
    claimName: `protected-${n}`, claimUid: `protected-claim-${n}`, pvUid: `protected-pv-${n}`,
    serverPath: `/exports/runtime-domains/dataset-fixture/${uuid(n + 40)}`, mode: bindingMode })
  const plan = createAgentPodPlanner(policy).plan({ identity: { unitId: uuid(1), operationId: uuid(11), attemptId: uuid(21),
    resourceName: `orca-unit-${uuid(11)}`, executionEpoch: '3', intentRevision: '5', specHash: 'a'.repeat(64) },
    protectedBindings: multiple ? [binding(1, 'home', 'RW'), binding(2, 'project', mode)] : [binding(1, 'main', mode)],
    profile: { revision: '7', cpuMilli: 777, memoryMi: 1024, ephemeralMi: 2048, temporaryMi: 256 } })
  return { plan, planDigest: createHash('sha256').update(canonicalInput(plan)).digest('hex'), recordedAt: '2026-10-16T04:23:00.000Z' }
}
export function models(mode: 'RO' | 'RW' = 'RO', multiple = false) {
  const record = original(mode, multiple), podUid = uuid(80), plan = record.plan
  const pod = { ...plan.pod, metadata: { ...plan.pod.metadata, uid: podUid, resourceVersion: '10' },
    spec: { ...plan.pod.spec, nodeName: 'fixture-node' }, status: { phase: 'Running', containerStatuses: [{ name: 'agent',
      containerID: 'containerd://consumer-fixture', imageID: plan.pod.spec.containers[0].image, restartCount: 0,
      state: { running: { startedAt: '2026-10-16T04:23:01.000Z' } } }] } }
  const expectations = [...plan.mountExpectations.protected, plan.mountExpectations.shared]
  const pvcs = expectations.map((item, index) => ({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: {
    name: item.claimName, uid: item.claimUid, namespace: 'agent-fixture', resourceVersion: '20' },
    spec: { volumeName: `consumer-nfs-pv-${index}`, volumeMode: 'Filesystem' }, status: { phase: 'Bound' } }))
  const pvs = expectations.map((item, index) => ({ apiVersion: 'v1', kind: 'PersistentVolume', metadata: {
    name: pvcs[index].spec.volumeName, uid: item.pvUid, resourceVersion: '30' }, spec: { volumeMode: 'Filesystem',
    claimRef: { name: item.claimName, uid: item.claimUid, namespace: 'agent-fixture' },
    nfs: { server: item.server, path: item.serverPath, readOnly: false } }, status: { phase: 'Bound' } }))
  const mountinfo = ['1 0 0:1 / / rw - overlay overlay rw', ...expectations.map((item, index) =>
    `${index + 10} 1 0:${index + 23} / ${item.clientPath} ${item.mode === 'RO' ? 'ro' : 'rw'} - nfs4 ${item.server}:${item.serverPath} rw`)].join('\n')
  const roots = expectations.map((item, index) => {
    const stat = { device: String(index + 23), inode: String(index + 400), uid: item.clientPath === '/shared' ? 0 : 1000,
      gid: 1000, mode: item.clientPath === '/shared' ? '0770' : '0700', directory: true, symlink: false }
    const snapshot = { realPath: item.clientPath, lstat: { ...stat }, stat: { ...stat } }
    return { path: item.clientPath, before: structuredClone(snapshot), after: structuredClone(snapshot) }
  })
  const output = { kind: 'AGENT_MOUNT_PROBE_1', uid: 1000, gid: 1000, mountinfoBefore: mountinfo, mountinfoAfter: mountinfo, roots }
  const storageSteps = (): Step[] => pvcs.flatMap((pvc, index) => [{ body: structuredClone(pvc) }, { body: structuredClone(pvs[index]) }])
  const steps: Step[] = [{ body: structuredClone(pod) }, ...storageSteps(), ...storageSteps(), { body: structuredClone(pod) }]
  return { record, podUid, pod, pvcs, pvs, output, steps, expectations }
}
export function fixture(model = models(), play: (socket: Socket, output: string) => void = finish) {
  const configuration = config(), api = harness(model.steps), sockets: Socket[] = []
  const opened: { url: URL; protocol: string; options: ClientOptions }[] = []
  const dependencies: AgentMountCollectorDependencies = { https: api.transport, openWebSocket(url, protocol, options) {
    const socket = new Socket(); sockets.push(socket); opened.push({ url, protocol, options })
    queueMicrotask(() => { socket.emit('open'); if (!socket.terminated) { play(socket, JSON.stringify(model.output)) } })
    return socket
  } }
  return { ...model, configuration, dependencies, api, sockets, opened,
    async assertCleanup() {
      await Promise.resolve(); api.assertCleanup()
      for (const socket of sockets) {
        if (!socket.closed || socket.eventNames().length) { throw new Error('Owned socket was not cleaned') }
      }
    } }
}
