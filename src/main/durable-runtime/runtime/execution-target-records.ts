import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { AttemptId, ExecutionEpoch, RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, type DurableTransaction } from '../db/connection.ts'
import type { ExecutionTargetRecordRow } from '../db/execution-target-record-rows.ts'
import { LockedGatewayAuthority } from './gateway/authority.ts'
import type { GatewayContext } from './gateway/types.ts'
import type { EvidenceRef, Incarnation, NodeUid, PayloadHash, PodUid, RuntimeReference } from './runtime-evidence.ts'

export type ExecutionTargetKey = {
  readonly attemptId: AttemptId
  readonly podUid: PodUid
  readonly incarnation: Incarnation
  readonly executionEpoch: ExecutionEpoch
}
export type ExecutionTargetObservation = ExecutionTargetKey & {
  readonly runtimeUnitId: RuntimeUnitId
  readonly clusterIdentityRef: RuntimeReference<'cluster-identity'>
  readonly namespace: string
  readonly podName: string
  readonly podResourceVersion: string
  readonly nodeName: string
  readonly nodeUid: NodeUid
  readonly nodeResourceVersion: string
  readonly projectId: string
  readonly projectNumber: string
  readonly zone: string
  readonly instanceName: string
  readonly numericInstanceId: string
  readonly computeIdentityRef: RuntimeReference<'compute-identity'>
  readonly observedAt: string
  readonly kubernetesEvidenceRef: EvidenceRef
  readonly computeIdentityEvidenceRef: EvidenceRef
  readonly observationDigest: PayloadHash
}
// Flat immutable plain data. StorageEvidenceAuthority integration and verification
// of external evidence remain with the future trusted observer boundary.
export type ExecutionTargetRecord = ExecutionTargetObservation & { readonly recordedAt: string }

function invalid(): never {
  throw new DurableDatabaseError('EXECUTION_TARGET_INPUT_INVALID')
}
function text<T extends string>(value: T): T {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid()
  }
  return value
}
function positive(value: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    invalid()
  }
  return value
}
function timestamp(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    invalid()
  }
  return value
}
function captureKey(value: ExecutionTargetKey): ExecutionTargetKey {
  try {
    return Object.freeze({
      attemptId: logicalId('attempt', value.attemptId), podUid: text(value.podUid),
      incarnation: text(value.incarnation), executionEpoch: counter('execution-epoch', value.executionEpoch)
    })
  } catch {
    return invalid()
  }
}
function capture(value: ExecutionTargetObservation): ExecutionTargetObservation {
  const key = captureKey(value)
  try {
    const result = {
      ...key, runtimeUnitId: logicalId('runtime-unit', value.runtimeUnitId),
      clusterIdentityRef: text(value.clusterIdentityRef), namespace: text(value.namespace),
      podName: text(value.podName), podResourceVersion: text(value.podResourceVersion),
      nodeName: text(value.nodeName), nodeUid: text(value.nodeUid),
      nodeResourceVersion: text(value.nodeResourceVersion), projectId: text(value.projectId),
      projectNumber: positive(value.projectNumber), zone: text(value.zone),
      instanceName: text(value.instanceName), numericInstanceId: positive(value.numericInstanceId),
      computeIdentityRef: text(value.computeIdentityRef), observedAt: timestamp(value.observedAt),
      kubernetesEvidenceRef: text(value.kubernetesEvidenceRef),
      computeIdentityEvidenceRef: text(value.computeIdentityEvidenceRef),
      observationDigest: text(value.observationDigest)
    }
    if (!/^[0-9a-f]{64}$/.test(result.observationDigest)) {
      invalid()
    }
    return Object.freeze(result)
  } catch {
    return invalid()
  }
}
function projection(row: ExecutionTargetRecordRow): ExecutionTargetRecord {
  const observation = capture({
    attemptId: row.attempt_id, runtimeUnitId: row.runtime_unit_id,
    executionEpoch: row.execution_epoch, podUid: row.pod_uid, incarnation: row.incarnation,
    clusterIdentityRef: row.cluster_identity_ref, namespace: row.namespace,
    podName: row.pod_name, podResourceVersion: row.pod_resource_version,
    nodeName: row.node_name, nodeUid: row.node_uid, nodeResourceVersion: row.node_resource_version,
    projectId: row.project_id, projectNumber: row.project_number, zone: row.zone,
    instanceName: row.instance_name, numericInstanceId: row.numeric_instance_id,
    computeIdentityRef: row.compute_identity_ref, observedAt: row.observed_at.toISOString(),
    kubernetesEvidenceRef: row.kubernetes_evidence_ref,
    computeIdentityEvidenceRef: row.compute_identity_evidence_ref, observationDigest: row.observation_digest
  })
  return Object.freeze({ ...observation, recordedAt: row.recorded_at.toISOString() })
}

