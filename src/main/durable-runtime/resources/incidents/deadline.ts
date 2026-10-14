import type { Pool } from 'pg'
import { counter, logicalId } from '../../../../shared/durable-runtime/identity.ts'
import type { RuntimeUnitId, IncidentId } from '../../../../shared/durable-runtime/identity.ts'
import { runDurableMutation, type MutationOutcome, type ReceiptKey } from '../../db/atomic.ts'
import { DurableDatabaseError, safeDatabaseError, type DurableTransaction } from '../../db/connection.ts'
import type { FailureIncidentStateRow } from '../../db/rows.ts'
import { evidenceDigest, text } from '../evidence/normalize.ts'
import { writeIncidentArtifacts } from './artifacts.ts'

export async function listDueFailureIncidents(pool: Pool, request: {
  readonly unitId?: RuntimeUnitId; readonly limit: number
}): Promise<readonly FailureIncidentStateRow[]> {
  const unitId = request.unitId === undefined ? null : logicalId('runtime-unit', request.unitId)
  const limit = request.limit
  if (!Number.isSafeInteger(limit) || limit <= 0) { throw new DurableDatabaseError('INCIDENT_READ_INPUT') }
  const client = await pool.connect()
  let destroy = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const result = await client.query<FailureIncidentStateRow>(
      `SELECT s.* FROM durable_runtime.failure_incident_state s JOIN durable_runtime.runtime_units u ON u.id=s.runtime_unit_id
       WHERE s.state='COLLECTING' AND s.deadline_at<=clock_timestamp()
       AND u.active_attempt_id=s.attempt_id AND u.execution_epoch=s.execution_epoch
       AND ($1::uuid IS NULL OR s.runtime_unit_id=$1::uuid) ORDER BY s.deadline_at,s.incident_id LIMIT $2`, [unitId, limit])
    await client.query('COMMIT')
    return result.rows
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { destroy = true }
    throw safeDatabaseError(error)
  } finally { client.release(destroy) }
}

export type ExpireIncidentInput = {
  readonly incidentId: IncidentId
  readonly unitId: RuntimeUnitId
  readonly expectedRevision: string
  readonly receiptKey: ReceiptKey
}
function snapshotExpiry(request: ExpireIncidentInput): ExpireIncidentInput {
  return Object.freeze({ incidentId: logicalId('incident', request.incidentId),
    unitId: logicalId('runtime-unit', request.unitId), expectedRevision: counter('row:failure-incident-state', request.expectedRevision),
    receiptKey: Object.freeze({ principalId: text(request.receiptKey.principalId, 'receipt principal'),
      sessionScope: text(request.receiptKey.sessionScope, 'receipt scope'), method: text(request.receiptKey.method, 'receipt method'),
      operationKey: text(request.receiptKey.operationKey, 'receipt operation key') }) })
}
export async function expireFailureEvidence(tx: DurableTransaction, request: ExpireIncidentInput): Promise<{
  status: 'BLOCKED' | 'UNCHANGED' | 'STALE'; incidentId: IncidentId; revision: string
}> {
  const input = snapshotExpiry(request)
  if (!tx.isLockHeld(2, input.unitId)) { throw new DurableDatabaseError('INCIDENT_UNIT_LOCK_REQUIRED') }
  const found = await tx.query<FailureIncidentStateRow & {
    pod_uid: string; active_attempt_id: string | null; current_epoch: string; due: boolean
  }>(`SELECT s.*,i.pod_uid,u.active_attempt_id,u.execution_epoch AS current_epoch,
      s.deadline_at<=clock_timestamp() AS due FROM durable_runtime.failure_incident_state s
      JOIN durable_runtime.failure_incidents i ON i.id=s.incident_id JOIN durable_runtime.runtime_units u ON u.id=s.runtime_unit_id
      WHERE s.incident_id=$1 AND s.runtime_unit_id=$2 FOR UPDATE OF s`, [input.incidentId, input.unitId])
  const row = found.rows[0]
  if (!row) { throw new DurableDatabaseError('INCIDENT_MISSING') }
  const base = { incidentId: input.incidentId, revision: row.revision }
  if (row.active_attempt_id !== row.attempt_id || row.current_epoch !== row.execution_epoch) { return { ...base, status: 'STALE' } }
  if (row.state !== 'COLLECTING' || !row.due) { return { ...base, status: 'UNCHANGED' } }
  if (row.revision !== input.expectedRevision) { throw new DurableDatabaseError('INCIDENT_REVISION_CONFLICT') }
  const next = (await tx.query<FailureIncidentStateRow>(
    `UPDATE durable_runtime.failure_incident_state SET state='BLOCKED',reason='RESOURCE_EVIDENCE_DEADLINE',revision=revision+1
     WHERE incident_id=$1 RETURNING *`, [input.incidentId])).rows[0]
  await writeIncidentArtifacts(tx, { actorId: input.receiptKey.principalId, unitId: input.unitId,
    attemptId: row.attempt_id, podUid: row.pod_uid, kind: 'RESOURCE_EVIDENCE_DEADLINE',
    reason: 'RESOURCE_EVIDENCE_DEADLINE', revision: next.revision, evidenceIds: next.evidence_ids,
    previous: { incidentId: row.incident_id, state: row.state, revision: row.revision },
    next: { incidentId: row.incident_id, state: next.state, revision: next.revision,
      reason: next.reason, deadlineAt: next.deadline_at.toISOString(), authority: 'DATA_ONLY' } })
  return { incidentId: input.incidentId, revision: next.revision, status: 'BLOCKED' }
}

export async function expireFailureEvidenceWithReceipt(pool: Pool, request: ExpireIncidentInput): Promise<MutationOutcome> {
  const input = snapshotExpiry(request)
  const payloadHash = evidenceDigest({ incidentId: input.incidentId, unitId: input.unitId, expectedRevision: input.expectedRevision })
  return runDurableMutation(pool, { key: input.receiptKey, payloadHash, locks: { runtimeUnitIds: [input.unitId] } },
    async tx => ({ ...await expireFailureEvidence(tx, input) }))
}
