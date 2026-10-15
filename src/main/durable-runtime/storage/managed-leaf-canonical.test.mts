import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameDirectory, StorageError } from './canonical.ts';
import { canonicalizeManagedLeaf } from './managed-leaf-canonical.ts';

test('raw managed observations normalize to one immutable leaf root without issuing evidence', () => {
  const dataset = 'orca-1012-dev-v1';
  const leafA = '00000000-0000-4000-8000-00000000000a';
  const leafB = '00000000-0000-4000-8000-00000000000b';
  const address = `/${dataset}/${leafA}`;
  const authority = {
    domain: { backendId: 'fixture-server-pv', exportId: 'managed-root', pvUid: 'fixture-pv' },
    podUid: 'fixture-server', generation: 'fixture-generation',
    backingRoot: '/runtime-domains', allowedMountIds: ['10', '11', '12'],
  };
  const mountinfo = [
    '10 1 259:13 /runtime-domains /exports rw - ext4 /dev/disk rw',
    '11 1 259:13 /runtime-domains /alias rw - ext4 /dev/disk rw',
    `12 10 8:16 /runtime-domains${address}/mounted /exports${address}/mounted rw - ext4 /dev/other rw`,
  ].join('\n');
  const observe = (directory: string, inode = '100', device = '123', alias = false) => ({
    podUid: authority.podUid, generation: authority.generation,
    realPath: `${alias ? '/alias' : '/exports'}${directory}`,
    stat: { device, inode, directory: true },
    backingPath: `/exports${directory}`, backingRealPath: `/exports${directory}`,
    backingStat: { device, inode, directory: true }, mountinfo,
  });
  const managed = { dataset, leafId: leafA };
  const root = observe(address);
  const normalize = (requested: ReturnType<typeof observe>) =>
    canonicalizeManagedLeaf(requested, root, authority, managed);
  const reject = (action: () => unknown, code: string) => {
    assert.throws(action, error => error instanceof StorageError && error.code === code &&
      error.message === `Storage operation failed (${code})`);
  };

  const first = normalize(observe(`${address}/checkout`, '201'));
  const second = normalize(observe(`${address}/home`, '202', '123', true));
  const rootAlias = normalize(observe(address, '100', '123', true));
  assert.ok(sameDirectory(first, second));
  assert.ok(sameDirectory(first, rootAlias));
  assert.equal(first.canonicalDirectory, address);
  assert.equal(first.inode, '100');
  assert.equal(first.device, '123');
  assert.deepEqual(first.domain, authority.domain);
  const otherAddress = `/${dataset}/${leafB}`;
  const other = canonicalizeManagedLeaf(observe(`${otherAddress}/home`, '301'),
    observe(otherAddress, '300'), authority, { dataset, leafId: leafB });
  assert.equal(other.canonicalDirectory, otherAddress);
  assert.equal(other.inode, '300');
  assert.ok(!sameDirectory(first, other));

  reject(() => normalize(observe(otherAddress, '300')), 'MANAGED_LEAF_OUTSIDE');
  reject(() => normalize(observe(`${address}0/home`, '401')), 'MANAGED_LEAF_OUTSIDE');
  reject(() => normalize(observe('/outside/resolved-target', '402')), 'MANAGED_LEAF_OUTSIDE');
  reject(() => canonicalizeManagedLeaf(observe(otherAddress), observe(otherAddress), authority, managed),
    'MANAGED_LEAF_MISMATCH');
  reject(() => canonicalizeManagedLeaf(observe(`${address}/home`, '202'), root,
    { ...authority, backingRoot: `/runtime-domains${address}` }, managed), 'MANAGED_LEAF_MISMATCH');
  reject(() => normalize(observe(address, '999')), 'BACKING_IDENTITY_MISMATCH');
  reject(() => normalize(observe(`${address}/mounted/home`, '501', '456')), 'BACKING_IDENTITY_MISMATCH');
  reject(() => normalize({ ...observe(`${address}/home`), podUid: 'another-server' }), 'OBSERVATION_IDENTITY');
  reject(() => normalize({ ...observe(`${address}/home`), generation: 'another-generation' }), 'OBSERVATION_IDENTITY');

  const invalidDescriptors = [
    { dataset: '', leafId: leafA }, { dataset: '-invalid', leafId: leafA },
    { dataset: 'invalid-', leafId: leafA }, { dataset: 'Invalid', leafId: leafA },
    { dataset: 'invalid.name', leafId: leafA }, { dataset: 'a'.repeat(64), leafId: leafA },
    { dataset: `${dataset}\n`, leafId: leafA }, { dataset, leafId: leafA.toUpperCase() },
    { dataset, leafId: `${leafA}\n` }, { dataset, leafId: '../outside' },
  ];
  for (const invalid of invalidDescriptors) {
    reject(() => canonicalizeManagedLeaf(root, root, authority, invalid), 'MANAGED_DESCRIPTOR_INVALID');
  }
  for (const validDataset of ['a', '0', 'a'.repeat(63)]) {
    const validRoot = observe(`/${validDataset}/${leafA}`);
    assert.equal(canonicalizeManagedLeaf(validRoot, validRoot, authority,
      { dataset: validDataset, leafId: leafA }).canonicalDirectory, `/${validDataset}/${leafA}`);
  }

  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.domain));
  assert.equal(Reflect.set(first, 'inode', 'changed'), false);
  assert.equal(Reflect.set(first.domain, 'pvUid', 'changed'), false);
  root.realPath = '/changed'; root.backingPath = '/changed'; root.backingRealPath = '/changed';
  root.stat.inode = 'changed'; root.backingStat.device = 'changed';
  authority.domain.pvUid = 'changed'; authority.podUid = 'changed';
  managed.dataset = 'changed'; managed.leafId = leafB;
  assert.equal(first.canonicalDirectory, address);
  assert.equal(first.inode, '100');
  assert.equal(first.device, '123');
  assert.equal(first.domain.pvUid, 'fixture-pv');
  assert.equal(first.podUid, 'fixture-server');
});