export async function readExecutionTarget(
  tx: DurableTransaction, original: ExecutionTargetKey
): Promise<ExecutionTargetRecord | null> {
  const key = captureKey(original), query = tx.query.bind(tx)
  const result = await query<ExecutionTargetRecordRow>(
    `SELECT * FROM durable_runtime.execution_target_records
     WHERE attempt_id=$1 AND pod_uid=$2 AND incarnation=$3 AND execution_epoch=$4`,
    [key.attemptId, key.podUid, key.incarnation, key.executionEpoch]
  )
  return result.rows[0] ? projection(result.rows[0]) : null
}

export async function recordExecutionTarget(
  tx: DurableTransaction, originalContext: GatewayContext, original: ExecutionTargetObservation
): Promise<ExecutionTargetRecord> {
  const input = capture(original), query = tx.query.bind(tx)
  // Capture nested authority DTO before acquire's first lock await. The existing
  // authority supplies DB-clock lease validation, not external evidence issuance.
  const context: GatewayContext = Object.freeze({
    runtimeUnitId: logicalId('runtime-unit', originalContext.runtimeUnitId),
    operationId: logicalId('operation', originalContext.operationId),
    controller: Object.freeze({ ...originalContext.controller,
      scope: text(originalContext.controller.scope), owner: text(originalContext.controller.owner),
      term: counter('controller-term', originalContext.controller.term) })
  })
  if (input.runtimeUnitId !== context.runtimeUnitId) {
    throw new DurableDatabaseError('EXECUTION_TARGET_SCOPE')
  }
  const authority = await LockedGatewayAuthority.acquire(tx, context)
  const existing = await query<ExecutionTargetRecordRow>(
    'SELECT * FROM durable_runtime.execution_target_records WHERE attempt_id=$1', [input.attemptId]
  )
  function originalRecord(row: ExecutionTargetRecordRow): ExecutionTargetRecord {
    const record = projection(row)
    if (Object.entries(input).some(([key, value]) => Reflect.get(record, key) !== value)) {
      throw new DurableDatabaseError('EXECUTION_TARGET_IDENTITY_CONFLICT')
    }
    return record
  }
  if (existing.rows[0]) {
    return originalRecord(existing.rows[0])
  }
  const values = [context.controller.scope, context.controller.owner, context.controller.term,
    context.operationId, input.attemptId, input.runtimeUnitId, input.executionEpoch,
    input.podUid, input.incarnation, input.clusterIdentityRef, input.namespace, input.podName,
    input.podResourceVersion, input.nodeName, input.nodeUid, input.nodeResourceVersion,
    input.projectId, input.projectNumber, input.zone, input.instanceName, input.numericInstanceId,
    input.computeIdentityRef, input.observedAt, input.kubernetesEvidenceRef,
    input.computeIdentityEvidenceRef, input.observationDigest]
  await authority.assertCurrent()
  let inserted
  try {
    inserted = await query<ExecutionTargetRecordRow>(
      `INSERT INTO durable_runtime.execution_target_records (
       attempt_id,runtime_unit_id,execution_epoch,pod_uid,incarnation,cluster_identity_ref,
       namespace,pod_name,pod_resource_version,node_name,node_uid,node_resource_version,
       project_id,project_number,zone,instance_name,numeric_instance_id,compute_identity_ref,
       observed_at,kubernetes_evidence_ref,compute_identity_evidence_ref,observation_digest)
       SELECT $5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
       FROM durable_runtime.runtime_units u
       JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id AND a.runtime_unit_id=u.id
       JOIN durable_runtime.operations o ON o.runtime_unit_id=u.id
       WHERE u.id=$6 AND u.execution_epoch=$7 AND a.id=$5 AND a.execution_epoch=$7
         AND a.pod_uid=$8 AND a.incarnation=$9 AND o.id=$4 AND o.execution_epoch=$7
         AND o.controller_scope=$1 AND o.controller_term=$3 AND o.result IS NULL
         AND o.expected_pod_uid=$8
         AND EXISTS(SELECT 1 FROM durable_runtime.controller_leases c
           WHERE c.scope=$1 AND c.owner=$2 AND c.term=$3 AND c.expires_at>clock_timestamp())
       ON CONFLICT(attempt_id) DO NOTHING RETURNING *`, values
    )
  } catch (error) {
    if (error instanceof DurableDatabaseError && error.code === '23505') {
      throw new DurableDatabaseError('EXECUTION_TARGET_IDENTITY_CONFLICT')
    }
    throw error
  }
  if (inserted.rows[0]) {
    return projection(inserted.rows[0])
  }
  const raced = await query<ExecutionTargetRecordRow>(
    'SELECT * FROM durable_runtime.execution_target_records WHERE attempt_id=$1', [input.attemptId]
  )
  if (raced.rows[0]) {
    return originalRecord(raced.rows[0])
  }
  await authority.assertCurrent()
  throw new DurableDatabaseError('EXECUTION_TARGET_STALE')
}
