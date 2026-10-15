import { auditLogName, auditResourceName, snapshotAuditInput } from './compute-deletion-audit-input'
import type { ComputeCreationIdentityInput } from './compute-creation-identity-types'

/** Compare decimal strings without rounding a Compute uint64 through Number. */
export function canonicalCreationUint64(value: string | null): boolean {
  return value !== null && value.length <= 20 &&
    /^[1-9][0-9]*$/.exec(value)?.[0] === value &&
    (value.length < 20 || value <= '18446744073709551615')
}

export function snapshotCreationInput(input: ComputeCreationIdentityInput):
  ComputeCreationIdentityInput | null {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return null
    }
    // Capture the original scope accessor once; shared validation only sees this copy.
    const originalScope = input.scope
    if (originalScope === null || typeof originalScope !== 'object' || Array.isArray(originalScope)) {
      return null
    }
    const scope = {
      projectId: originalScope.projectId, projectNumber: originalScope.projectNumber,
      zone: originalScope.zone, instanceName: originalScope.instanceName,
      numericInstanceId: originalScope.numericInstanceId
    }
    const startTime = input.startTime, endTime = input.endTime
    const fields = [...Object.values(scope), startTime, endTime]
    // JS `$` permits a trailing newline. Reject whitespace/control before shared validation.
    if (fields.some(value => typeof value !== 'string' || /[\s\x00-\x1f\x7f]/.test(value)) ||
        !canonicalCreationUint64(scope.numericInstanceId)) {
      return null
    }
    return snapshotAuditInput({ scope, startTime, endTime })
  } catch {
    return null
  }
}

/** Exact insert query only: no caller URL, filter, page size or continuation token. */
export function creationAuditRequestBody(input: ComputeCreationIdentityInput): string {
  const literal = (value: string): string => JSON.stringify(value)
  const scope = input.scope
  return JSON.stringify({
    resourceNames: [`projects/${scope.projectId}`],
    filter: [
      `logName=${literal(auditLogName(input))}`,
      'resource.type="gce_instance"',
      `resource.labels.project_id=${literal(scope.projectId)}`,
      `resource.labels.zone=${literal(scope.zone)}`,
      `resource.labels.instance_id=${literal(scope.numericInstanceId)}`,
      'protoPayload.serviceName="compute.googleapis.com"',
      'protoPayload.methodName="v1.compute.instances.insert"',
      `protoPayload.resourceName=${literal(auditResourceName(input))}`,
      `timestamp>=${literal(input.startTime)}`,
      `timestamp<=${literal(input.endTime)}`
    ].join('\n'),
    pageSize: 100, orderBy: 'timestamp asc'
  })
}
