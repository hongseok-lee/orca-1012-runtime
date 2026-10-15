/** Observations only: these types are not storage proofs or provider effect permits. */
export type ComputeDeletionScope = Readonly<{
  projectId: string
  projectNumber: string
  zone: string
  instanceName: string
  numericInstanceId: string
}>

export type ComputeDeletionAuditInput = Readonly<{
  scope: ComputeDeletionScope
  startTime: string
  endTime: string
}>

export type ComputeAuditErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CONFIGURATION'
  | 'AUTH_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'HTTP_ERROR'
  | 'REDIRECT_REJECTED'
  | 'TLS_ERROR'
  | 'NETWORK_ERROR'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'INVALID_JSON'
  | 'INVALID_RESPONSE'

export type ComputeAuditIncompleteReason =
  | 'NEXT_PAGE_PRESENT'
  | 'PAGE_SIZE_EXCEEDED'
  | 'RESPONSE_TRUNCATED'
  | 'RESPONSE_BYTE_LIMIT'

export type ComputeAuditUnconfirmedReason =
  | 'IDENTITY_MISMATCH'
  | 'STATUS_NOT_OK'
  | 'INVALID_TIMESTAMP'
  | 'OPERATION_MISMATCH'
  | 'START_OR_COMPLETION_MISSING'
  | 'CONFLICTING_INSERT_ID'
  | 'AMBIGUOUS_OPERATION'
  | 'INVALID_ENTRY'

export type ComputeDeletionObservation =
  | Readonly<{ status: 'NOT_OBSERVED'; reason: 'NO_ENTRIES' }>
  | Readonly<{ status: 'INCOMPLETE'; reason: ComputeAuditIncompleteReason }>
  | Readonly<{ status: 'UNCONFIRMED'; reason: ComputeAuditUnconfirmedReason }>
  | Readonly<{
      status: 'DELETE_OPERATION_COMPLETED'
      identity: ComputeDeletionScope
      operationId: string
      producer: 'compute.googleapis.com'
      first: Readonly<{ insertId: string; timestamp: string }>
      last: Readonly<{ insertId: string; timestamp: string }>
      evidenceDigest: string
    }>

export type ComputeDeletionAuditResult =
  | Readonly<{ ok: true; observation: ComputeDeletionObservation }>
  | Readonly<{ ok: false; error: Readonly<{ code: ComputeAuditErrorCode }> }>

export type ProjectedAuditEntry = Readonly<{
  exactEntryDigest: string
  shapeValid: boolean
  insertId: string | null
  timestamp: string | null
  logName: string | null
  resource: Readonly<{
    type: string | null
    labelsPresent: boolean
    projectId: string | null
    zone: string | null
    numericInstanceId: string | null
  }> | null
  operation: Readonly<{
    id: string | null
    producer: string | null
    first: boolean
    last: boolean
    flagsValid: boolean
  }>
  audit: Readonly<{
    type: string | null
    serviceName: string | null
    methodName: string | null
    resourceName: string | null
    statusPresent: boolean
    statusCode: number | null
    statusOk: boolean
    response: Readonly<{
      name: string | null
      id: string | null
      operationType: string | null
      targetId: string | null
      targetLink: string | null
      zone: string | null
    }> | null
  }>
}>

export type ProjectedAuditPage = Readonly<{
  entries: readonly ProjectedAuditEntry[]
  incomplete: ComputeAuditIncompleteReason | null
}>

export type ComputeAuditPageResult =
  | Readonly<{ ok: true; page: ProjectedAuditPage }>
  | Readonly<{ ok: false; error: Readonly<{ code: ComputeAuditErrorCode }> }>

export function freezeAuditValue<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freezeAuditValue(child)
    }
    Object.freeze(value)
  }
  return value
}

export function auditError(code: ComputeAuditErrorCode):
  Readonly<{ ok: false; error: Readonly<{ code: ComputeAuditErrorCode }> }> {
  return freezeAuditValue<{ ok: false; error: { code: ComputeAuditErrorCode } }>({
    ok: false, error: { code }
  })
}
