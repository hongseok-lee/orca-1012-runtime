import { createHash } from 'node:crypto'
import { parseMountInfo } from './canonical.ts'
import { canonicalizeManagedLeaf } from './managed-leaf-canonical.ts'
import { managedLeafRecord, managedLeafPodIncarnation } from './managed-leaf-collector-pod.ts'
import { ManagedLeafCollectorError } from './managed-leaf-collector-types.ts'
import type { ManagedLeafCollectorConfig, ManagedLeafPod } from './managed-leaf-collector-types.ts'
import type { CanonicalCandidate } from './canonical.ts'

function directory(value: unknown, expected: string, uid: number, gid: number, mode: string) {
  const row = managedLeafRecord(value)
  if (Object.keys(row).length !== 6 || row.path !== expected || row.uid !== uid || row.gid !== gid || row.mode !== mode ||
      typeof row.device !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.device) ||
      typeof row.inode !== 'string' || !/^[1-9][0-9]*$/.test(row.inode)) { throw new ManagedLeafCollectorError('OUTPUT_INVALID') }
  return { device: row.device, inode: row.inode, directory: true }
}
export function projectManagedLeafOutput(stdout: string, config: ManagedLeafCollectorConfig,
  leafId: string, pod: ManagedLeafPod): Readonly<{ candidate: CanonicalCandidate; outputDigest: string }> {
  try {
    const prefix = 'ORCA_MANAGED_LEAF_1\nMOUNTINFO_BEFORE\n', middle = '\nHELPER_JSON\n'
    const after = '\nMOUNTINFO_AFTER\n', suffix = '\nORCA_MANAGED_LEAF_END\n'
    if (!stdout.startsWith(prefix) || !stdout.endsWith(suffix)) { throw new ManagedLeafCollectorError('OUTPUT_INVALID') }
    const middleIndex = stdout.indexOf(middle, prefix.length), afterIndex = stdout.indexOf(after, middleIndex + middle.length)
    if (middleIndex < 0 || afterIndex < 0) { throw new ManagedLeafCollectorError('OUTPUT_INVALID') }
    const beforeInfo = stdout.slice(prefix.length, middleIndex)
    const afterInfo = stdout.slice(afterIndex + after.length, -suffix.length)
    if (beforeInfo !== afterInfo) { throw new ManagedLeafCollectorError('MOUNT_CHANGED') }
    const raw = managedLeafRecord(JSON.parse(stdout.slice(middleIndex + middle.length, afterIndex)))
    if (Object.keys(raw).length !== 12 || raw.schemaVersion !== 1 || raw.kind !== 'managed-nfs-namespace-raw' ||
        raw.operation !== 'inspect-leaf' || raw.dataset !== config.dataset || raw.leafId !== leafId || raw.podUid !== config.podUid ||
        raw.created !== false || !Array.isArray(raw.createdPaths) || raw.createdPaths.length !== 0) { throw new ManagedLeafCollectorError('OUTPUT_INVALID') }
    const backing = directory(raw.backingRoot, '/exports', 0, 0, '0755')
    const managed = directory(raw.managedRoot, '/exports/runtime-domains', 0, 0, '0755')
    const parent = directory(raw.parent, `/exports/runtime-domains/${config.dataset}`, 0, 0, '0755')
    const leafPath = `/exports/runtime-domains/${config.dataset}/${leafId}`
    const leaf = directory(raw.leaf, leafPath, 1000, 1000, '0700')
    if ([managed, parent, leaf].some(row => row.device !== backing.device)) { throw new ManagedLeafCollectorError('OUTPUT_INVALID') }
    const mounts = parseMountInfo(beforeInfo), backingMounts = mounts.filter(mount => mount.point === '/exports')
    if (backingMounts.length !== 1 || backingMounts[0].root !== '/' || backingMounts[0].device.startsWith('0:')) {
      throw new ManagedLeafCollectorError('OUTPUT_INVALID')
    }
    const device = BigInt(backing.device)
    const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n)
    const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n)
    if (backingMounts[0].device !== `${major}:${minor}`) { throw new ManagedLeafCollectorError('OUTPUT_INVALID') }
    const generation = createHash('sha256').update(managedLeafPodIncarnation(pod)).digest('hex')
    const observation = Object.freeze({ podUid: pod.uid, generation, realPath: leafPath, stat: Object.freeze(leaf),
      backingPath: leafPath, backingRealPath: leafPath, backingStat: Object.freeze({ ...leaf }), mountinfo: beforeInfo })
    const candidate = canonicalizeManagedLeaf(observation, observation, {
      domain: { backendId: config.backendId, exportId: config.exportId, pvUid: config.pvUid },
      podUid: pod.uid, generation, backingRoot: '/runtime-domains', allowedMountIds: [backingMounts[0].id],
    }, { dataset: config.dataset, leafId })
    return Object.freeze({ candidate, outputDigest: createHash('sha256').update(stdout).digest('hex') })
  } catch (error) {
    if (error instanceof ManagedLeafCollectorError) { throw error }
    throw new ManagedLeafCollectorError('OUTPUT_INVALID')
  }
}
