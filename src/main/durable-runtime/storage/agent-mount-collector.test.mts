import assert from 'node:assert/strict'
import test from 'node:test'
import { getEventListeners } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentMountCollector } from './agent-mount-collector.ts'
import { agentMountOutputLimit, agentMountProbeSource, agentMountProbeSha256 } from './agent-mount-collector-probe.ts'
import { deferred } from '../runtime/kubernetes-pod-auth-fixtures.mts'
import { fixture, models, reviewerToken, finish } from './agent-mount-collector-fixtures.mts'
import { inventoryRecord } from '../lifecycle/kubernetes-identity.ts'
import { agentPodArray } from '../runtime/agent-pod-policy.ts'
import type { AgentMountCollectorCode } from './agent-mount-collector-types.ts'

const signal = () => new AbortController().signal
async function rejected(f: ReturnType<typeof fixture>, code: AgentMountCollectorCode, inputSignal = signal()) {
  await assert.rejects(createAgentMountCollector(f.configuration, f.dependencies).collect(f.record, f.podUid, inputSignal),
    { name: 'AgentMountCollectorError', message: `AGENT_MOUNT_COLLECTOR_${code}`, code })
  assert.equal(getEventListeners(inputSignal, 'abort').length, 0)
  await f.assertCleanup()
}
function body(f: ReturnType<typeof fixture>, index: number) { return inventoryRecord(f.steps[index].body) }
function mountinfo(f: ReturnType<typeof fixture>, change: (info: string) => string) {
  const info = change(f.output.mountinfoBefore)
  f.output.mountinfoBefore = info; f.output.mountinfoAfter = info
}

test('Agent consumer mount observation preserves original bindings without issuing authority', async t => {
  for (const mode of ['RO', 'RW'] as const) {
    await t.test(`original protected ${mode} and common shared RW use exact claims and fixed probe`, async () => {
      const f = fixture(models(mode)), s = signal()
      const result = await createAgentMountCollector(f.configuration, f.dependencies).collect(f.record, f.podUid, s)
      assert.equal(result.planDigest, f.record.planDigest); assert.equal(result.pod.uid, f.podUid)
      assert.deepEqual(result.mounts.map(m => m.mode), [mode, 'RW'])
      assert.equal(result.mounts[0].clientStat.device, '23'); assert.equal(result.mounts[0].clientStat.inode, '400')
      assert.equal(result.mounts[1].clientStat.uid, 0); assert.equal(result.mounts[1].clientStat.mode, '0770')
      assert.equal(result.storage[0].pv.name, 'consumer-nfs-pv-0')
      assert.equal(result.namespacePin, false); assert.equal(result.writerGrantIssued, false); assert.equal(result.providerReady, false)
      assert.equal(result.probeDigest, agentMountProbeSha256); assert.match(result.evidenceDigest, /^[a-f0-9]{64}$/u)
      assert.equal(result.reference, `agent-mount-sha256:${result.evidenceDigest}`)
      assert.equal(f.api.requests.length, 10); assert.equal(f.opened.length, 1)
      assert.deepEqual(f.opened[0].url.searchParams.getAll('command'), ['/usr/local/bin/node', '-e', agentMountProbeSource, '{"roots":["/agent","/shared"]}'])
      assert.equal(f.opened[0].url.searchParams.get('container'), 'agent')
      assert.equal(f.opened[0].options.rejectUnauthorized, true); assert.equal(f.opened[0].options.followRedirects, false)
      assert.equal(f.api.requests.every(r => r.options.method === 'GET'), true)
      assert.equal(JSON.stringify(result).includes(reviewerToken), false)
      assert.equal(getEventListeners(s, 'abort').length, 0); await f.assertCleanup()
    })
  }
  await t.test('multiple original protected bindings remain independent consumer observations', async () => {
    const f = fixture(models('RO', true))
    const result = await createAgentMountCollector(f.configuration, f.dependencies).collect(f.record, f.podUid, signal())
    assert.deepEqual(result.mounts.map(m => [m.key, m.clientPath, m.mode]), [['home', '/agent/home', 'RW'], ['project', '/agent/project', 'RO'], ['shared', '/shared', 'RW']])
    assert.equal(f.api.requests.length, 14); await f.assertCleanup()
  })
  await t.test('input, dependency methods/receivers and CA are captured before credential await', async () => {
    const f = fixture(), credentials = deferred<string>(), depsReceiver = f.dependencies
    let readerThis = false, openThis = false, requestThis = false
    const httpsReceiver = f.dependencies.https, request = httpsReceiver.request, open = f.dependencies.openWebSocket
    const caller = { ...f.configuration, readReviewerBearer() { readerThis = this === caller; return credentials.promise } }
    const deps = { ...depsReceiver, https: { request(...args: Parameters<typeof request>) { requestThis = this === deps.https; return request.apply(httpsReceiver, args) } },
      openWebSocket(...args: Parameters<typeof open>) { openThis = this === deps; return open.apply(depsReceiver, args) } }
    const record = structuredClone(f.record), collector = createAgentMountCollector(caller, deps)
    const result = collector.collect(record, f.podUid, signal())
    inventoryRecord(record.plan.mountExpectations.shared).serverPath = '/wrong'
    caller.ca.fill(0); deps.openWebSocket = () => { throw new Error('changed') }
    credentials.resolve(reviewerToken)
    const observed = await result
    assert.equal(observed.mounts[1].serverPath, '/exports/shared/dataset-fixture')
    assert.equal(readerThis && openThis && requestThis, true)
    assert.equal(Buffer.from(f.opened[0].options.ca as Uint8Array).toString(), 'fixture-ca')
    await f.assertCleanup()
  })
})

