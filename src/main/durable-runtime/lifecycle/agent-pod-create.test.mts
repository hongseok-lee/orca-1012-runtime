import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import type { JsonValue } from '../db/atomic.ts'
import type { AgentPodPlanRecord } from '../db/agent-pod-plan-record-rows.ts'
import { createAgentPodPlanner } from '../runtime/agent-pod-plan.ts'
import { canonicalInput } from '../runtime/gateway/input.ts'
import { deferred, harness, reviewerToken } from '../runtime/kubernetes-pod-auth-fixtures.mts'
import { AgentPodCreateError, createAgentPodCreateTransport } from './agent-pod-create.ts'
import type { AgentPodCreateConfig, AgentPodCreateInput } from './agent-pod-create.ts'

function record(): AgentPodPlanRecord {
  const plan = createAgentPodPlanner({ namespace: 'agent-fixture', dataset: 'dataset-fixture',
    image: `example.invalid/agent@sha256:${'1'.repeat(64)}`, entrypoint: { command: ['/opt/agent/entrypoint'], args: ['--cold', ''] },
    paths: { home: '/agent/home', claudeState: '/agent/home/.claude', codexState: '/agent/home/.codex', checkout: '/agent/project' },
    protectedMounts: [{ key: 'main', clientPath: '/agent' }], nfsServer: 'nfs.fixture.svc.cluster.local',
    protectedExportRoot: '/exports/runtime-domains/dataset-fixture',
    shared: { claimName: 'shared-fixture', claimUid: 'shared-claim', pvUid: 'shared-pv', serverPath: '/exports/shared/dataset-fixture' }
  }).plan({ identity: { unitId: '00000000-0000-0000-0000-000000000001', operationId: '00000000-0000-0000-0000-000000000002',
    attemptId: '00000000-0000-0000-0000-000000000003', resourceName: 'original-agent-name',
    executionEpoch: '9007199254740993', intentRevision: '9007199254740995', specHash: 'a'.repeat(64) },
  protectedBindings: [{ key: 'main', bindingId: '00000000-0000-0000-0000-000000000004', leafId: '00000000-0000-0000-0000-000000000005',
    claimName: 'protected-fixture', claimUid: 'protected-claim', pvUid: 'protected-pv',
    serverPath: '/exports/runtime-domains/dataset-fixture/00000000-0000-0000-0000-000000000005', mode: 'RW' }],
  profile: { revision: '9007199254740997', cpuMilli: 777, memoryMi: 1024, ephemeralMi: 2048, temporaryMi: 256 } })
  const json: JsonValue = JSON.parse(JSON.stringify(plan))
  return { plan, planDigest: createHash('sha256').update(canonicalInput(json)).digest('hex'), recordedAt: '2026-10-16T00:00:00.000Z' }
}
const config = (): AgentPodCreateConfig => ({ apiOrigin: 'https://kubernetes.invalid:6443', ca: Buffer.from('synthetic-ca'),
  namespace: 'agent-fixture', dataset: 'dataset-fixture', timeoutMs: 1000, readBearerToken: () => reviewerToken })
const input = (mode: AgentPodCreateInput['mode'] = 'CREATE_ONCE'): AgentPodCreateInput => ({ record: record(), mode, remainingMs: 1000 })
function pod(r: AgentPodPlanRecord) {
  const copy = structuredClone(r.plan.pod)
  return { ...copy, metadata: { ...copy.metadata, uid: 'actual-pod-uid', resourceVersion: 'opaque-rv',
    annotations: { ...copy.metadata.annotations, 'platform.example/annotation': 'harmless' } }, status: { phase: 'Pending' } }
}
function rejected(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof AgentPodCreateError)
    assert.equal(error.code, code); assert.equal('cause' in error, false)
    assert.equal(String(error.stack).includes(reviewerToken), false)
    return true
  }
}
function holdPastDeadline(): void {
  const deadline = performance.now() + 25
  while (performance.now() < deadline) { /* Deterministic stalled callback, not a random sleep. */ }
}

