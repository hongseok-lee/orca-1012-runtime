import { createHash } from 'node:crypto'
import { auditLogName, auditResourceName, auditTimestamp } from './compute-deletion-audit-input'
import type {
  ComputeAuditUnconfirmedReason, ComputeDeletionAuditInput,
  ComputeDeletionObservation, ProjectedAuditEntry, ProjectedAuditPage
} from './compute-deletion-audit-types'
import { freezeAuditValue } from './compute-deletion-audit-types'

function identityMatches(entry: ProjectedAuditEntry, input: ComputeDeletionAuditInput): boolean {
  const { scope } = input
  const r = entry.resource
  return entry.logName === auditLogName(input) &&
    entry.audit.serviceName === 'compute.googleapis.com' &&
    entry.audit.methodName === 'v1.compute.instances.delete' &&
    entry.audit.resourceName === auditResourceName(input) &&
    (entry.audit.type === null || entry.audit.type === 'type.googleapis.com/google.cloud.audit.AuditLog') &&
    r !== null && r.type === 'gce_instance' && (!r.labelsPresent ||
      (r.projectId === scope.projectId && r.zone === scope.zone &&
       r.numericInstanceId === scope.numericInstanceId))
}

function computeUrlMatches(value: string | null, path: string): boolean {
  // Exact strings also reject userinfo, noncanonical encoding, extra slash, query and fragment.
  return value === `https://www.googleapis.com/compute/v1/${path}` ||
    value === `https://compute.googleapis.com/compute/v1/${path}`
}

function firstTargetMatches(entry: ProjectedAuditEntry, input: ComputeDeletionAuditInput): boolean {
  const response = entry.audit.response
  const s = input.scope
  const zonePath = `projects/${s.projectId}/zones/${s.zone}`
  return response !== null && response.name === entry.operation.id &&
    response.operationType === 'delete' && response.targetId === s.numericInstanceId &&
    computeUrlMatches(response.targetLink, `${zonePath}/instances/${s.instanceName}`) &&
    (response.zone === null || computeUrlMatches(response.zone, zonePath))
}

function entryIssue(entry: ProjectedAuditEntry, input: ComputeDeletionAuditInput):
  ComputeAuditUnconfirmedReason | null {
  if (!entry.shapeValid || !entry.insertId || !entry.operation.flagsValid) {
    return 'INVALID_ENTRY'
  }
  if (!identityMatches(entry, input)) {
    return 'IDENTITY_MISMATCH'
  }
  if (!entry.operation.id || entry.operation.producer !== 'compute.googleapis.com') {
    return 'OPERATION_MISMATCH'
  }
  const timestamp = auditTimestamp(entry.timestamp)
  const start = auditTimestamp(input.startTime)
  const end = auditTimestamp(input.endTime)
  if (timestamp === null || start === null || end === null || timestamp < start || timestamp > end) {
    return 'INVALID_TIMESTAMP'
  }
  if ((entry.operation.first || entry.operation.last) && !entry.audit.statusOk) {
    return 'STATUS_NOT_OK'
  }
  if (entry.operation.first && !firstTargetMatches(entry, input)) {
    return 'IDENTITY_MISMATCH'
  }
  return null
}

function unconfirmed(reason: ComputeAuditUnconfirmedReason): ComputeDeletionObservation {
  return freezeAuditValue<ComputeDeletionObservation>({ status: 'UNCONFIRMED', reason })
}

/** Call only with a synchronously copied, validated input and allowlisted page. */
export function evaluateComputeAuditPage(
  input: ComputeDeletionAuditInput,
  page: ProjectedAuditPage
): ComputeDeletionObservation {
  if (page.incomplete) {
    return freezeAuditValue<ComputeDeletionObservation>({ status: 'INCOMPLETE', reason: page.incomplete })
  }
  if (!page.entries.length) {
    return freezeAuditValue<ComputeDeletionObservation>({ status: 'NOT_OBSERVED', reason: 'NO_ENTRIES' })
  }
  const unique = new Map<string, ProjectedAuditEntry>()
  const groups = new Map<string, ProjectedAuditEntry[]>()
  for (const entry of page.entries) {
    const issue = entryIssue(entry, input)
    if (issue) {
      return unconfirmed(issue)
    }
    const insertId = entry.insertId!
    const previous = unique.get(insertId)
    if (previous) {
      if (previous.exactEntryDigest !== entry.exactEntryDigest) {
        return unconfirmed('CONFLICTING_INSERT_ID')
      }
      continue
    }
    unique.set(insertId, entry)
    const group = groups.get(entry.operation.id!) ?? []
    group.push(entry)
    groups.set(entry.operation.id!, group)
  }
  const candidates: { first: ProjectedAuditEntry; last: ProjectedAuditEntry }[] = []
  for (const entries of groups.values()) {
    const firsts = entries.filter(entry => entry.operation.first)
    const lasts = entries.filter(entry => entry.operation.last)
    if (firsts.length > 1 || lasts.length > 1) {
      return unconfirmed('AMBIGUOUS_OPERATION')
    }
    if (firsts.length === 1 && lasts.length === 1) {
      if (auditTimestamp(firsts[0].timestamp)! > auditTimestamp(lasts[0].timestamp)!) {
        return unconfirmed('INVALID_TIMESTAMP')
      }
      candidates.push({ first: firsts[0], last: lasts[0] })
    }
  }
  if (!candidates.length) {
    return unconfirmed('START_OR_COMPLETION_MISSING')
  }
  if (candidates.length !== 1) {
    return unconfirmed('AMBIGUOUS_OPERATION')
  }
  const { first, last } = candidates[0]
  // Drop the original-entry digest before deriving the public sanitized evidence digest.
  const sanitized = [first, last].map(entry => {
    return {
      insertId: entry.insertId, timestamp: entry.timestamp, logName: entry.logName,
      resource: entry.resource, operation: entry.operation, audit: entry.audit
    }
  })
  return freezeAuditValue<ComputeDeletionObservation>({
    status: 'DELETE_OPERATION_COMPLETED', identity: { ...input.scope },
    operationId: first.operation.id!, producer: 'compute.googleapis.com',
    first: { insertId: first.insertId!, timestamp: first.timestamp! },
    last: { insertId: last.insertId!, timestamp: last.timestamp! },
    evidenceDigest: createHash('sha256').update(JSON.stringify(sanitized)).digest('hex')
  })
}
