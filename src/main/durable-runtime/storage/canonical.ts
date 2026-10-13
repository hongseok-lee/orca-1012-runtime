import path from 'node:path';

export class StorageError extends Error {
  constructor(readonly code: string) { super(`Storage operation failed (${code})`); }
}
export type StorageDomain = Readonly<{ backendId: string; exportId: string; pvUid: string }>;
export type MountInfo = Readonly<{
  id: string; parentId: string; device: string; root: string; point: string;
  filesystem: string; options: readonly string[];
}>;
export type DirectoryStat = Readonly<{ device: string; inode: string; directory: boolean }>;
export type DirectoryObservation = Readonly<{
  podUid: string; generation: string; realPath: string; stat: DirectoryStat;
  backingPath: string; backingRealPath: string; backingStat: DirectoryStat;
  mountinfo: string;
}>;
// Authority configuration is provisioned from PV/server identity, never inferred
// from IP, NFS source text, or local device numbers. Mount IDs pin this snapshot.
export type DomainAuthority = Readonly<{
  domain: StorageDomain; podUid: string; generation: string;
  backingRoot: string; allowedMountIds: readonly string[];
}>;
export type CanonicalCandidate = Readonly<{
  domain: StorageDomain; canonicalDirectory: string; podUid: string;
  generation: string; device: string; inode: string;
}>;
function fail(code: string): never { throw new StorageError(code); }
function absolute(value: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value))
    fail('PATH_INVALID');
  return path.posix.normalize(value).replace(/\/$/, '') || '/';
}
export function decodeMountField(value: string): string {
  if (/\\(?!040|011|012|134)/.test(value)) fail('MOUNT_ESCAPE_INVALID');
  return value.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}
export function parseMountInfo(text: string): readonly MountInfo[] {
  return text.trim().split('\n').filter(Boolean).map(line => {
    const fields = line.split(' '), separator = fields.indexOf('-');
    if (separator < 6 || fields.length !== separator + 4 ||
        !/^\d+$/.test(fields[0]) || !/^\d+:\d+$/.test(fields[2]))
      fail('MOUNTINFO_INVALID');
    return Object.freeze({ id: fields[0], parentId: fields[1], device: fields[2],
      root: absolute(decodeMountField(fields[3])), point: absolute(decodeMountField(fields[4])),
      filesystem: fields[separator + 1], options: fields[5].split(',') });
  });
}
export function containsPath(parent: string, child: string): boolean {
  return parent === '/' || child === parent || child.startsWith(parent + '/');
}
export function overlaps(a: CanonicalCandidate, b: CanonicalCandidate): boolean {
  return a.domain.backendId === b.domain.backendId && a.domain.exportId === b.domain.exportId &&
    (containsPath(a.canonicalDirectory, b.canonicalDirectory) || containsPath(b.canonicalDirectory, a.canonicalDirectory));
}
function backing(mounts: readonly MountInfo[], resolved: string, authority: DomainAuthority) {
  const eligible = mounts.filter(m => containsPath(m.point, resolved))
    .sort((a, b) => b.point.length - a.point.length);
  const mount = eligible[0];
  if (!mount || eligible.filter(m => m.point === mount.point).length !== 1 ||
      !authority.allowedMountIds.includes(mount.id)) fail('MOUNT_UNTRUSTED');
  const physical = absolute(path.posix.join(mount.root, path.posix.relative(mount.point, resolved)));
  if (!containsPath(absolute(authority.backingRoot), physical)) fail('DOMAIN_ESCAPE');
  return { mount, physical };
}
// This is normalization/consistency checking, NOT an authenticated proof factory.
// Only the trusted evidence boundary may attest observations and return a proof.
export function canonicalizeObservation(observation: DirectoryObservation, authority: DomainAuthority): CanonicalCandidate {
  if (!authority.domain.backendId || !authority.domain.exportId || !authority.domain.pvUid ||
      observation.podUid !== authority.podUid || observation.generation !== authority.generation)
    fail('OBSERVATION_IDENTITY');
  const mounts = parseMountInfo(observation.mountinfo);
  const first = backing(mounts, absolute(observation.realPath), authority);
  const second = backing(mounts, absolute(observation.backingRealPath), authority);
  if (first.physical !== second.physical || first.mount.device !== second.mount.device ||
      first.mount.filesystem !== second.mount.filesystem ||
      absolute(observation.backingPath) !== absolute(observation.backingRealPath) ||
      !observation.stat.directory || !observation.backingStat.directory ||
      !/^\d+$/.test(observation.stat.inode) || !/^\d+$/.test(observation.stat.device) ||
      observation.stat.inode !== observation.backingStat.inode ||
      observation.stat.device !== observation.backingStat.device) fail('BACKING_IDENTITY_MISMATCH');
  const canonicalDirectory = absolute('/' + path.posix.relative(absolute(authority.backingRoot), first.physical));
  return Object.freeze({ domain: Object.freeze({ ...authority.domain }), canonicalDirectory,
    podUid: observation.podUid, generation: observation.generation,
    device: observation.stat.device, inode: observation.stat.inode });
}
export function sameDirectory(a: CanonicalCandidate, b: CanonicalCandidate): boolean {
  return a.domain.backendId === b.domain.backendId && a.domain.exportId === b.domain.exportId &&
    a.domain.pvUid === b.domain.pvUid && a.canonicalDirectory === b.canonicalDirectory &&
    a.podUid === b.podUid && a.generation === b.generation && a.device === b.device && a.inode === b.inode;
}
