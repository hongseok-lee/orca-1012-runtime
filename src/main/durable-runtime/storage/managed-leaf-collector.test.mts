import assert from 'node:assert/strict'
import { test } from 'node:test'
import { performance } from 'node:perf_hooks'
import { createManagedLeafCollector, ManagedLeafCollectorError } from './managed-leaf-collector.ts'
import { collectManagedLeafExec } from './managed-leaf-collector-exec.ts'
import { config, deferred, finish, fixture, helper, leafId, pod, pv, pvc, reviewerToken } from './managed-leaf-collector-fixtures.mts'
import type { Socket } from './managed-leaf-collector-fixtures.mts'
import type { ManagedLeafCollectorCode, ManagedLeafCollectorConfig } from './managed-leaf-collector-types.ts'

const rejected = (action: Promise<unknown>, code: ManagedLeafCollectorCode) => assert.rejects(action,
  error => error instanceof ManagedLeafCollectorError && error.code === code &&
    error.message === `MANAGED_LEAF_COLLECTOR_${code}`)

test('authenticated collector follows exact GET/exec/GET with one budget and owned cleanup', async t => {
  await t.test('v5 split UTF-8 and Status do not bypass remaining stdout or final Pod verification', async () => {
    const reached = deferred<Socket>()
    const f = fixture(undefined, socket => reached.resolve(socket))
    const collecting = createManagedLeafCollector(f.configuration, f.dependencies).collect(leafId, new AbortController().signal)
    const socket = await reached.promise, bytes = Buffer.from(f.output), cut = bytes.indexOf(Buffer.from('관')) + 1
    socket.frame(3, '{"sta'); socket.frame(3, 'tus":"Success"}')
    socket.frame(1, bytes.subarray(0, cut))
    let returned = false
    void collecting.then(() => { returned = true }, () => { returned = true })
    await Promise.resolve(); assert.equal(returned, false); assert.equal(f.api.requests.length, 4)
    socket.frame(1, bytes.subarray(cut))
    for (const channel of [1, 2, 3]) { socket.frame(255, Buffer.from([channel])) }
    socket.end()
    const result = await collecting
    assert.equal(f.api.requests.length, 5); assert.equal(f.opened.length, 1)
    assert.equal(result.kind, 'AUTHENTICATED_MANAGED_LEAF_OBSERVATION')
    assert.equal(result.candidate.canonicalDirectory, `/${f.configuration.dataset}/${leafId}`)
    assert.equal(result.candidate.inode, '400'); assert.equal(result.candidate.device, '66317')
    assert.equal(result.candidate.domain.pvUid, f.configuration.pvUid)
    assert.equal(result.namespacePin, false); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.storage.pv))
    assert.ok(Object.isFrozen(result.candidate.domain)); assert.match(result.evidenceDigest, /^[0-9a-f]{64}$/)
    assert.ok(!JSON.stringify(result).includes(reviewerToken))
    for (const request of f.api.requests) {
      assert.equal(request.url.origin, f.configuration.apiOrigin); assert.equal(request.options.method, 'GET')
      assert.equal(request.options.rejectUnauthorized, true); assert.equal(request.options.agent, false)
      assert.deepEqual(request.options.ca, f.configuration.ca); assert.equal(request.request.body, undefined)
    }
    assert.deepEqual(f.api.requests.map(row => row.url.pathname), [
      '/api/v1/namespaces/orca-dev/pods/nfs-fixture', '/api/v1/namespaces/orca-dev/persistentvolumeclaims/fixture-pvc',
      '/api/v1/persistentvolumes/fixture-pv', '/api/v1/namespaces/orca-dev/configmaps/fixture-helper',
      '/api/v1/namespaces/orca-dev/pods/nfs-fixture'])
    const exec = f.opened[0]
    assert.equal(exec.url.origin, 'wss://kubernetes.invalid:6443'); assert.equal(exec.protocol, 'v5.channel.k8s.io')
    assert.equal(exec.options.followRedirects, false); assert.equal(exec.options.rejectUnauthorized, true)
    assert.equal(exec.options.agent, false); assert.deepEqual(exec.options.ca, f.configuration.ca)
    for (const [key, value] of Object.entries({ container: 'unfs3', stdin: 'false', tty: 'false', stdout: 'true', stderr: 'true' })) {
      assert.equal(exec.url.searchParams.get(key), value)
    }
    assert.deepEqual(exec.url.searchParams.getAll('command'), ['/bin/sh', '-ec', f.command, 'orca-managed-leaf-collector',
      f.configuration.helperSha256, f.configuration.exportsSha256, f.configuration.podUid, f.configuration.dataset, leafId])
    assert.ok(!exec.url.href.includes(reviewerToken)); await f.assertCleanup()
  })
  await t.test('trusted configuration, CA, function and transport bindings are captured once', async () => {
    const f = fixture(), originalCa = Buffer.from(f.configuration.ca)
    let receiver = false
    f.configuration.readReviewerBearer = function (this: ManagedLeafCollectorConfig) { receiver = this === f.configuration; return reviewerToken }
    const collector = createManagedLeafCollector(f.configuration, f.dependencies)
    f.configuration.ca.fill(0); f.configuration.namespace = 'changed'; f.configuration.dataset = 'changed'
    f.configuration.readReviewerBearer = () => { throw new Error('Replacement credential supplier') }
    f.dependencies.https.request = () => { throw new Error('Replacement transport') }
    Reflect.set(f.dependencies, 'openWebSocket', () => { throw new Error('Replacement WebSocket opener') })
    const result = await collector.collect(leafId, new AbortController().signal)
    assert.equal(receiver, true); assert.equal(result.dataset, 'fixture-dataset')
    assert.deepEqual(f.opened[0].options.ca, originalCa); await f.assertCleanup()
  })
  await t.test('Pod/container, PVC/PV and helper identity mismatches never enter exec', async () => {
    const wrongPod = pod(); wrongPod.metadata.uid = '00000000-0000-4000-8000-000000000099'
    const wrongContainer = pod(); wrongContainer.status.containerStatuses[0].containerID = ''
    const wrongClaim = pvc(); wrongClaim.spec.volumeName = 'other-pv'
    const wrongPv = pv(); wrongPv.spec.csi.volumeHandle = 'other-volume'
    const wrongHelper = helper(); wrongHelper.binaryData['managed_storage.sh'] = Buffer.from('changed').toString('base64')
    for (const [beforePod, claim, volume, tool, code] of [
      [wrongPod, pvc(), pv(), helper(), 'POD_IDENTITY'], [wrongContainer, pvc(), pv(), helper(), 'POD_IDENTITY'],
      [pod(), wrongClaim, pv(), helper(), 'PVC_IDENTITY'], [pod(), pvc(), wrongPv, helper(), 'PV_IDENTITY'],
      [pod(), pvc(), pv(), wrongHelper, 'HELPER_IDENTITY'],
    ] as const) {
      const f = fixture([{ body: beforePod }, { body: claim }, { body: volume }, { body: tool }, { body: pod() }])
      await rejected(createManagedLeafCollector(f.configuration, f.dependencies).collect(leafId, new AbortController().signal), code)
      assert.equal(f.opened.length, 0); await f.assertCleanup()
    }
  })
  await t.test('container restart after exec rejects the captured observation', async () => {
    const after = pod(); after.status.containerStatuses[0].restartCount = 1
    const f = fixture([{ body: pod() }, { body: pvc() }, { body: pv() }, { body: helper() }, { body: after }])
    await rejected(createManagedLeafCollector(f.configuration, f.dependencies).collect(leafId, new AbortController().signal), 'POD_CHANGED')
    assert.equal(f.opened.length, 1); await f.assertCleanup()
  })
  await t.test('stream failures and success with trailing output fail closed', async () => {
    const cases: { play(socket: Socket, output: string): void; code: ManagedLeafCollectorCode }[] = [
      { play(s, o) { s.frame(1, o); s.end() }, code: 'EXEC_FAILED' },
      { play(s) { s.frame(3, '{"status":"Failure","reason":"NonZeroExitCode"}'); s.end() }, code: 'EXEC_FAILED' },
      { play(s) { s.frame(1, Buffer.from([0xff])) }, code: 'EXEC_PROTOCOL' },
      { play(s) { s.frame(4, 'unknown') }, code: 'EXEC_PROTOCOL' },
      { play(s) { s.frame(255, Buffer.from([1, 2])) }, code: 'EXEC_PROTOCOL' },
      { play(s) { s.frame(255, Buffer.from([1])); s.frame(1, 'after EOF') }, code: 'EXEC_PROTOCOL' },
      { play(s) { s.frame(255, Buffer.from([1])); s.frame(255, Buffer.from([1])) }, code: 'EXEC_PROTOCOL' },
      { play(s) { s.frame(1, 'text', false) }, code: 'EXEC_PROTOCOL' },
      { play(s, o) { s.frame(3, '{"status":"Success"}'); s.frame(3, '{"status":"Success"}'); s.frame(1, o); s.end() }, code: 'EXEC_FAILED' },
      { play(s) { s.frame(2, 'synthetic-private-stderr') }, code: 'EXEC_FAILED' },
      { play(s, o) { finish(s, `${o}unexpected`) }, code: 'OUTPUT_INVALID' },
      { play(s, o) { s.frame(1, o); s.frame(3, '{"status":"Success"}'); s.end(1006) }, code: 'EXEC_PROTOCOL' },
    ]
    for (const item of cases) {
      const f = fixture(undefined, item.play)
      await rejected(createManagedLeafCollector(f.configuration, f.dependencies).collect(leafId, new AbortController().signal), item.code)
      assert.ok(f.api.requests.length <= 5); await f.assertCleanup()
    }
    const wrongProtocol = fixture(undefined, undefined, 'v4.channel.k8s.io')
    await rejected(createManagedLeafCollector(wrongProtocol.configuration, wrongProtocol.dependencies).collect(leafId,
      new AbortController().signal), 'EXEC_PROTOCOL'); await wrongProtocol.assertCleanup()
  })
  await t.test('late credential, request abort and exec abort clean owned resources without subsequent I/O', async () => {
    const credential = deferred<string>(), waiting = fixture(), cancellation = new AbortController()
    waiting.configuration.readReviewerBearer = () => credential.promise
    const pending = createManagedLeafCollector(waiting.configuration, waiting.dependencies).collect(leafId, cancellation.signal)
    cancellation.abort(); await rejected(pending, 'ABORTED'); credential.resolve(reviewerToken)
    await Promise.resolve(); assert.equal(waiting.api.requests.length, 0); await waiting.assertCleanup()
    const request = fixture([{ body: pod(), stallBody: true }]), requestAbort = new AbortController()
    const reading = createManagedLeafCollector(request.configuration, request.dependencies).collect(leafId, requestAbort.signal)
    await request.api.reached[0].promise; requestAbort.abort(); await rejected(reading, 'ABORTED')
    assert.equal(request.api.requests.length, 1); await request.assertCleanup()
    const reached = deferred<void>(), exec = fixture(undefined, () => reached.resolve()), execAbort = new AbortController()
    const executing = createManagedLeafCollector(exec.configuration, exec.dependencies).collect(leafId, execAbort.signal)
    await reached.promise; execAbort.abort(); await rejected(executing, 'ABORTED')
    assert.equal(exec.api.requests.length, 4); await exec.assertCleanup()
  })
  await t.test('one deadline includes a delayed credential and never renews the I/O budget', async () => {
    const f = fixture(), credential = deferred<string>()
    f.configuration.timeoutMs = 5; f.configuration.readReviewerBearer = () => credential.promise
    await rejected(createManagedLeafCollector(f.configuration, f.dependencies).collect(leafId, new AbortController().signal), 'TIMEOUT')
    credential.resolve(reviewerToken); await Promise.resolve()
    assert.equal(f.api.requests.length, 0); assert.equal(f.opened.length, 0); await f.assertCleanup()
  })
  await t.test('an exhausted absolute deadline rejects at the exec entry without opening a socket', async () => {
    for (const deadline of [0, -1, performance.now() - 1]) {
      const f = fixture()
      await rejected(collectManagedLeafExec(f.dependencies.openWebSocket, f.configuration, leafId, reviewerToken,
        new AbortController().signal, deadline), 'TIMEOUT')
      assert.equal(f.opened.length, 0); assert.equal(f.api.requests.length, 0); await f.assertCleanup()
    }
  })
  await t.test('mountinfo changes and helper creation/ownership evidence reject success framing', async () => {
    for (const [alter, code] of [
      [(output: string) => output.replace(/259:13(?=[^]*ORCA_MANAGED_LEAF_END)/, '259:99'), 'MOUNT_CHANGED'],
      [(output: string) => output.replace('"created":false', '"created":true'), 'OUTPUT_INVALID'],
      [(output: string) => output.replace('"uid":1000', '"uid":1001'), 'OUTPUT_INVALID'],
    ] as const) {
      const f = fixture(undefined, (socket, output) => finish(socket, alter(output)))
      await rejected(createManagedLeafCollector(f.configuration, f.dependencies).collect(leafId, new AbortController().signal), code)
      await f.assertCleanup()
    }
  })
  await t.test('invalid leaf/config and TLS failures disclose no raw credential or URL', async () => {
    const f = fixture(), collector = createManagedLeafCollector(f.configuration, f.dependencies)
    await rejected(collector.collect('../leaf', new AbortController().signal), 'INPUT_INVALID')
    assert.equal(f.api.requests.length, 0)
    assert.throws(() => createManagedLeafCollector({ ...config(), apiOrigin: 'https://kubernetes.invalid/path?credential=private' }, f.dependencies),
      error => error instanceof ManagedLeafCollectorError && error.code === 'CONFIG_INVALID' && !error.message.includes('private'))
    const tls = fixture([{ errorCode: 'CERT_HAS_EXPIRED' }])
    await rejected(createManagedLeafCollector(tls.configuration, tls.dependencies).collect(leafId, new AbortController().signal), 'TLS_FAILED')
    await tls.assertCleanup(); await f.assertCleanup()
  })
})


