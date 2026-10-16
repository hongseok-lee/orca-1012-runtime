import { createHash } from 'node:crypto'
import { agentPodArray, agentPodFields, agentPodPath } from '../runtime/agent-pod-policy.ts'
import { containsPath, decodeMountField, parseMountInfo } from './canonical.ts'
import { AgentMountCollectorError } from './agent-mount-collector-types.ts'
import type { AgentMountClientStat, AgentMountExpectation, AgentMountRootObservation } from './agent-mount-collector-types.ts'

export const agentMountOutputLimit = 2 * 1024 * 1024
/** Fixed read-only Node program. argv[1] is a captured root list, never shell source or an override. */
export const agentMountProbeSource = String.raw`
'use strict';
const fs = require('node:fs');
try {
  const input = JSON.parse(process.argv[1]);
  if (!input || Object.keys(input).join(',') !== 'roots' || !Array.isArray(input.roots) || !input.roots.length ||
      input.roots.some(p => typeof p !== 'string' || !(p === '/shared' || p === '/agent' || p.startsWith('/agent/')) ||
        p.split('/').some(x => x === '.' || x === '..') || /[\\\x00-\x1f\x7f]/u.test(p))) { throw new Error(); }
  function mountinfo() {
    const fd = fs.openSync('/proc/self/mountinfo', 'r'), bytes = Buffer.alloc(524289);
    let count = 0;
    try {
      while (count < bytes.length) {
        const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
        if (!read) { break; }
        count += read;
      }
      if (count > 524288) { throw new Error(); }
      return new (require('node:util').TextDecoder)('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
    } finally { fs.closeSync(fd); }
  }
  function stat(s) {
    return { device: String(s.dev), inode: String(s.ino), uid: Number(s.uid), gid: Number(s.gid),
      mode: (s.mode & 4095n).toString(8).padStart(4, '0'), directory: s.isDirectory(), symlink: s.isSymbolicLink() };
  }
  function root(path) {
    return { realPath: fs.realpathSync(path), lstat: stat(fs.lstatSync(path, { bigint: true })),
      stat: stat(fs.statSync(path, { bigint: true })) };
  }
  const before = mountinfo(), roots = input.roots.map(path => ({ path, before: root(path) }));
  const complete = roots.map(item => ({ ...item, after: root(item.path) })), after = mountinfo();
  const output = JSON.stringify({ kind: 'AGENT_MOUNT_PROBE_1', uid: process.getuid(), gid: process.getgid(),
    mountinfoBefore: before, mountinfoAfter: after, roots: complete });
  if (Buffer.byteLength(output) > 2097152) { throw new Error(); }
  process.stdout.write(output);
} catch { process.stderr.write('AGENT_MOUNT_PROBE_FAILED'); process.exitCode = 1; }
`
export const agentMountProbeSha256 = createHash('sha256').update(agentMountProbeSource).digest('hex')
function invalid(): never { throw new AgentMountCollectorError('OUTPUT_INVALID') }
function mismatch(): never { throw new AgentMountCollectorError('MOUNT_MISMATCH') }
function changed(): never { throw new AgentMountCollectorError('MOUNT_CHANGED') }
function directory(value: unknown): AgentMountClientStat {
  const data = agentPodFields(value, ['device', 'inode', 'uid', 'gid', 'mode', 'directory', 'symlink'])
  const device = data.get('device'), inode = data.get('inode'), uid = data.get('uid'), gid = data.get('gid'), mode = data.get('mode')
  if (typeof device !== 'string' || !/^(0|[1-9][0-9]{0,19})$/u.test(device) ||
      typeof inode !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(inode) ||
      typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0 ||
      typeof gid !== 'number' || !Number.isSafeInteger(gid) || gid < 0 ||
      typeof mode !== 'string' || !/^[0-7]{4}$/u.test(mode)) { return invalid() }
  if (data.get('directory') !== true || data.get('symlink') !== false) { return mismatch() }
  return Object.freeze({ device, inode, uid, gid, mode })
}
function root(value: unknown, expected: AgentMountExpectation) {
  const data = agentPodFields(value, ['realPath', 'lstat', 'stat'])
  if (agentPodPath(data.get('realPath')) !== expected.clientPath) { return mismatch() }
  const lstat = directory(data.get('lstat')), stat = directory(data.get('stat'))
  if (JSON.stringify(lstat) !== JSON.stringify(stat)) { return changed() }
  return stat
}
function mountMode(options: readonly string[]): 'RO' | 'RW' {
  const modes = options.filter(value => value === 'ro' || value === 'rw')
  if (modes.length !== 1) { return mismatch() }
  return modes[0] === 'ro' ? 'RO' : 'RW'
}
function deviceNumber(device: string): string {
  const d = BigInt(device)
  const major = ((d >> 8n) & 0xfffn) | ((d >> 32n) & 0xfffff000n)
  const minor = (d & 0xffn) | ((d >> 12n) & 0xffffff00n)
  return `${major}:${minor}`
}

