import type { ComputeDeletionAuditInput } from './compute-deletion-audit-types'
import { freezeAuditValue } from './compute-deletion-audit-types'

/** RFC3339 with nanosecond ordering; Date.parse alone loses sub-millisecond ordering. */
export function auditTimestamp(value: string | null): bigint | null {
  if (value === null) {
    return null
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) {
    return null
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, offset] = match
  const [year, month, day, hour, minute, second] =
    [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      hour > 23 || minute > 59 || second > 59) {
    return null
  }
  let offsetMinutes = 0
  if (offset !== 'Z') {
    const hours = Number(offset.slice(1, 3))
    const minutes = Number(offset.slice(4, 6))
    if (hours > 23 || minutes > 59) {
      return null
    }
    offsetMinutes = (offset[0] === '+' ? 1 : -1) * (hours * 60 + minutes)
  }
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  return BigInt(date.getTime() - offsetMinutes * 60_000) * 1_000_000n +
    BigInt((fraction ?? '').padEnd(9, '0'))
}

export function snapshotAuditInput(input: ComputeDeletionAuditInput): ComputeDeletionAuditInput | null {
  if (input === null || typeof input !== 'object' || input.scope === null ||
      typeof input.scope !== 'object') {
    return null
  }
  const scope = {
    projectId: input.scope?.projectId,
    projectNumber: input.scope?.projectNumber,
    zone: input.scope?.zone,
    instanceName: input.scope?.instanceName,
    numericInstanceId: input.scope?.numericInstanceId
  }
  const startTime = input.startTime
  const endTime = input.endTime
  if (Object.values(scope).some(value => typeof value !== 'string') ||
      typeof startTime !== 'string' || typeof endTime !== 'string') {
    return null
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(scope.projectId) ||
      !/^[1-9][0-9]*$/.test(scope.projectNumber) ||
      !/^[a-z][a-z0-9-]*-[a-z]$/.test(scope.zone) ||
      !/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(scope.instanceName) ||
      !/^[1-9][0-9]*$/.test(scope.numericInstanceId)) {
    return null
  }
  const start = auditTimestamp(startTime)
  const end = auditTimestamp(endTime)
  if (start === null || end === null || start > end) {
    return null
  }
  return freezeAuditValue<ComputeDeletionAuditInput>({ scope, startTime, endTime })
}

export function auditLogName(input: ComputeDeletionAuditInput): string {
  return `projects/${input.scope.projectId}/logs/cloudaudit.googleapis.com%2Factivity`
}

export function auditResourceName(input: ComputeDeletionAuditInput): string {
  const s = input.scope
  return `projects/${s.projectNumber}/zones/${s.zone}/instances/${s.instanceName}`
}

export function computeAuditRequestBody(input: ComputeDeletionAuditInput): string {
  const literal = (value: string): string => JSON.stringify(value)
  const s = input.scope
  const filter = [
    `logName=${literal(auditLogName(input))}`,
    'resource.type="gce_instance"',
    `resource.labels.project_id=${literal(s.projectId)}`,
    `resource.labels.zone=${literal(s.zone)}`,
    `resource.labels.instance_id=${literal(s.numericInstanceId)}`,
    'protoPayload.serviceName="compute.googleapis.com"',
    'protoPayload.methodName="v1.compute.instances.delete"',
    `protoPayload.resourceName=${literal(auditResourceName(input))}`,
    `timestamp>=${literal(input.startTime)}`,
    `timestamp<=${literal(input.endTime)}`
  ].join('\n')
  return JSON.stringify({ resourceNames: [`projects/${s.projectId}`], filter,
    pageSize: 100, orderBy: 'timestamp asc' })
}
