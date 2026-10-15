import { createHash } from 'node:crypto'
import type { ComputeAuditPageResult, ProjectedAuditEntry } from './compute-deletion-audit-types'
import { freezeAuditValue } from './compute-deletion-audit-types'

type JsonRecord = Record<string, unknown>
function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord : null
}
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
function optionalText(object: JsonRecord, key: string): boolean {
  return !Object.hasOwn(object, key) || typeof object[key] === 'string'
}
function statusOk(value: unknown): boolean {
  const status = record(value)
  return status !== null && (!Object.hasOwn(status, 'code') || status.code === 0)
}

function projectEntry(value: unknown): ProjectedAuditEntry | null {
  const entry = record(value)
  if (!entry) {
    return null
  }
  const resource = record(entry.resource)
  const labels = record(resource?.labels)
  const operation = record(entry.operation) ?? {}
  const audit = record(entry.protoPayload) ?? {}
  const response = record(audit.response)
  const status = record(audit.status)
  return {
    // Internal only: dedup requires the exact original JSON entry, not its projection.
    // Never returned as evidenceDigest; the returned digest uses allowlisted fields only.
    exactEntryDigest: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    shapeValid: optionalText(audit, '@type') &&
      (!response || (optionalText(response, 'id') && optionalText(response, 'zone'))),
    insertId: text(entry.insertId), timestamp: text(entry.timestamp), logName: text(entry.logName),
    resource: resource ? {
      type: text(resource.type), labelsPresent: Object.hasOwn(resource, 'labels'),
      projectId: text(labels?.project_id), zone: text(labels?.zone),
      numericInstanceId: text(labels?.instance_id)
    } : null,
    operation: {
      id: text(operation.id), producer: text(operation.producer),
      first: operation.first === true, last: operation.last === true,
      flagsValid: (!Object.hasOwn(operation, 'first') || typeof operation.first === 'boolean') &&
        (!Object.hasOwn(operation, 'last') || typeof operation.last === 'boolean')
    },
    audit: {
      type: text(audit['@type']), serviceName: text(audit.serviceName),
      methodName: text(audit.methodName), resourceName: text(audit.resourceName),
      statusPresent: status !== null,
      statusCode: typeof status?.code === 'number' && Number.isFinite(status.code) ? status.code : null,
      statusOk: statusOk(audit.status),
      response: response ? {
        name: text(response.name), id: text(response.id),
        operationType: text(response.operationType), targetId: text(response.targetId),
        targetLink: text(response.targetLink), zone: text(response.zone)
      } : null
    }
  }
}

/** Raw Any payloads, authenticationInfo, request, messages and nextPageToken never escape. */
export function projectComputeAuditPage(value: unknown): ComputeAuditPageResult {
  const body = record(value)
  if (!body || (Object.hasOwn(body, 'entries') && !Array.isArray(body.entries)) ||
      (Object.hasOwn(body, 'nextPageToken') && typeof body.nextPageToken !== 'string')) {
    return freezeAuditValue<ComputeAuditPageResult>({ ok: false, error: { code: 'INVALID_RESPONSE' } })
  }
  const rawEntries = (body.entries ?? []) as unknown[]
  if (rawEntries.length > 100) {
    return freezeAuditValue<ComputeAuditPageResult>({ ok: true, page: { entries: [], incomplete: 'PAGE_SIZE_EXCEEDED' } })
  }
  const entries: ProjectedAuditEntry[] = []
  for (const raw of rawEntries) {
    const entry = projectEntry(raw)
    if (!entry) {
      return freezeAuditValue<ComputeAuditPageResult>({ ok: false, error: { code: 'INVALID_RESPONSE' } })
    }
    entries.push(entry)
  }
  return freezeAuditValue<ComputeAuditPageResult>({ ok: true, page: {
    entries, incomplete: body.nextPageToken ? 'NEXT_PAGE_PRESENT' : null
  } })
}
