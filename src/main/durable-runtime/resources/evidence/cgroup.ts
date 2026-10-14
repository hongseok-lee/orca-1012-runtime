import type { CounterTransition, FailureTarget } from './types.ts'
import { decimal, evidenceTime, snapshotTarget, targetKey, text } from './normalize.ts'

export const CGROUP_FILES = ['memory.events.local', 'memory.peak', 'memory.max'] as const
export type CgroupFile = typeof CGROUP_FILES[number]
export type CgroupFileResult =
  | { readonly status: 'READ'; readonly value: string }
  | { readonly status: 'NOT_EXPOSED' | 'PERMISSION_DENIED' | 'READ_FAILED' | 'INVALID'; readonly errorClass: string }
export type CgroupIdentity = {
  readonly target: FailureTarget
  readonly cgroupIdentity: string
  readonly processIdentity: string
  readonly incarnation: string
}
// The boundary resolves and pins the exact original cgroup identity. No path
// from a payload is opened here; the reader can access only this file allowlist.
export type ReadonlyCgroupReader = {
  readFile(identity: CgroupIdentity, file: CgroupFile): Promise<string>
}
export type CgroupSample = {
  readonly sampleId: string
  readonly identity: CgroupIdentity
  readonly observedAt: string
  readonly files: Readonly<Record<CgroupFile, CgroupFileResult>>
  readonly counters: Readonly<Record<string, string>> | null
  readonly peak: string | null
  readonly max: string | null
}
function identitySnapshot(raw: CgroupIdentity): CgroupIdentity {
  return Object.freeze({ target: snapshotTarget(raw.target), cgroupIdentity: text(raw.cgroupIdentity, 'cgroup'),
    processIdentity: text(raw.processIdentity, 'process'), incarnation: text(raw.incarnation, 'incarnation') })
}
function parseEvents(value: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null)
  for (const line of value.trim().split('\n')) {
    const m = /^([a-z_]+)\s+([0-9]+)$/.exec(line)
    if (!m || Object.hasOwn(result, m[1])) {throw new Error('INVALID_COUNTER_FILE')}
    result[m[1]] = decimal(m[2], 'counter')
  }
  return Object.freeze(result)
}
export async function collectCgroupSample(reader: ReadonlyCgroupReader, raw: CgroupIdentity,
  sampleId: string, observedAt: string | Date): Promise<CgroupSample> {
  // Caller-owned arrays, Date and target strings are copied before the first await.
  const identity = identitySnapshot(raw), id = text(sampleId, 'sample'), at = evidenceTime(observedAt).original
  const files = {} as Record<CgroupFile, CgroupFileResult>
  let counters: Readonly<Record<string, string>> | null = null, peak: string | null = null, max: string | null = null
  for (const file of CGROUP_FILES) {
    try {
      const value = await reader.readFile(identity, file)
      if (typeof value !== 'string') {throw new Error('INVALID_COUNTER_FILE')}
      if (file === 'memory.events.local') {counters = parseEvents(value)}
      else if (file === 'memory.peak') {peak = decimal(value.trim(), 'peak')}
      else {max = value.trim() === 'max' ? 'max' : decimal(value.trim(), 'max')}
      files[file] = Object.freeze({ status: 'READ', value })
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
      const status = code === 'ENOENT' ? 'NOT_EXPOSED' : code === 'EACCES' || code === 'EPERM' ? 'PERMISSION_DENIED' :
        error instanceof Error && (error.message === 'INVALID_COUNTER_FILE' || error.message.startsWith('EVIDENCE_INPUT:')) ? 'INVALID' : 'READ_FAILED'
      files[file] = Object.freeze({ status, errorClass: status })
    }
  }
  return Object.freeze({ sampleId: id, identity, observedAt: at, files: Object.freeze(files), counters, peak, max })
}
export function cgroupCounterTransition(before: CgroupSample, after: CgroupSample,
  name: CounterTransition['counter']): { readonly status: 'INCREASED' | 'UNCHANGED' | 'RESET' | 'UNKNOWN'; readonly transition: CounterTransition | null } {
  const a = before.identity, b = after.identity
  if (targetKey(a.target) !== targetKey(b.target) || a.cgroupIdentity !== b.cgroupIdentity ||
      a.processIdentity !== b.processIdentity || a.incarnation !== b.incarnation || before.sampleId === after.sampleId ||
      BigInt(evidenceTime(before.observedAt).epochNanoseconds) >= BigInt(evidenceTime(after.observedAt).epochNanoseconds)) {
    return Object.freeze({ status: 'UNKNOWN', transition: null })
  }
  const previous = before.counters?.[name], current = after.counters?.[name]
  if (previous === undefined || current === undefined) {return Object.freeze({ status: 'UNKNOWN', transition: null })}
  const status = BigInt(current) < BigInt(previous) ? 'RESET' : current === previous ? 'UNCHANGED' : 'INCREASED'
  return Object.freeze({ status, transition: Object.freeze({ cgroupIdentity: a.cgroupIdentity, processIdentity: a.processIdentity,
    incarnation: a.incarnation, counter: name, previous, current, previousSampleId: before.sampleId, currentSampleId: after.sampleId }) })
}