test('Agent mount collector rejects original Pod/PVC/PV substitutions and changes', async t => {
  for (const change of ['uid', 'pending', 'sidecar', 'mount'] as const) {
    await t.test(`reject initial Pod ${change} before exec`, async () => {
      const f = fixture(), p = body(f, 0)
      if (change === 'uid') { inventoryRecord(p.metadata).uid = 'wrong-pod' }
      if (change === 'pending') { inventoryRecord(p.status).phase = 'Pending' }
      if (change === 'sidecar') { p.spec = { ...inventoryRecord(p.spec), containers: [...f.pod.spec.containers, f.pod.spec.containers[0]] } }
      if (change === 'mount') {
        const c = f.pod.spec.containers[0]
        p.spec = { ...inventoryRecord(p.spec), containers: [{ ...c, volumeMounts: [...c.volumeMounts, { name: 'unexpected', mountPath: '/agent/nested' }] }] }
      }
      await rejected(f, 'POD_IDENTITY'); assert.equal(f.opened.length, 0)
    })
  }
  for (const change of ['claimUid', 'pvUid', 'claimRef', 'source', 'parent', 'csi'] as const) {
    await t.test(`reject initial storage ${change}`, async () => {
      const f = fixture(), pvc = body(f, 1), pv = body(f, 2), spec = inventoryRecord(pv.spec)
      if (change === 'claimUid') { inventoryRecord(pvc.metadata).uid = 'replacement' }
      if (change === 'pvUid') { inventoryRecord(pv.metadata).uid = 'server-ssd-pv-instead-of-consumer' }
      if (change === 'claimRef') { inventoryRecord(spec.claimRef).uid = 'replacement' }
      if (change === 'source') { inventoryRecord(spec.nfs).server = 'other.invalid' }
      if (change === 'parent') { inventoryRecord(spec.nfs).path = '/exports/runtime-domains/dataset-fixture' }
      if (change === 'csi') { spec.csi = { driver: 'pd.csi.storage.gke.io' } }
      await rejected(f, 'STORAGE_IDENTITY'); assert.equal(f.opened.length, 0)
    })
  }
  for (const change of ['containerID', 'restartCount', 'startedAt', 'podUid'] as const) {
    await t.test(`reject final incarnation ${change}`, async () => {
      const f = fixture(), p = body(f, 9), c = inventoryRecord(agentPodArray(inventoryRecord(p.status).containerStatuses)[0])
      if (change === 'containerID') { c.containerID = 'containerd://different' }
      if (change === 'restartCount') { c.restartCount = 1 }
      if (change === 'startedAt') { inventoryRecord(inventoryRecord(c.state).running).startedAt = '2026-10-16T04:24:00.000Z' }
      if (change === 'podUid') { inventoryRecord(p.metadata).uid = 'replacement' }
      await rejected(f, change === 'podUid' ? 'POD_IDENTITY' : 'POD_CHANGED')
    })
  }
  for (const change of ['pvcUid', 'pvUid', 'export', 'mode', 'volumeName'] as const) {
    await t.test(`reject storage change after exec ${change}`, async () => {
      const f = fixture(), pvc = body(f, 5), pv = body(f, 6), spec = inventoryRecord(pv.spec)
      if (change === 'pvcUid') { inventoryRecord(pvc.metadata).uid = 'replacement' }
      if (change === 'pvUid') { inventoryRecord(pv.metadata).uid = 'replacement' }
      if (change === 'export') { inventoryRecord(spec.nfs).path = String(inventoryRecord(spec.nfs).path) + '/other' }
      if (change === 'mode') { inventoryRecord(spec.nfs).readOnly = true }
      if (change === 'volumeName') { inventoryRecord(pvc.spec).volumeName = 'different-nfs-pv' }
      await rejected(f, change === 'mode' ? 'STORAGE_CHANGED' : 'STORAGE_IDENTITY')
    })
  }
})