/** Consumer-only observations; never manufacture a server canonical identity or physical proof. */
export function projectAgentMountOutput(text: string, expected: readonly AgentMountExpectation[]): readonly AgentMountRootObservation[] {
  try {
    if (Buffer.byteLength(text) > agentMountOutputLimit) { return invalid() }
    const data = agentPodFields(JSON.parse(text), ['kind', 'uid', 'gid', 'mountinfoBefore', 'mountinfoAfter', 'roots'])
    const before = data.get('mountinfoBefore'), after = data.get('mountinfoAfter')
    if (data.get('kind') !== 'AGENT_MOUNT_PROBE_1' || data.get('uid') !== 1000 || data.get('gid') !== 1000 ||
        typeof before !== 'string' || typeof after !== 'string' || !before || Buffer.byteLength(before) > 524288) { return invalid() }
    if (before !== after) { return changed() }
    const mounts = parseMountInfo(before), lines = before.trim().split('\n').filter(Boolean)
    if (new Set(mounts.map(item => item.id)).size !== mounts.length) { return mismatch() }
    const roots = agentPodArray(data.get('roots'))
    if (roots.length !== expected.length) { return invalid() }
    return Object.freeze(roots.map((value, index) => {
      const item = expected[index], fields = agentPodFields(value, ['path', 'before', 'after'])
      if (fields.get('path') !== item.clientPath) { return mismatch() }
      const first = root(fields.get('before'), item), last = root(fields.get('after'), item)
      if (JSON.stringify(first) !== JSON.stringify(last)) { return changed() }
      const eligible = mounts.filter(m => containsPath(m.point, item.clientPath)).sort((a, b) => b.point.length - a.point.length)
      const selected = eligible[0]
      if (!selected || selected.point !== item.clientPath || eligible.filter(m => m.point === selected.point).length !== 1 ||
          mounts.some(m => m.point !== item.clientPath && containsPath(item.clientPath, m.point)) ||
          selected.root !== '/' || selected.filesystem !== 'nfs' && selected.filesystem !== 'nfs4' ||
          selected.device !== deviceNumber(first.device)) { return mismatch() }
      const parts = lines[mounts.indexOf(selected)].split(' '), separator = parts.indexOf('-')
      // Reuse the canonical parser, but do not let its path normalization hide unexpected mount paths.
      if (agentPodPath(decodeMountField(parts[3])) !== selected.root ||
          agentPodPath(decodeMountField(parts[4])) !== selected.point) { return mismatch() }
      const source = decodeMountField(parts[separator + 2]), superMode = mountMode(parts[separator + 3].split(','))
      const exactSource = `${item.server}:${item.serverPath}`, bracketSource = `[${item.server}]:${item.serverPath}`
      const mode = mountMode(selected.options)
      if (source !== exactSource && source !== bracketSource || mode !== item.mode || mode === 'RW' && superMode !== 'RW') { return mismatch() }
      return Object.freeze({ kind: item.kind, key: item.key, clientPath: item.clientPath, realPath: item.clientPath,
        mode, filesystem: selected.filesystem, mountId: selected.id, mountDevice: selected.device,
        nfsSource: source, serverPath: item.serverPath, superMode, clientStat: first })
    }))
  } catch (error) {
    if (error instanceof AgentMountCollectorError) { throw error }
    return invalid()
  }
}
