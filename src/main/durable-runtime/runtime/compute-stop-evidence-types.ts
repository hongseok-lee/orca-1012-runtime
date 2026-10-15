import type { Pool } from 'pg'
import type { RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import type { StorageEvidenceAuthority } from '../storage/evidence.ts'
import type { ComputeAuditTransportConfiguration } from './compute-deletion-audit.ts'
import type { ExecutionTargetKey } from './execution-target-records.ts'
import type { EvidenceRef } from './runtime-evidence.ts'

export type ComputeStopEvidenceConfiguration = Readonly<{
  pool: Pool
  datasetName: string
  clusterIdentityRef: string
  namespace: string
  projectId: string
  projectNumber: string
  timeoutMs: number
  audit: ComputeAuditTransportConfiguration
}>

export type ComputeStopEvidenceInput = Readonly<{
  runtimeUnitId: RuntimeUnitId
  key: ExecutionTargetKey
  startTime: string
  endTime: string
}>

// This subset deliberately cannot substitute for directory/mount authority.
export type PreparedComputeStopEvidence = Readonly<Pick<StorageEvidenceAuthority,
  'executionTarget' | 'executionTargetPinValid' | 'permanentComputeStop' | 'computeStopPinValid'> & {
  reference: EvidenceRef
  release(): void
}>

export type ComputeStopEvidenceErrorCode = 'INVALID_CONFIGURATION' | 'INVALID_INPUT' |
  'ABORTED' | 'TIMEOUT' | 'DB_READ_FAILED' | 'DATASET_MISMATCH' |
  'TARGET_NOT_FOUND' | 'TARGET_MISMATCH' | 'AUDIT_REJECTED'

export class ComputeStopEvidenceError extends Error {
  constructor(readonly code: ComputeStopEvidenceErrorCode) {
    super(`Compute stop evidence failed (${code})`)
    this.name = 'ComputeStopEvidenceError'
  }
}