test('Agent probe rejects uncertain or mismatched consumer mount state', async t => {
  for (const change of ['wrong-source', 'parent-export', 'protected-rw', 'shared-ro', 'nested', 'non-nfs', 'device', 'symlink', 'escape', 'changed', 'extra-key'] as const) {
    await t.test(change, async () => {
      const f = fixture(), r = f.output.roots[0]
      if (change === 'wrong-source') { mountinfo(f, info => info.replace('nfs.fixture.svc.cluster.local:', 'other.invalid:')) }
      if (change === 'parent-export') { mountinfo(f, info => info.replace(f.expectations[0].serverPath, '/exports/runtime-domains/dataset-fixture')) }
      if (change === 'protected-rw') { mountinfo(f, info => info.replace('/agent ro', '/agent rw')) }
      if (change === 'shared-ro') { mountinfo(f, info => info.replace('/shared rw', '/shared ro')) }
      if (change === 'nested') { mountinfo(f, info => info + '\n90 10 0:90 / /agent/nested rw - tmpfs none rw') }
      if (change === 'non-nfs') { mountinfo(f, info => info.replace(' - nfs4 ', ' - ext4 ')) }
      if (change === 'device') { r.before.stat.device = '99'; r.before.lstat.device = '99'; r.after = structuredClone(r.before) }
      if (change === 'symlink') { r.before.lstat.symlink = true }
      if (change === 'escape') { r.before.realPath = '/shared' }
      if (change === 'changed') { r.after.stat.inode = '999'; r.after.lstat.inode = '999' }
      if (change === 'extra-key') { Object.assign(f.output, { serverStat: 'not-consumer-evidence' }) }
      await rejected(f, change === 'changed' ? 'MOUNT_CHANGED' : change === 'extra-key' ? 'OUTPUT_INVALID' : 'MOUNT_MISMATCH')
    })
  }
  await t.test('mountinfo changes during probe are rejected', async () => {
    const f = fixture(); f.output.mountinfoAfter += '\n99 1 0:99 / /tmp rw - tmpfs none rw'
    await rejected(f, 'MOUNT_CHANGED')
  })
  for (const failure of ['json', 'stderr', 'utf8', 'oversize', 'protocol'] as const) {
    await t.test(`invalid stdout or exec ${failure} never carries private raw errors`, async () => {
      const f = fixture(models(), (socket, output) => {
        if (failure === 'json') { finish(socket, 'not-json synthetic-private-output') }
        if (failure === 'stderr') { socket.frame(2, 'synthetic-private-stderr') }
        if (failure === 'utf8') { socket.frame(1, Buffer.from([0xff])) }
        if (failure === 'oversize') { socket.frame(1, 'x'.repeat(agentMountOutputLimit + 1)) }
        if (failure === 'protocol') { socket.frame(0, output) }
      })
      await rejected(f, failure === 'json' ? 'OUTPUT_INVALID' : failure === 'stderr' ? 'EXEC_FAILED' : 'EXEC_PROTOCOL')
    })
  }
})

