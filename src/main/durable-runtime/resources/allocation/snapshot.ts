import { logicalId, counter } from '../../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError } from '../../db/connection.ts'
import { snapshotJson, evidenceDigest, text } from '../evidence/normalize.ts'
import type { JsonValue } from '../../db/atomic.ts'
import type { VerifiedEvidence } from '../../runtime/runtime-evidence.ts'
import type { Envelope, ResourceFacts, PrepareResourceRequest, ReserveResourceRequest } from './types.ts'

export function decimal(value: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new DurableDatabaseError('RESOURCE_INTEGER_RANGE')
  }
  return value
}
export function duration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) { throw new DurableDatabaseError('RESOURCE_DURATION') }
  return value
}
export function immutable<T>(value: T): T {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Shared descriptor validation performs a deep copy/freeze of data-only JSON; this does not create authority brands.
  return snapshotJson(value) as unknown as T
}
export function json(value: unknown): JsonValue {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Validated immutable JSON projection passed to the existing mutable SQL JSON type; never mutated.
  return snapshotJson(value) as unknown as JsonValue
}
function copiedEvidence(input: VerifiedEvidence): VerifiedEvidence {
  const evidenceRef = input.evidenceRef, observedAt = input.observedAt
  text(evidenceRef, 'evidence ref'); text(observedAt, 'evidence observation time')
  const copy = { ...input, evidenceRef, observedAt }
  // Keep only allowlisted evidence metadata plus the supplied opaque brand.
  // Extra nested caller fields must not enter facts JSON after an await.
  for (const key of Object.keys(copy)) {
    if (key !== 'evidenceRef' && key !== 'observedAt') { Reflect.deleteProperty(copy, key) }
  }
  return Object.freeze(copy)
}
export function scopeSnapshot(input: Pick<Envelope, 'authority' | 'authorizer'>) {
  const a = input.authority
  const evidence = copiedEvidence(a.evidence)
  const authorityCopy = { ...a, principalId: text(a.principalId, 'principal'),
    datasetName: text(a.datasetName, 'dataset'), domainIdentity: text(a.domainIdentity, 'domain'),
    budgetScope: text(a.budgetScope, 'budget scope'), runtimeUnitId: a.runtimeUnitId === null ? null :
      logicalId('runtime-unit', a.runtimeUnitId), evidence }
  const allowed = new Set(['principalId', 'datasetName', 'domainIdentity', 'budgetScope', 'runtimeUnitId', 'evidence'])
  for (const key of Object.keys(authorityCopy)) { if (!allowed.has(key)) { Reflect.deleteProperty(authorityCopy, key) } }
  const authority = Object.freeze(authorityCopy)
  const receiver = input.authorizer, method = receiver.authorize
  if (typeof method !== 'function') { throw new DurableDatabaseError('RESOURCE_SCOPE_AUTHORIZER') }
  // Capture both the original function and its receiver before any await.
  return Object.freeze({ authority, authorize: (action: 'REGISTER' | 'PLAN' | 'RESERVE' | 'READ') => method.call(receiver, authority, action) })
}
export function envelope(input: Envelope) {
  const common = scopeSnapshot(input)
  const controller = Object.freeze({ scope: text(input.controller.scope, 'controller scope'),
    owner: text(input.controller.owner, 'controller owner'), term: counter('controller-term', decimal(input.controller.term)) })
  return Object.freeze({ ...common, controller, operationKey: text(input.operationKey, 'operation key') })
}
export function facts(input: ResourceFacts): ResourceFacts {
  const data = immutable({ target: input.target, classification: input.classification,
    profile: input.profile, caps: input.caps, peak: input.peak, declared: input.declared,
    admitted: input.admitted, old: input.old, protectedDemand: input.protectedDemand })
  for (const demand of [data.protectedDemand, data.profile]) {
    decimal(demand.memoryBytes); decimal(demand.cpuMillicores)
  }
  return Object.freeze({ ...data, verification: copiedEvidence(input.verification),
    completeAccountingEvidence: copiedEvidence(input.completeAccountingEvidence) })
}
export function prepareSnapshot(input: PrepareResourceRequest) {
  const common = envelope(input)
  if (common.authority.runtimeUnitId === null || !['GROW', 'REPLACE'].includes(input.kind)) {
    throw new DurableDatabaseError('RESOURCE_REQUEST')
  }
  const fixed = Object.freeze({ ...common, kind: input.kind,
    incidentId: logicalId('incident', input.incidentId), policyRevision: decimal(input.policyRevision),
    workloadProfileKey: text(input.workloadProfileKey, 'workload profile'),
    expectedUnitRevision: decimal(input.expectedUnitRevision), expectedIntentRevision: decimal(input.expectedIntentRevision),
    expectedApprovedProfileRevision: decimal(input.expectedApprovedProfileRevision),
    expectedClassificationRevision: decimal(input.expectedClassificationRevision),
    reservationDurationMs: duration(input.reservationDurationMs), facts: facts(input.facts) })
  // Observation freshness, current term and expected CAS revisions are not the
  // original semantic body. Same explicit target/config with new observations
  // can replay its prior receipt; a changed target/config conflicts.
  return Object.freeze({ ...fixed, meaningHash: evidenceDigest([fixed.authority.runtimeUnitId,
    fixed.kind, fixed.incidentId, fixed.workloadProfileKey, fixed.facts.declared]) })
}
export function reserveSnapshot(input: ReserveResourceRequest) {
  const common = envelope(input)
  if (common.authority.runtimeUnitId === null) { throw new DurableDatabaseError('RESOURCE_REQUEST') }
  return Object.freeze({ ...common, operationId: logicalId('operation', input.operationId),
    expectedUnitRevision: decimal(input.expectedUnitRevision), expectedIntentRevision: decimal(input.expectedIntentRevision),
    facts: facts(input.facts) })
}
