import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentPodPlanner } from './agent-pod-plan.ts'
import type { UnauthorizedAgentPodPlan } from './agent-pod-plan.ts'
import { captureAgentPodPolicy } from './agent-pod-policy.ts'
import { inventoryPod } from '../lifecycle/kubernetes-identity.ts'

const uuid = (suffix: number): string => `00000000-0000-0000-0000-${String(suffix).padStart(12, '0')}`
function policy() {
  return { namespace: 'agent-fixture', dataset: 'dataset-fixture', image: `example.invalid/agent@sha256:${'1'.repeat(64)}`,
    entrypoint: { command: ['/opt/agent/entrypoint'], args: ['--resume-mode', 'cold', ''] },
    paths: { home: '/agent/home', claudeState: '/agent/home/.claude', codexState: '/agent/home/.codex', checkout: '/agent/project' },
    protectedMounts: [{ key: 'main', clientPath: '/agent' }],
    nfsServer: 'nfs.fixture.svc.cluster.local', protectedExportRoot: '/exports/runtime-domains/dataset-fixture',
    shared: { claimName: 'shared-fixture', claimUid: 'shared-claim-opaque', pvUid: 'shared-pv-opaque', serverPath: '/exports/shared/dataset-fixture' } }
}
function request(agent = 1, mode: 'RO' | 'RW' = 'RW') {
  return { identity: { unitId: uuid(agent), operationId: uuid(agent + 10), attemptId: uuid(agent + 20),
    resourceName: `orca-unit-${uuid(agent + 10)}`, executionEpoch: '3', intentRevision: '5', specHash: 'a'.repeat(64) },
    protectedBindings: [{ key: 'main', bindingId: uuid(agent + 30), leafId: uuid(agent + 40), claimName: `protected-${agent}`,
      claimUid: `protected-claim-opaque-${agent}`, pvUid: `protected-pv-opaque-${agent}`, serverPath: `/exports/runtime-domains/dataset-fixture/${uuid(agent + 40)}`, mode }],
    profile: { revision: '7', cpuMilli: 777, memoryMi: 1024, ephemeralMi: 2048, temporaryMi: 256 } }
}

function claim(volume: UnauthorizedAgentPodPlan['pod']['spec']['volumes'][number]) {
  assert.ok('persistentVolumeClaim' in volume)
  return volume.persistentVolumeClaim
}
function readOnly(mount: UnauthorizedAgentPodPlan['pod']['spec']['containers'][number]['volumeMounts'][number]) {
  assert.ok('readOnly' in mount)
  return mount.readOnly
}