await test('provisioning uses exact create-only helper then independent authenticated inspection', async () => {
  const f = fixture()
  const observed = await createManagedLeafCollector(f.configuration, f.dependencies)
    .ensureAndCollect(leafId, new AbortController().signal)
  assert.equal(f.opened.length, 2)
  assert.deepEqual(f.opened[0].url.searchParams.getAll('command'), ['/bin/sh',
    '/opt/orca-nfs-tools/managed_storage.sh', 'ensure-leaf', f.configuration.podUid,
    f.configuration.dataset, leafId])
  assert.equal(f.opened[1].url.searchParams.getAll('command')[2], f.command)
  assert.equal(observed.kind, 'AUTHENTICATED_MANAGED_LEAF_OBSERVATION')
  assert.equal(observed.leafId, leafId)
  assert.equal(observed.namespacePin, false)
  await f.assertCleanup()
  const wrongPod = pod(); wrongPod.metadata.uid = '00000000-0000-4000-8000-000000000099'
  const bad = fixture([{ body: wrongPod }])
  await assert.rejects(createManagedLeafCollector(bad.configuration, bad.dependencies)
    .ensureAndCollect(leafId, new AbortController().signal), /POD_IDENTITY/)
  assert.equal(bad.opened.length, 0)
  await bad.assertCleanup()
})