test('one deadline and cancellation clean HTTP/WS/credential state without retry', async t => {
  await t.test('already aborted never reads a credential or opens transport', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort()
    f.configuration = { ...f.configuration, readReviewerBearer() { throw new Error('must not enter') } }
    await rejected(f, 'ABORTED', controller.signal); assert.equal(f.api.requests.length, 0)
  })
  await t.test('credential wait consumes the same total deadline', async () => {
    const f = fixture(), credential = deferred<string>()
    f.configuration = { ...f.configuration, timeoutMs: 20, readReviewerBearer: () => credential.promise }
    await rejected(f, 'TIMEOUT'); credential.resolve(reviewerToken); assert.equal(f.api.requests.length, 0)
  })
  await t.test('caller cancels pending HTTP without another request', async () => {
    const f = fixture(), controller = new AbortController(); f.steps[0].stallBody = true
    const result = createAgentMountCollector(f.configuration, f.dependencies).collect(f.record, f.podUid, controller.signal)
    await f.api.reached[0].promise; controller.abort()
    await assert.rejects(result, { code: 'ABORTED' }); await f.assertCleanup(); assert.equal(f.api.requests.length, 1)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })
  await t.test('caller cancels pending WS and never performs final GETs', async () => {
    const entered = deferred<void>(), f = fixture(models(), () => entered.resolve()), controller = new AbortController()
    const result = createAgentMountCollector(f.configuration, f.dependencies).collect(f.record, f.podUid, controller.signal)
    await entered.promise; controller.abort()
    await assert.rejects(result, { code: 'ABORTED' }); await f.assertCleanup(); assert.equal(f.api.requests.length, 5)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })
  await t.test('credential, HTTP and WS do not receive fresh timeout budgets', async () => {
    const f = fixture(models(), () => {}), credentials = deferred<string>()
    f.configuration = { ...f.configuration, timeoutMs: 100, readReviewerBearer: () => credentials.promise }
    const result = createAgentMountCollector(f.configuration, f.dependencies).collect(f.record, f.podUid, signal())
    await delay(40); credentials.resolve(reviewerToken)
    await assert.rejects(result, { code: 'TIMEOUT' })
    assert.equal(f.opened.length, 1); assert.ok((f.opened[0].options.handshakeTimeout ?? 100) < 100)
    assert.equal(f.api.requests.length, 5); await f.assertCleanup()
  })
  await t.test('HTTP/TLS errors retain only fixed sanitized codes', async () => {
    const f = fixture(); f.steps[0].errorCode = 'CERT_HAS_EXPIRED'
    await rejected(f, 'TLS_FAILED'); assert.equal(f.api.requests.length, 1)
  })
  await t.test('invalid API configuration never invokes an effect', () => {
    const f = fixture()
    assert.throws(() => createAgentMountCollector({ ...f.configuration, apiOrigin: 'http://kubernetes.invalid' }, f.dependencies), { code: 'CONFIG_INVALID' })
    assert.equal(f.api.requests.length, 0)
  })
})