test('trusted Agent Pod plans preserve protected/shared boundaries without issuing authority', async t => {
  await t.test('two Agents use distinct exact protected claims and the same shared RW claim', () => {
    const planner = createAgentPodPlanner(policy()), a = planner.plan(request(1)), b = planner.plan(request(2))
    assert.notEqual(a.pod.metadata.name, b.pod.metadata.name)
    assert.equal(a.pod.metadata.name, request(1).identity.resourceName)
    assert.equal(a.mountExpectations.protected[0].claimUid, 'protected-claim-opaque-1')
    assert.notEqual(a.mountExpectations.protected[0].leafId, b.mountExpectations.protected[0].leafId)
    assert.notEqual(a.mountExpectations.protected[0].claimName, b.mountExpectations.protected[0].claimName)
    assert.deepEqual(a.mountExpectations.shared, b.mountExpectations.shared)
    assert.equal(a.mountExpectations.protected[0].clientPath, '/agent')
    assert.equal(a.mountExpectations.shared.clientPath, '/shared')
    assert.equal(claim(a.pod.spec.volumes[0]).claimName, 'protected-1')
    assert.equal(claim(a.pod.spec.volumes[1]).claimName, 'shared-fixture')
    assert.equal(JSON.stringify(a.pod).includes('nfs.fixture.svc.cluster.local'), false)
    assert.equal(a.kind, 'UNAUTHORIZED_PLAN'); assert.equal(a.storageGrantIssued, false)
    assert.equal(a.physicalPinIssued, false); assert.equal(a.readinessObserved, false)
  })
  await t.test('RO protected mounts do not turn the common collaboration mount into RO', () => {
    const p = createAgentPodPlanner(policy()).plan(request(1, 'RO'))
    assert.equal(claim(p.pod.spec.volumes[0]).readOnly, true)
    assert.equal(readOnly(p.pod.spec.containers[0].volumeMounts[0]), true)
    assert.equal(claim(p.pod.spec.volumes[1]).readOnly, false)
    assert.equal(readOnly(p.pod.spec.containers[0].volumeMounts[1]), false)
    assert.equal(p.mountExpectations.shared.mode, 'RW')
  })
  await t.test('required security, Spot/amd64 placement and trusted requests are exact', () => {
    const p = createAgentPodPlanner(policy()).plan(request()), s = p.pod.spec, c = s.containers[0]
    assert.deepEqual(s.securityContext, { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } })
    assert.deepEqual(c.securityContext, { allowPrivilegeEscalation: false, privileged: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } })
    assert.equal(s.hostNetwork, false); assert.equal(s.automountServiceAccountToken, false)
    assert.deepEqual(s.nodeSelector, { 'cloud.google.com/gke-spot': 'true', 'kubernetes.io/arch': 'amd64' })
    const placement = s.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution
    assert.deepEqual(placement, [{ topologyKey: 'kubernetes.io/hostname', namespaces: ['agent-fixture'], labelSelector: {} }])
    assert.equal(s.restartPolicy, 'Never'); assert.equal(s.terminationGracePeriodSeconds, 25)
    assert.deepEqual(c.resources.requests, { cpu: '777m', memory: '1024Mi', 'ephemeral-storage': '2048Mi' })
    assert.deepEqual(c.resources.limits, { 'ephemeral-storage': '2048Mi' })
    const temporary = s.volumes[2]; assert.ok('emptyDir' in temporary)
    assert.deepEqual(temporary.emptyDir, { sizeLimit: '256Mi' })
    assert.deepEqual(c.volumeMounts.map(m => m.mountPath), ['/agent', '/shared', '/tmp'])
    assert.equal('initContainers' in s, false); assert.equal('ephemeralContainers' in s, false)
    assert.equal(c.volumeMounts.some(m => 'subPath' in m || 'subPathExpr' in m), false)
    assert.deepEqual(c.command, ['/opt/agent/entrypoint']); assert.deepEqual(c.args, ['--resume-mode', 'cold', ''])
    assert.deepEqual(c.env, [{ name: 'HOME', value: '/agent/home' }, { name: 'CLAUDE_CONFIG_DIR', value: '/agent/home/.claude' }, { name: 'CODEX_HOME', value: '/agent/home/.codex' }])
  })
  await t.test('root, parent, legacy and escaping server/client paths are rejected', () => {
    for (const path of ['/', '/exports', '/x', '/exports/runtime-domains', '/exports/runtime-domains/dataset-fixture/..']) {
      assert.throws(() => createAgentPodPlanner({ ...policy(), protectedExportRoot: path }), /AGENT_POD_POLICY_INVALID/)
      const r = request(); r.protectedBindings[0].serverPath = path
      assert.throws(() => createAgentPodPlanner(policy()).plan(r), /AGENT_POD_(MOUNT_SCOPE_INVALID|INPUT_INVALID)/)
    }
    for (const path of ['/shared/home', '/agent', '/agent/../shared/home', '/agent/home/', '//agent/home', '/agent\\home', '/tmp/home']) {
      const p = policy(); p.paths.home = path
      assert.throws(() => createAgentPodPlanner(p), /AGENT_POD_POLICY_INVALID/)
    }
    for (const path of ['/exports/runtime-domains/dataset-fixture', request().protectedBindings[0].serverPath, '/exports/shared', '/x/shared']) {
      const p = policy(); p.shared.serverPath = path
      assert.throws(() => createAgentPodPlanner(p), /AGENT_POD_POLICY_INVALID/)
    }
  })
  await t.test('arbitrary overrides at every input level and accessor fields never enter a plan', () => {
    const planner = createAgentPodPlanner(policy())
    for (const key of ['shared', 'podSpec', 'initContainers', 'containers', 'volumes', 'securityContext', 'env', 'nfsServer']) {
      assert.throws(() => planner.plan({ ...request(), [key]: true }), /AGENT_POD_INPUT_INVALID/)
      assert.throws(() => createAgentPodPlanner({ ...policy(), [key]: true }), /AGENT_POD_POLICY_INVALID/)
    }
    const r = request()
    assert.throws(() => planner.plan({ ...r, protectedBindings: [{ ...r.protectedBindings[0], subPath: 'home' }] }), /AGENT_POD_INPUT_INVALID/)
    assert.throws(() => planner.plan({ ...r, profile: { ...r.profile, memoryLimit: '1Gi' } }), /AGENT_POD_INPUT_INVALID/)
    let reads = 0
    const hostile = { ...policy(), get image() { reads++; return policy().image } }
    assert.throws(() => createAgentPodPlanner(hostile), /AGENT_POD_POLICY_INVALID/)
    assert.equal(reads, 0)
    const withAccessor = { ...request(), get identity() { reads++; return request().identity } }
    assert.throws(() => planner.plan(withAccessor), /AGENT_POD_INPUT_INVALID/); assert.equal(reads, 0)
    const array = request().protectedBindings; Object.defineProperty(array, '0', { get() { reads++; return r.protectedBindings[0] } })
    assert.throws(() => planner.plan({ ...r, protectedBindings: array }), /AGENT_POD_INPUT_INVALID/); assert.equal(reads, 0)
  })
  await t.test('capture is immutable and same logical operation replans deterministically', () => {
    const p = policy(), r = request(), planner = createAgentPodPlanner(p)
    const first = planner.plan(r), snapshot = JSON.stringify(first)
    p.image = `different.invalid/agent@sha256:${'2'.repeat(64)}`; p.entrypoint.command[0] = '/wrong'
    p.paths.home = '/wrong'; p.shared.claimName = 'wrong-shared'; r.protectedBindings[0].claimName = 'wrong-protected'
    r.identity.operationId = uuid(99); r.profile.cpuMilli = 999
    assert.equal(JSON.stringify(first), snapshot)
    assert.equal(JSON.stringify(planner.plan(request())), snapshot)
    const revised = request(); revised.identity.specHash = 'b'.repeat(64); revised.identity.attemptId = uuid(70)
    assert.equal(planner.plan(revised).pod.metadata.name, first.pod.metadata.name)
    assert.deepEqual(planner.plan({ profile: request().profile, protectedBindings: request().protectedBindings, identity: request().identity }), first)
    assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(first.pod.spec.containers[0].volumeMounts), true)
    assert.equal(Reflect.set(first.pod.spec.containers[0].securityContext, 'privileged', true), false)
    assert.equal(Reflect.set(first.mountExpectations.shared, 'serverPath', '/x'), false)
    const captured = captureAgentPodPolicy(policy()); assert.equal(Object.isFrozen(captured.entrypoint.command), true)
  })
  await t.test('blank/malformed identity, images, namespace and resource requests fail closed', () => {
    const planner = createAgentPodPlanner(policy())
    for (const key of ['unitId', 'operationId', 'attemptId', 'resourceName', 'executionEpoch', 'intentRevision', 'specHash']) {
      assert.throws(() => planner.plan({ ...request(), identity: { ...request().identity, [key]: '' } }), /AGENT_POD_INPUT_INVALID/)
    }
    assert.throws(() => planner.plan({ ...request(), identity: { ...request().identity, resourceName: 'bad/name' } }), /AGENT_POD_INPUT_INVALID/)
    assert.throws(() => planner.plan({ ...request(), identity: { ...request().identity, executionEpoch: '9223372036854775808' } }), /AGENT_POD_INPUT_INVALID/)
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => planner.plan({ ...request(), profile: { ...request().profile, memoryMi: value } }), /AGENT_POD_INPUT_INVALID/)
    }
    assert.throws(() => planner.plan({ ...request(), profile: { ...request().profile, temporaryMi: 4096 } }), /AGENT_POD_INPUT_INVALID/)
    for (const image of ['agent:latest', `https://example.invalid/agent@sha256:${'1'.repeat(64)}`, 'agent@sha256:ABC']) {
      assert.throws(() => createAgentPodPlanner({ ...policy(), image }), /AGENT_POD_POLICY_INVALID/)
    }
    assert.throws(() => createAgentPodPlanner({ ...policy(), namespace: 'Invalid.Namespace' }), /AGENT_POD_POLICY_INVALID/)
    assert.throws(() => createAgentPodPlanner({ ...policy(), entrypoint: { command: [], args: [] } }), /AGENT_POD_POLICY_INVALID/)
    assert.throws(() => createAgentPodPlanner({ ...policy(), nfsServer: 'https://private.invalid/' }), /AGENT_POD_POLICY_INVALID/)
  })
  await t.test('all policy keys must appear exactly once without omission, extra mappings or aliasing', () => {
    const planner = createAgentPodPlanner(policy()), r = request()
    assert.throws(() => planner.plan({ ...r, protectedBindings: [] }), /AGENT_POD_MOUNT_SCOPE_INVALID/)
    assert.throws(() => planner.plan({ ...r, protectedBindings: [...r.protectedBindings, ...request(2).protectedBindings] }), /AGENT_POD_MOUNT_SCOPE_INVALID/)
    assert.throws(() => planner.plan({ ...r, protectedBindings: [{ ...r.protectedBindings[0], key: 'unknown' }] }), /AGENT_POD_MOUNT_SCOPE_INVALID/)
    // Planning does not impose a global Session/Agent/leaf 1:1 or authorize a concurrent writer.
    const other = planner.plan({ ...request(2), protectedBindings: r.protectedBindings })
    assert.equal(other.kind, 'UNAUTHORIZED_PLAN'); assert.equal(other.storageGrantIssued, false)
    assert.equal(other.mountExpectations.protected[0].bindingId, r.protectedBindings[0].bindingId)
    for (const protectedMounts of [[], [{ key: 'home', clientPath: '/agent' }, { key: 'project', clientPath: '/agent/project' }],
      [{ key: 'same', clientPath: '/agent/home' }, { key: 'same', clientPath: '/agent/project' }],
      [{ key: 'home', clientPath: '/agent/home' }], [{ key: 'shared', clientPath: '/shared' }]]) {
      assert.throws(() => createAgentPodPlanner({ ...policy(), protectedMounts }), /AGENT_POD_POLICY_INVALID/)
    }
  })
  await t.test('separate home/provider and checkout bindings produce two protected mounts and shared', () => {
    const p = policy(); p.protectedMounts = [{ key: 'home', clientPath: '/agent/home' }, { key: 'project', clientPath: '/agent/project' }]
    const r = request(), home = { ...r.protectedBindings[0], key: 'home' }, project = { ...request(2).protectedBindings[0], key: 'project', mode: 'RO' as const }
    const planner = createAgentPodPlanner(p), plan = planner.plan({ ...r, protectedBindings: [project, home] })
    assert.deepEqual(plan.mountExpectations.protected.map(binding => [binding.key, binding.clientPath, binding.claimName, binding.mode]),
      [['home', '/agent/home', 'protected-1', 'RW'], ['project', '/agent/project', 'protected-2', 'RO']])
    assert.deepEqual(plan.pod.spec.containers[0].volumeMounts.map(m => [m.mountPath, 'readOnly' in m ? m.readOnly : false]),
      [['/agent/home', false], ['/agent/project', true], ['/shared', false], ['/tmp', false]])
    assert.deepEqual(planner.plan({ ...r, protectedBindings: [home, project] }), plan)
    assert.equal(plan.pod.spec.volumes.length, 4)
    assert.deepEqual(plan.pod.spec.volumes.slice(0, 3).map(v => claim(v).claimName), ['protected-1', 'protected-2', 'shared-fixture'])
    for (const changed of [{ key: home.key }, { bindingId: home.bindingId }, { leafId: home.leafId, serverPath: home.serverPath },
      { claimName: home.claimName }, { claimUid: home.claimUid }, { pvUid: home.pvUid }]) {
      assert.throws(() => planner.plan({ ...r, protectedBindings: [home, { ...project, ...changed }] }), /AGENT_POD_MOUNT_SCOPE_INVALID/)
    }
    assert.throws(() => planner.plan({ ...r, protectedBindings: [home] }), /AGENT_POD_MOUNT_SCOPE_INVALID/)
  })
  await t.test('protected and shared cannot alias the same claim or PV identity', () => {
    const p = policy(), planner = createAgentPodPlanner(p)
    for (const change of [{ claimName: p.shared.claimName }, { claimUid: p.shared.claimUid }, { pvUid: p.shared.pvUid }]) {
      const r = request(); assert.throws(() => planner.plan({ ...r, protectedBindings: [{ ...r.protectedBindings[0], ...change }] }), /AGENT_POD_MOUNT_SCOPE_INVALID/)
    }
    const r = request(); r.protectedBindings[0].serverPath += '/checkout'
    assert.throws(() => planner.plan(r), /AGENT_POD_MOUNT_SCOPE_INVALID/)
  })
  await t.test('planned metadata remains compatible with the existing inventory identity reader', () => {
    const p = createAgentPodPlanner(policy()).plan(request())
    const parsed = inventoryPod({ ...p.pod, metadata: { ...p.pod.metadata, uid: uuid(80), resourceVersion: '10' } }, 'agent-fixture', 'dataset-fixture')
    assert.equal(parsed.unitId, p.identity.unitId); assert.equal(parsed.operationId, p.identity.operationId)
    assert.equal(parsed.executionEpoch, p.identity.executionEpoch); assert.equal(parsed.specHash, p.identity.specHash)
    assert.equal(parsed.name, p.pod.metadata.name)
    assert.equal(p.podSpecSHA256.length, 64)
  })
})
