import { createHash } from 'node:crypto'
import { auditLogName, auditResourceName, auditTimestamp } from './compute-deletion-audit-input'
import { canonicalCreationUint64 } from './compute-creation-identity-input'
import type {
  ComputeCreationIdentityInput, ComputeCreationObservation
} from './compute-creation-identity-types'
import type {
  ComputeAuditUnconfirmedReason, ProjectedAuditEntry, ProjectedAuditPage
} from './compute-deletion-audit-types'
import { freezeAuditValue } from './compute-deletion-audit-types'

function validOpaque(value: string | null): boolean {
  return value !== null && value.length > 0 && value.trim() === value &&
    !/[\x00-\x1f\x7f]/.test(value)
}

function timestamp(value: string | null): bigint | null {
  return value === null || /\s/.test(value) ? null : auditTimestamp(value)
}

function computeUrl(value: string | null, path: string): boolean {
  return value === `https://www.googleapis.com/compute/v1/${path}` ||
    value === `https://compute.googleapis.com/compute/v1/${path}`
}

function responseMatches(entry: ProjectedAuditEntry, input: ComputeCreationIdentityInput): boolean {
  const shape = entry.responseShape, response = entry.audit.response
  if (!shape.present) {
    return entry.operation.last && !entry.operation.first
  }
  if (!shape.object || response === null || shape.errorPresent ||
      Object.values(shape.fields).some(field => field.present && !field.string)) {
    return false
  }
  const fields = shape.fields, scope = input.scope
  if (entry.operation.first && (!fields.name.present || !fields.operationType.present ||
      !fields.targetId.present || !fields.targetLink.present)) {
    return false
  }
  const zonePath = `projects/${scope.projectId}/zones/${scope.zone}`
  return (!fields.name.present || response.name === entry.operation.id) &&
    (!fields.operationType.present || response.operationType === 'insert') &&
    (!fields.targetId.present || response.targetId === scope.numericInstanceId) &&
    (!fields.targetLink.present || computeUrl(response.targetLink, `${zonePath}/instances/${scope.instanceName}`)) &&
    (!fields.zone.present || computeUrl(response.zone, zonePath)) &&
    (!fields.id.present || canonicalCreationUint64(response.id))
}

function entryIssue(entry: ProjectedAuditEntry, input: ComputeCreationIdentityInput):
  ComputeAuditUnconfirmedReason | null {
  if (!entry.shapeValid || !validOpaque(entry.insertId) || !entry.operation.flagsValid) {
    return 'INVALID_ENTRY'
  }
  const resource = entry.resource, scope = input.scope
  if (entry.logName !== auditLogName(input) ||
      entry.audit.type !== 'type.googleapis.com/google.cloud.audit.AuditLog' ||
      entry.audit.serviceName !== 'compute.googleapis.com' ||
      entry.audit.methodName !== 'v1.compute.instances.insert' ||
      entry.audit.resourceName !== auditResourceName(input) ||
      resource === null || resource.type !== 'gce_instance' || !resource.labelsPresent ||
      resource.projectId !== scope.projectId || resource.zone !== scope.zone ||
      resource.numericInstanceId !== scope.numericInstanceId) {
    return 'IDENTITY_MISMATCH'
  }
  if (!validOpaque(entry.operation.id) || entry.operation.producer !== 'compute.googleapis.com') {
    return 'OPERATION_MISMATCH'
  }
  const at = timestamp(entry.timestamp), start = timestamp(input.startTime), end = timestamp(input.endTime)
  if (at === null || start === null || end === null || at < start || at > end) {
    return 'INVALID_TIMESTAMP'
  }
  // Every candidate belongs to this operation; a failed/intermediate row is not discarded.
  if (!entry.audit.statusPresent || !entry.audit.statusOk) {
    return 'STATUS_NOT_OK'
  }
  return responseMatches(entry, input) ? null : 'IDENTITY_MISMATCH'
}

function unconfirmed(reason: ComputeAuditUnconfirmedReason): ComputeCreationObservation {
  return freezeAuditValue<ComputeCreationObservation>({ status: 'UNCONFIRMED', reason })
}

/** Consumes the existing bounded projection; raw digests are internal exact-dedup keys only. */
export function evaluateComputeCreationPage(
  input: ComputeCreationIdentityInput, page: ProjectedAuditPage
): ComputeCreationObservation {
  if (page.incomplete) {
    return freezeAuditValue<ComputeCreationObservation>({ status: 'INCOMPLETE', reason: page.incomplete })
  }
  if (!page.entries.length) {
    return freezeAuditValue<ComputeCreationObservation>({ status: 'NOT_OBSERVED', reason: 'NO_ENTRIES' })
  }
  const unique = new Map<string, ProjectedAuditEntry>()
  let operationId: string | null = null
  for (const entry of page.entries) {
    const issue = entryIssue(entry, input)
    if (issue) {
      return unconfirmed(issue)
    }
    const previous = unique.get(entry.insertId!)
    if (previous) {
      if (previous.exactEntryDigest !== entry.exactEntryDigest) {
        return unconfirmed('CONFLICTING_INSERT_ID')
      }
      continue
    }
    unique.set(entry.insertId!, entry)
    if (operationId !== null && operationId !== entry.operation.id) {
      return unconfirmed('AMBIGUOUS_OPERATION')
    }
    operationId = entry.operation.id
  }
  const entries = Array.from(unique.values())
  const firsts = entries.filter(entry => entry.operation.first)
  const lasts = entries.filter(entry => entry.operation.last)
  if (firsts.length > 1 || lasts.length > 1) {
    return unconfirmed('AMBIGUOUS_OPERATION')
  }
  if (firsts.length !== 1 || lasts.length !== 1) {
    return unconfirmed('START_OR_COMPLETION_MISSING')
  }
  const first = firsts[0], last = lasts[0]
  if (timestamp(first.timestamp)! > timestamp(last.timestamp)!) {
    return unconfirmed('INVALID_TIMESTAMP')
  }
  // Stable allowlist only; operation response status is not the current VM state.
  const evidence = {
    source: 'CLOUD_AUDIT_LOGS', identity: { ...input.scope }, operationId,
    producer: 'compute.googleapis.com',
    first: { insertId: first.insertId!, timestamp: first.timestamp! },
    last: { insertId: last.insertId!, timestamp: last.timestamp! }
  }
  return freezeAuditValue<ComputeCreationObservation>({
    status: 'CREATE_OPERATION_COMPLETED', ...evidence,
    source: 'CLOUD_AUDIT_LOGS', operationId: operationId!, producer: 'compute.googleapis.com',
    evidenceDigest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
  })
}
