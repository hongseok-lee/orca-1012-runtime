import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureUnitStorageVolume } from './unit-storage-volume.ts'
import { harness } from '../runtime/kubernetes-pod-auth-fixtures.mts'
function policy() {
  return { namespace: 'agent-fixture', dataset: 'dataset-fixture', image: `example.invalid/agent@sha256:${'1'.repeat(64)}`,
    entrypoint: { command: ['/opt/agent/entrypoint'], args: ['--resume-mode', 'cold', ''] },
    paths: { home: '/agent/home', claudeState: '/agent/home/.claude', codexState: '/agent/home/.codex', checkout: '/agent/project' },
    protectedMounts: [{ key: 'main', clientPath: '/agent' }],
    nfsServer: 'nfs.fixture.svc.cluster.local', protectedExportRoot: '/exports/runtime-domains/dataset-fixture',
    shared: { claimName: 'shared-fixture', claimUid: 'shared-claim-opaque', pvUid: 'shared-pv-opaque', serverPath: '/exports/shared/dataset-fixture' } }
}

test('unit NFS volumes reconcile lost CREATE responses and reject foreign mounts without modifying them', async () => {
  const unitId = '00000000-0000-4000-8000-000000000001', bindingId = '00000000-0000-4000-8000-000000000002'
  const p = policy(), name = `orca-home-${unitId}`
  const template = { key: 'main', bindingId, leafId: '00000000-0000-4000-8000-000000000003',
    claimName: 'original-home', claimUid: 'original-claim', pvUid: 'original-volume', serverPath: `${p.protectedExportRoot}/original`, mode: 'RW' }
  const sourceClaim = { metadata: { uid: template.claimUid }, spec: { volumeName: 'original-pv' } }
  const sourceVolume = { metadata: { uid: template.pvUid }, spec: { capacity: { storage: '50Gi' }, mountOptions: ['vers=3','hard'],
    nfs: { server: p.nfsServer, path: template.serverPath }, claimRef: { namespace: p.namespace, name: template.claimName, uid: template.claimUid } } }
  const labels = { 'orca.dev/dataset': p.dataset, 'orca.dev/runtime-unit': unitId }
  const common = { accessModes: ['ReadWriteMany'], volumeMode: 'Filesystem', storageClassName: '' }
  const pv = { kind: 'PersistentVolume', metadata: { name, uid: 'new-pv', labels }, spec: { ...common, storageClassName: undefined,
    capacity: { storage: '50Gi' }, mountOptions: ['vers=3','hard'], persistentVolumeReclaimPolicy: 'Retain',
    nfs: { server: p.nfsServer, path: `${p.protectedExportRoot}/${unitId}` }, claimRef: { namespace: p.namespace, name } } }
  const pvc = { kind: 'PersistentVolumeClaim', metadata: { name, namespace: p.namespace, uid: 'new-pvc', labels },
    spec: { ...common, volumeName: name, resources: { requests: { storage: '50Gi' } } } }
  const input = { apiOrigin: 'https://kubernetes.invalid', ca: Buffer.from('fixture'), reviewer: 'fixture', policy: p,
    unitId, bindingId, template, signal: new AbortController().signal }
  const h = harness([{ body: sourceClaim }, { body: sourceVolume }, { status: 404 }, { errorCode: 'ECONNRESET' },
    { body: pv }, { status: 404 }, { status: 201, body: pvc }])
  const result = await ensureUnitStorageVolume(input, h.transport)
  assert.equal(result.claimUid, 'new-pvc'); assert.equal(result.pvUid, 'new-pv')
  assert.equal(result.serverPath, pv.spec.nfs.path); assert.equal(result.leafId, unitId)
  assert.deepEqual(h.requests.map(r => r.options.method), ['GET','GET','GET','POST','GET','GET','POST'])
  const retry = harness([{ body: sourceClaim }, { body: sourceVolume }, { body: pv }, { body: pvc }])
  assert.deepEqual(await ensureUnitStorageVolume(input, retry.transport), result)
  assert.ok(retry.requests.every(r => r.options.method === 'GET'))
  const conflict = harness([{ body: sourceClaim }, { body: sourceVolume },
    { body: { ...pv, spec: { ...pv.spec, nfs: { ...pv.spec.nfs, path: template.serverPath } } } }])
  await assert.rejects(ensureUnitStorageVolume(input, conflict.transport), /UNIT_STORAGE_VOLUME_CONFLICT/)
  assert.ok(conflict.requests.every(r => r.options.method === 'GET'))
})
