import type {
  ComputeAuditErrorCode, ComputeAuditIncompleteReason, ComputeAuditUnconfirmedReason
} from './compute-deletion-audit-types'

/** Historical creation observation only; no current-state or execution authority. */
export type ComputeCreationScope = Readonly<{
  projectId: string
  projectNumber: string
  zone: string
  instanceName: string
  numericInstanceId: string
}>

export type ComputeCreationIdentityInput = Readonly<{
  scope: ComputeCreationScope
  startTime: string
  endTime: string
}>

export type ComputeCreationObservation =
  | Readonly<{ status: 'NOT_OBSERVED'; reason: 'NO_ENTRIES' }>
  | Readonly<{ status: 'INCOMPLETE'; reason: ComputeAuditIncompleteReason }>
  | Readonly<{ status: 'UNCONFIRMED'; reason: ComputeAuditUnconfirmedReason }>
  | Readonly<{
      status: 'CREATE_OPERATION_COMPLETED'
      source: 'CLOUD_AUDIT_LOGS'
      identity: ComputeCreationScope
      operationId: string
      producer: 'compute.googleapis.com'
      first: Readonly<{ insertId: string; timestamp: string }>
      last: Readonly<{ insertId: string; timestamp: string }>
      evidenceDigest: string
    }>

export type ComputeCreationIdentityResult =
  | Readonly<{ ok: true; observation: ComputeCreationObservation }>
  | Readonly<{ ok: false; error: Readonly<{ code: ComputeAuditErrorCode }> }>
