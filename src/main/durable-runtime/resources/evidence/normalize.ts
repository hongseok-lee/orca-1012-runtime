import { createHash } from 'node:crypto'
import { counter, logicalId } from '../../../../shared/durable-runtime/identity.ts'
import type { EvidenceAlias, EvidenceJson, EvidenceTime, FailureObservationInput,
  FailureTarget, PreparedFailureObservation, ExistingAliasBinding, AliasResolution } from './types.ts'

export function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.includes('\u0000')) throw new Error('EVIDENCE_INPUT:' + name)
  return value
}
export function decimal(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('EVIDENCE_INPUT:' + name)
  return value
}
export function evidenceTime(value: string | Date): EvidenceTime {
  const original = value instanceof Date ? value.toISOString() : text(value, 'time')
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(original)
  if (!m) throw new Error('EVIDENCE_INPUT:time')
  const base = Date.parse(m[1] + m[3])
  if (!Number.isFinite(base)) throw new Error('EVIDENCE_INPUT:time')
  // Preserve sub-millisecond precision instead of Date's lossy normalization.
  return Object.freeze({ original, epochNanoseconds: (BigInt(base) * 1000000n + BigInt((m[2] ?? '').padEnd(9, '0'))).toString() })
}
export function snapshotJson(value: unknown): EvidenceJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotJson))
  if (typeof value === 'object' && value !== null &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const copy: { [key: string]: EvidenceJson } = Object.create(null)
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) throw new Error('EVIDENCE_INPUT:accessor')
      copy[key] = snapshotJson(descriptor.value)
    }
    return Object.freeze(copy)
  }
  throw new Error('EVIDENCE_INPUT:json')
}
export function evidenceDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(snapshotJson(value))).digest('hex')
}
export function snapshotTarget(target: FailureTarget): FailureTarget {
  return Object.freeze({
    runtimeUnitId: logicalId('runtime-unit', target.runtimeUnitId),
    attemptId: logicalId('attempt', target.attemptId),
    podUid: text(target.podUid, 'podUid') as FailureTarget['podUid'],
    executionEpoch: counter('execution-epoch', target.executionEpoch),
    containerName: target.containerName === null ? null : text(target.containerName, 'containerName'),
    runtimeContainerId: target.runtimeContainerId === null ? null : text(target.runtimeContainerId, 'containerId'),
    incarnation: target.incarnation === null ? null : text(target.incarnation, 'incarnation') as FailureTarget['incarnation']
  })
}
export function targetKey(target: FailureTarget): string {
  return JSON.stringify([target.runtimeUnitId, target.attemptId, target.podUid,
    target.executionEpoch, target.containerName, target.runtimeContainerId, target.incarnation])
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('EVIDENCE_INPUT:boolean')
  return value
}
function strings(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) throw new Error('EVIDENCE_INPUT:array')
  return Object.freeze(values.map(v => text(v, 'array item')))
}
function nullableText(value: string | null): string | null { return value === null ? null : text(value, 'nullable text') }
function integer(value: number | null): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error('EVIDENCE_INPUT:integer')
  return value
}
export function prepareFailureObservation(raw: FailureObservationInput): PreparedFailureObservation {
  const target = snapshotTarget(raw.target)
  const observedTime = evidenceTime(raw.observedAt)
  const finishedTime = raw.termination ? evidenceTime(raw.termination.finishedAt) : null
  const termination = raw.termination ? Object.freeze({
    state: raw.termination.state,
    containerId: text(raw.termination.containerId, 'termination container'),
    incarnation: text(raw.termination.incarnation, 'termination incarnation'),
    processIdentity: nullableText(raw.termination.processIdentity),
    finishedAt: finishedTime!.original,
    startedAt: raw.termination.startedAt === null ? null : evidenceTime(raw.termination.startedAt).original,
    exitCode: integer(raw.termination.exitCode), signal: integer(raw.termination.signal),
    reason: nullableText(raw.termination.reason)
  }) : null
  if (termination && !['CURRENT', 'LAST', 'SUPERVISOR'].includes(termination.state)) throw new Error('EVIDENCE_INPUT:state')
  const transition = raw.counterTransition ? Object.freeze({
    cgroupIdentity: text(raw.counterTransition.cgroupIdentity, 'cgroup'),
    processIdentity: text(raw.counterTransition.processIdentity, 'process'),
    incarnation: text(raw.counterTransition.incarnation, 'counter incarnation'),
    counter: raw.counterTransition.counter,
    previous: decimal(raw.counterTransition.previous, 'previous'), current: decimal(raw.counterTransition.current, 'current'),
    previousSampleId: text(raw.counterTransition.previousSampleId, 'previous sample'),
    currentSampleId: text(raw.counterTransition.currentSampleId, 'current sample')
  }) : null
  if (transition && !['oom', 'oom_kill', 'oom_group_kill'].includes(transition.counter)) throw new Error('EVIDENCE_INPUT:counter')
  const s = raw.signals
  const signals = Object.freeze({ oomKilled: bool(s.oomKilled), memoryEviction: bool(s.memoryEviction),
    nodeOom: bool(s.nodeOom), limitOom: bool(s.limitOom), heapLimit: bool(s.heapLimit),
    childOom: bool(s.childOom), parentAlive: s.parentAlive === null ? null : bool(s.parentAlive),
    otherTermination: bool(s.otherTermination) })
  const resources = raw.resources ? Object.freeze({
    desiredMemoryRequest: nullableText(raw.resources.desiredMemoryRequest), desiredMemoryLimit: nullableText(raw.resources.desiredMemoryLimit),
    admittedMemoryRequest: nullableText(raw.resources.admittedMemoryRequest), admittedMemoryLimit: nullableText(raw.resources.admittedMemoryLimit),
    admittedCpuRequest: nullableText(raw.resources.admittedCpuRequest), admittedCpuLimit: nullableText(raw.resources.admittedCpuLimit)
  }) : null
  const placement = raw.placement ? Object.freeze({ batchId: text(raw.placement.batchId, 'batch'),
    nodeUid: text(raw.placement.nodeUid, 'node'), targetPodUid: text(raw.placement.targetPodUid, 'placement target'),
    complete: bool(raw.placement.complete), otherUserPodUids: strings(raw.placement.otherUserPodUids),
    platformPodUids: strings(raw.placement.platformPodUids), unknownPodUids: strings(raw.placement.unknownPodUids) }) : null
  const input = Object.freeze({ observationId: text(raw.observationId, 'observationId'),
    sourceDedupKey: text(raw.sourceDedupKey, 'sourceDedupKey'), sourceKind: raw.sourceKind,
    sourceRef: text(raw.sourceRef, 'sourceRef'), target, observedAt: observedTime.original,
    sourceAuthenticated: bool(raw.sourceAuthenticated), termination, counterTransition: transition,
    signals, resources, placement, workloadKind: raw.workloadKind,
    profileVerified: bool(raw.profileVerified), defaultLimitlessProfile: bool(raw.defaultLimitlessProfile),
    affectedWorkIds: strings(raw.affectedWorkIds), gaps: strings(raw.gaps), evidence: snapshotJson(raw.evidence) })
  if (!['KUBERNETES', 'CGROUP', 'SUPERVISOR', 'UNTRUSTED_TEXT'].includes(input.sourceKind) ||
      !['AGENT','SERVE','PG','NFS','DEV','TEST','BUILD','UNKNOWN'].includes(input.workloadKind)) throw new Error('EVIDENCE_INPUT:kind')
  const issues: string[] = [...input.gaps]
  const aliases: EvidenceAlias[] = []
  const resolved = target.containerName !== null && target.runtimeContainerId !== null && target.incarnation !== null
  if (!resolved) issues.push('TARGET_UNRESOLVED')
  if (!input.sourceAuthenticated || input.sourceKind === 'UNTRUSTED_TEXT') issues.push('SOURCE_UNVERIFIED')
  const canAlias = resolved && input.sourceAuthenticated && input.sourceKind !== 'UNTRUSTED_TEXT'
  const key = targetKey(target)
  if (termination) {
    if (termination.containerId !== target.runtimeContainerId || termination.incarnation !== target.incarnation) issues.push('TERMINATION_IDENTITY_MISMATCH')
    else if (canAlias) {
      const value = snapshotJson({ target: key, process: signals.childOom ? termination.processIdentity : null, finishedAt: finishedTime!.epochNanoseconds })
      aliases.push(Object.freeze({ kind: 'TERMINATION', key: 'termination:' + evidenceDigest(value), value }))
    }
  }
  if (transition) {
    if (transition.incarnation !== target.incarnation) issues.push('COUNTER_IDENTITY_MISMATCH')
    else if (BigInt(transition.current) < BigInt(transition.previous)) issues.push('COUNTER_RESET')
    else if (transition.current === transition.previous || transition.currentSampleId === transition.previousSampleId) issues.push('COUNTER_NO_TRANSITION')
    else if (termination && (termination.processIdentity === null || termination.processIdentity !== transition.processIdentity)) issues.push('ALIAS_LINK_UNPROVEN')
    else if (canAlias) {
      const value = snapshotJson({ target: key, cgroup: transition.cgroupIdentity, process: transition.processIdentity,
        counter: transition.counter, previous: transition.previous, current: transition.current })
      aliases.push(Object.freeze({ kind: 'COUNTER_TRANSITION', key: 'counter:' + evidenceDigest(value), value }))
    }
  }
  if (resolved && aliases.length === 0) issues.push('TERMINATION_OR_COUNTER_IDENTITY_MISSING')
  // A single authenticated observation correlating the SAME process links aliases.
  // Separate observations are never joined merely by close timestamps/Pod name.
  return Object.freeze({ schemaVersion: 1, input, observedTime, finishedTime,
    payloadDigest: evidenceDigest(input), canonicalKey: aliases[0]?.key ?? null,
    aliases: Object.freeze(aliases), resolution: resolved && aliases.length > 0 ? 'RESOLVED' : 'TARGET_UNRESOLVED',
    issues: Object.freeze([...new Set(issues)]) })
}
export function resolveEvidenceAliases(observation: PreparedFailureObservation,
  bindings: readonly ExistingAliasBinding[]): AliasResolution {
  const keys = new Set(observation.aliases.map(a => a.key))
  const ids = new Set(bindings.filter(b => keys.has(b.aliasKey)).map(b => text(b.incidentId, 'incident')))
  return Object.freeze({ incidentId: ids.size === 1 ? [...ids][0] : null,
    conflicts: Object.freeze(ids.size > 1 ? ['ALIAS_OWNERSHIP_CONFLICT'] : []), aliases: observation.aliases })
}