test('fixed stored Agent Pod transport observes original identity and never retransmits an uncertain create', async t => {
  await t.test('existing original object is FOUND, without POST or readiness/pin claims', async () => {
    const request = input(), h = harness([{ body: pod(request.record) }]), signal = new AbortController().signal
    const result = await createAgentPodCreateTransport(config(), h.transport).observeOrCreate(request, signal)
    assert.equal(result.disposition, 'FOUND'); assert.equal(result.postAttempts, 0)
    assert.equal(result.planDigest, request.record.planDigest); assert.equal(result.pod?.uid, 'actual-pod-uid')
    assert.equal(result.pod?.resourceVersion, 'opaque-rv'); assert.equal(result.readinessObserved, false)
    assert.equal(result.physicalPinVerified, false); assert.equal(h.requests.length, 1)
    assert.equal(getEventListeners(signal, 'abort').length, 0); h.assertCleanup()
  })
  await t.test('authenticated 404 permits one exact POST201; 409 recovers only the original GET', async () => {
    for (const conflict of [false, true]) {
      const request = input(), observed = pod(request.record)
      const h = harness(conflict ? [{ status: 404 }, { status: 409 }, { body: observed }] :
        [{ status: 404 }, { status: 201, body: observed }])
      const result = await createAgentPodCreateTransport(config(), h.transport).observeOrCreate(request, new AbortController().signal)
      assert.equal(result.disposition, conflict ? 'FOUND' : 'CREATED'); assert.equal(result.postAttempts, 1)
      assert.deepEqual(h.requests.map(row => row.options.method), conflict ? ['GET', 'POST', 'GET'] : ['GET', 'POST'])
      const base = '/api/v1/namespaces/agent-fixture/pods'
      assert.deepEqual(h.requests.map(row => row.url.pathname), conflict ? [base + '/original-agent-name', base, base + '/original-agent-name'] :
        [base + '/original-agent-name', base])
      assert.equal(h.requests[1]?.request.body, JSON.stringify(request.record.plan.pod))
      for (const row of h.requests) {
        assert.equal(row.url.origin, 'https://kubernetes.invalid:6443'); assert.equal(row.options.rejectUnauthorized, true)
        assert.equal(row.options.agent, false); assert.deepEqual(row.options.ca, Buffer.from('synthetic-ca'))
      }
      h.assertCleanup()
    }
  })
  await t.test('LOOKUP_ONLY404 is ABSENT;409404 is UNKNOWN;409 of another identity is CONFLICT', async () => {
    const request = input(), other = pod(request.record)
    Object.assign(other.metadata.annotations, { 'orca.dev/attempt-id': '00000000-0000-0000-0000-000000000099' })
    for (const c of [
      { mode: 'LOOKUP_ONLY', steps: [{ status: 404 }], expected: 'ABSENT', calls: 1 },
      { mode: 'CREATE_ONCE', steps: [{ status: 404 }, { status: 409 }, { status: 404 }], expected: 'UNKNOWN', calls: 3 },
      { mode: 'CREATE_ONCE', steps: [{ status: 404 }, { status: 409 }, { body: other }], expected: 'CONFLICT', calls: 3 }
    ]) {
      const h = harness(c.steps), current: AgentPodCreateInput = { ...request, mode: c.mode === 'LOOKUP_ONLY' ? 'LOOKUP_ONLY' : 'CREATE_ONCE' }
      const result = await createAgentPodCreateTransport(config(), h.transport).observeOrCreate(current, new AbortController().signal)
      assert.equal(result.disposition, c.expected); assert.equal(result.pod, null)
      assert.equal(h.requests.length, c.calls); h.assertCleanup()
    }
  })
  await t.test('Root-approved defaults and admitted requests are recorded separately from desired resources', async () => {
    const request = input(), observed = pod(request.record), container = observed.spec.containers[0]
    Object.assign(observed.spec, { serviceAccountName: 'default', serviceAccount: 'default', enableServiceLinks: true,
      dnsPolicy: 'ClusterFirst', schedulerName: 'gke.io/optimize-utilization-scheduler', priority: 0,
      preemptionPolicy: 'PreemptLowerPriority', hostPID: false, hostIPC: false, shareProcessNamespace: false, nodeName: 'actual-node',
      tolerations: [...observed.spec.tolerations,
        { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 },
        { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300, value: '' }] })
    Object.assign(container, { terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File', stdin: false, tty: false,
      resources: { requests: { cpu: '800m', memory: '1Gi', 'ephemeral-storage': '2Gi' }, limits: { 'ephemeral-storage': '2Gi' } } })
    const h = harness([{ body: observed }])
    const result = await createAgentPodCreateTransport(config(), h.transport).observeOrCreate(request, new AbortController().signal)
    assert.equal(result.disposition, 'FOUND'); assert.notDeepEqual(result.pod?.desiredResources, result.pod?.admittedResources)
    assert.deepEqual(result.pod?.admittedResources, container.resources); h.assertCleanup()
  })
  await t.test('exact identity, executable, mounts and security reject annotation-only lookalikes', async () => {
    const mutations: ((p: ReturnType<typeof pod>) => void)[] = [
      p => Object.assign(p.metadata, { name: 'another-name' }),
      p => Object.assign(p.metadata.annotations, { 'orca.dev/execution-epoch': '9007199254740992' }),
      p => Object.assign(p.metadata.annotations, { 'orca.dev/resource-profile-revision': '8' }),
      p => Object.assign(p.spec.containers[0], { image: 'another-image', command: ['sh'] }),
      p => Object.assign(p.spec.containers[0], { args: ['different'], workingDir: '/' }),
      p => Object.assign(p.spec.containers[0], { env: [{ name: 'HOME', value: '/shared' }] }),
      p => Object.assign(p.spec.containers[0].volumeMounts[0], { subPath: 'home' }),
      p => Object.assign(p.spec.containers[0].volumeMounts[0], { mountPath: '/' }),
      p => Object.assign(p.spec.containers[0].volumeMounts[0], { readOnly: true }),
      p => Object.assign(p.spec.volumes[0], { persistentVolumeClaim: { claimName: 'shared-fixture', readOnly: false } }),
      p => Object.assign(p.spec, { volumes: [...p.spec.volumes, { name: 'token', projected: {} }] }),
      p => Object.assign(p.spec, { containers: [...p.spec.containers, p.spec.containers[0]] }),
      p => Object.assign(p.spec, { initContainers: [p.spec.containers[0]] }),
      p => Object.assign(p.spec, { ephemeralContainers: [p.spec.containers[0]] }),
      p => Object.assign(p.spec.securityContext, { fsGroup: 1000 }),
      p => Object.assign(p.spec.securityContext, { supplementalGroups: [0] }),
      p => Object.assign(p.spec.securityContext, { runAsUser: 0 }),
      p => Object.assign(p.spec.containers[0].securityContext, { privileged: true }),
      p => Object.assign(p.spec.containers[0].securityContext, { capabilities: { drop: [] } }),
      p => Object.assign(p.spec, { hostPID: true }),
      p => Object.assign(p.spec, { automountServiceAccountToken: true }),
      p => Object.assign(p.spec, { terminationGracePeriodSeconds: 30 }),
      p => Object.assign(p.spec, { affinity: {} }),
      p => Object.assign(p.spec, { nodeSelector: {} }),
      p => Object.assign(p.spec, { tolerations: [...p.spec.tolerations, { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute' }] }),
      p => Object.assign(p.spec.containers[0], { resources: { requests: {}, limits: { cpu: '1' } } }),
      p => Object.assign(p.spec.containers[0], { livenessProbe: { exec: { command: ['sh'] } } }),
      p => Object.assign(p.spec.containers[0], { envFrom: [{ secretRef: { name: 'other' } }] })
    ]
    for (const mutate of mutations) {
      const request = input(), observed = pod(request.record); mutate(observed)
      const h = harness([{ body: observed }])
      const result = await createAgentPodCreateTransport(config(), h.transport).observeOrCreate(request, new AbortController().signal)
      assert.equal(result.disposition, 'CONFLICT'); assert.equal(result.pod, null); assert.equal(result.postAttempts, 0)
      assert.equal(h.requests.length, 1); h.assertCleanup()
    }
  })
  await t.test('pre-await stored input and exact methods/receivers survive mutation during credential wait', async () => {
    const request = structuredClone(input()), original = JSON.stringify(request.record.plan.pod), gate = deferred<string>()
    const h = harness([{ status: 404 }, { status: 201, body: pod(request.record) }])
    const c = { ...config(), readBearerToken(this: AgentPodCreateConfig) { assert.equal(this, c); return gate.promise } }
    const transport = createAgentPodCreateTransport(c, h.transport)
    const promise = transport.observeOrCreate(request, new AbortController().signal)
    Object.assign(request.record.plan.pod.metadata, { name: 'changed-after-capture' })
    Object.assign(request, { mode: 'LOOKUP_ONLY', remainingMs: 1 })
    Object.assign(c, { namespace: 'changed', apiOrigin: 'https://changed.invalid', readBearerToken: () => 'changed' }); c.ca.fill(0)
    Object.assign(h.transport, { request: () => { throw new Error(reviewerToken) } })
    gate.resolve(reviewerToken)
    assert.equal((await promise).disposition, 'CREATED'); assert.equal(h.requests[1]?.request.body, original)
    assert.deepEqual(h.requests[1]?.options.ca, Buffer.from('synthetic-ca')); h.assertCleanup()
  })
  await t.test('invalid stored digest or accessor never performs I/O', async () => {
    const h = harness([]), transport = createAgentPodCreateTransport(config(), h.transport), request = structuredClone(input())
    Object.assign(request.record, { planDigest: 'f'.repeat(64) })
    await assert.rejects(transport.observeOrCreate(request, new AbortController().signal), rejected('INPUT_INVALID'))
    let reads = 0
    const hostile = { ...input(), get record() { reads++; return record() } }
    await assert.rejects(transport.observeOrCreate(hostile, new AbortController().signal), rejected('INPUT_INVALID'))
    assert.equal(reads, 0); assert.equal(h.requests.length, 0)
  })
  await t.test('GET403, redirect, malformed JSON and TLS failure never become authenticated404', async () => {
    for (const c of [
      { step: { status: 403 }, code: 'HTTP_FORBIDDEN' }, { step: { status: 302 }, code: 'HTTP_FAILED' },
      { step: { raw: '{invalid' }, code: 'RESPONSE_INVALID' },
      { step: { errorCode: 'ERR_TLS_CERT_ALTNAME_INVALID' }, code: 'TLS_FAILED' }
    ]) {
      const h = harness([c.step])
      await assert.rejects(createAgentPodCreateTransport(config(), h.transport).observeOrCreate(input(), new AbortController().signal), rejected(c.code))
      assert.equal(h.requests.length, 1); h.assertCleanup()
    }
    assert.throws(() => createAgentPodCreateTransport({ ...config(), apiOrigin: 'http://kubernetes.invalid' }), rejected('CONFIG_INVALID'))
  })
  await t.test('POST disconnect/5xx/invalid body are UNKNOWN and make no automatic second POST', async () => {
    for (const step of [{ errorCode: 'ECONNRESET' }, { status: 503 }, { status: 201, raw: '{invalid' }, { status: 201, body: {} }]) {
      const h = harness([{ status: 404 }, step])
      const result = await createAgentPodCreateTransport(config(), h.transport).observeOrCreate(input(), new AbortController().signal)
      assert.equal(result.disposition, 'UNKNOWN'); assert.equal(result.postAttempts, 1); assert.equal(result.pod, null)
      assert.deepEqual(h.requests.map(row => row.options.method), ['GET', 'POST']); h.assertCleanup()
    }
  })
  await t.test('one total timeout or caller abort destroys pending POST and prevents a retry', async () => {
    for (const timed of [false, true]) {
      const h = harness([{ status: 404 }, { stallBody: true }]), signal = new AbortController()
      const promise = createAgentPodCreateTransport({ ...config(), timeoutMs: timed ? 15 : 1000 }, h.transport)
        .observeOrCreate(input(), signal.signal)
      await h.reached[1]?.promise
      if (!timed) { signal.abort(new Error(reviewerToken)) }
      const result = await promise
      assert.equal(result.disposition, 'UNKNOWN'); assert.equal(result.reason, timed ? 'TIMEOUT' : 'ABORTED')
      assert.equal(result.postAttempts, 1); assert.equal(h.requests.length, 2)
      assert.equal(getEventListeners(signal.signal, 'abort').length, 0); h.assertCleanup()
    }
  })
  await t.test('expired remaining budget after GET prevents POST even before timer callback runs', async () => {
    const h = harness([{ status: 404, before: holdPastDeadline }])
    await assert.rejects(createAgentPodCreateTransport(config(), h.transport)
      .observeOrCreate({ ...input(), remainingMs: 10 }, new AbortController().signal), rejected('TIMEOUT'))
    assert.equal(h.requests.length, 1); h.assertCleanup()
  })
  await t.test('the same deadline after POST409 prevents a new lookup budget or second POST', async () => {
    const h = harness([{ status: 404 }, { status: 409, before: holdPastDeadline }])
    const result = await createAgentPodCreateTransport(config(), h.transport)
      .observeOrCreate({ ...input(), remainingMs: 10 }, new AbortController().signal)
    assert.equal(result.disposition, 'UNKNOWN'); assert.equal(result.reason, 'TIMEOUT'); assert.equal(result.postAttempts, 1)
    assert.deepEqual(h.requests.map(row => row.options.method), ['GET', 'POST']); h.assertCleanup()
  })
  await t.test('pre-abort and late credential completion do not open a request or leak listeners', async () => {
    const gate = deferred<string>(), h = harness([]), external = new AbortController()
    const promise = createAgentPodCreateTransport({ ...config(), readBearerToken: () => gate.promise }, h.transport)
      .observeOrCreate(input(), external.signal)
    external.abort(new Error(reviewerToken))
    await assert.rejects(promise, rejected('ABORTED')); gate.resolve(reviewerToken)
    await Promise.resolve(); await Promise.resolve()
    assert.equal(h.requests.length, 0); assert.equal(getEventListeners(external.signal, 'abort').length, 0)
    let supplied = 0
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(createAgentPodCreateTransport({ ...config(), readBearerToken() { supplied++; return reviewerToken } }, h.transport)
      .observeOrCreate(input(), aborted.signal), rejected('ABORTED'))
    assert.equal(supplied, 0)
  })
})
