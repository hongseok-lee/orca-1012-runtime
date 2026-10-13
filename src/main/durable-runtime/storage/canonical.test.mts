import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeObservation, parseMountInfo, overlaps, sameDirectory, StorageError,
  type DirectoryObservation, type DomainAuthority } from './canonical.ts';
const mountinfo = '10 1 259:13 / /exports rw - ext4 /dev/disk rw\n11 10 259:13 /x /x rw - ext4 /dev/disk rw';
const authority: DomainAuthority = { domain: { backendId: 'pv-domain', exportId: 'whole-pv', pvUid: 'fixture-pv' },
  podUid: 'fixture-server', generation: 'fixture-generation-1', backingRoot: '/', allowedMountIds: ['10','11'] };
const observation = (realPath = '/x/home'): DirectoryObservation => ({ podUid: authority.podUid,
  generation: authority.generation, realPath, stat: { device: '123', inode: '42', directory: true },
  backingPath: '/exports/x/home', backingRealPath: '/exports/x/home',
  backingStat: { device: '123', inode: '42', directory: true }, mountinfo });
const rejection = (fn: () => unknown, code: string) => assert.throws(fn, e => e instanceof StorageError && e.code === code);
test('bind aliases map to the same PV canonical directory, not distinct exports', () => {
  const a = canonicalizeObservation(observation(), authority);
  const b = canonicalizeObservation(observation('/exports/x/home'), authority);
  assert.equal(a.canonicalDirectory, '/x/home'); assert.ok(sameDirectory(a,b));
  assert.ok(overlaps(a, { ...a, canonicalDirectory: '/x' }));
  assert.ok(overlaps(a, { ...a, canonicalDirectory: '/' }));
  assert.ok(!overlaps(a, { ...a, canonicalDirectory: '/x/homes' }));
});
test('duplicate separators and dots normalize; resolved symlink path uses backing identity', () => {
  assert.equal(canonicalizeObservation(observation('/x//./home'), authority).canonicalDirectory, '/x/home');
  const resolvedSymlink = observation('/exports/x/home');
  assert.equal(canonicalizeObservation(resolvedSymlink, authority).canonicalDirectory, '/x/home');
});
test('longest mount boundary and escaped fields are parsed conservatively', () => {
  const escaped = parseMountInfo('22 10 259:13 /space\\040dir /mount\\040point rw - ext4 /dev/disk rw');
  assert.equal(escaped[0].root, '/space dir'); assert.equal(escaped[0].point, '/mount point');
  rejection(() => parseMountInfo('22 10 259:13 /bad\\777 /mount rw - ext4 /dev/disk rw'), 'MOUNT_ESCAPE_INVALID');
  const nested = { ...observation(), mountinfo: mountinfo + '\n12 11 0:22 / /x/home rw - tmpfs none rw' };
  rejection(() => canonicalizeObservation(nested, authority), 'MOUNT_UNTRUSTED');
  rejection(() => canonicalizeObservation({ ...observation(), realPath: '/xx/home' }, authority), 'MOUNT_UNTRUSTED');
});
test('inode/device/generation/PV domain escape or non-directory fail closed', () => {
  rejection(() => canonicalizeObservation({ ...observation(), backingStat: { device: '123', inode: '43', directory: true } }, authority), 'BACKING_IDENTITY_MISMATCH');
  rejection(() => canonicalizeObservation({ ...observation(), stat: { device: '456', inode: '42', directory: true } }, authority), 'BACKING_IDENTITY_MISMATCH');
  rejection(() => canonicalizeObservation({ ...observation(), generation: 'changed' }, authority), 'OBSERVATION_IDENTITY');
  rejection(() => canonicalizeObservation(observation(), { ...authority, backingRoot: '/other' }), 'DOMAIN_ESCAPE');
  rejection(() => canonicalizeObservation({ ...observation(), stat: { device: '123', inode: '42', directory: false } }, authority), 'BACKING_IDENTITY_MISMATCH');
});
test('mount root and root canonical directory are independent of local mountpoint', () => {
  const o = { ...observation('/x'), backingPath: '/exports/x', backingRealPath: '/exports/x' };
  assert.equal(canonicalizeObservation(o, { ...authority, backingRoot: '/x' }).canonicalDirectory, '/');
});
