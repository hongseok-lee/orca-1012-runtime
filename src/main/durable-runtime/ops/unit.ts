import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { readUnitProjectionInTransaction } from '../lifecycle/projection.ts'
import type { OpsActor } from './types.ts'
import type { OpsIncident, OpsSession, OpsTab, OpsUnit, OpsUnitDetail } from './contract.ts'
import { requireUnitAccess } from './access.ts'
import { opsTime, OPS_OPERATION_SELECT, projectOpsOperation } from './operation.ts'
import type { OpsOperationRow } from './operation.ts'

/** Both list and detail use this P113-backed projector. No physical-state or telemetry fabrication. */
export async function projectOpsUnit(tx: DurableTransaction, actor: OpsActor, id: string, controllerConnected: boolean): Promise<OpsUnit> {
  await requireUnitAccess(tx, actor, id)
  const original = await readUnitProjectionInTransaction(tx, logicalId('runtime-unit', id))
  const result = await tx.query<{ pending: string; inputs: string; flight: string; unknown: string }>(`WITH allowed_sessions AS (
      SELECT s.id FROM durable_runtime.sessions s JOIN durable_runtime.workspaces w ON w.id=s.workspace_id
      JOIN durable_runtime.catalog_workspace_metadata c ON c.workspace_id=w.id
      WHERE c.runtime_unit_id=$1 AND w.dataset_name=$2 AND w.id=ANY($3::uuid[])),
      pending_messages AS (SELECT m.id,m.session_id FROM durable_runtime.messages m
        WHERE m.session_id IN (SELECT id FROM allowed_sessions)
        AND m.intake_status IN ('DURABLE','DISPATCH_INTENT','STAGED') AND m.cancel_requested_at IS NULL)
      SELECT (SELECT count(*)::text FROM pending_messages) AS pending,
      (SELECT count(*)::text FROM durable_runtime.input_components x JOIN pending_messages m
        ON m.id=x.message_id AND m.session_id=x.session_id) AS inputs,
      (SELECT count(*)::text FROM durable_runtime.delivery_attempts x WHERE x.session_id IN (SELECT id FROM allowed_sessions)
        AND x.state IN ('DISPATCH_INTENT','STAGED','EFFECT_POSSIBLE','ADMITTED')) AS flight,
      (SELECT count(*)::text FROM durable_runtime.messages x WHERE x.session_id IN (SELECT id FROM allowed_sessions)
        AND x.intake_status='UNKNOWN') AS unknown`, [id, actor.datasetName, actor.workspaceIds])
  const counts = result.rows[0]
  const mounts = await tx.query<{ id: string; access_state: string; epoch: string; writer_attempt_id: string | null;
    grant_state: string | null; grant_attempt_id: string | null; grant_epoch: string | null; revoked_at: Date | null }>(`SELECT DISTINCT b.id,b.access_state,b.epoch,b.writer_attempt_id,
      g.state AS grant_state,g.attempt_id AS grant_attempt_id,g.storage_epoch AS grant_epoch,g.revoked_at
      FROM durable_runtime.runtime_member_storage_bindings m JOIN durable_runtime.sessions s ON s.id=m.session_id
      JOIN durable_runtime.workspaces w ON w.id=s.workspace_id JOIN durable_runtime.storage_bindings b ON b.id=m.storage_binding_id
      LEFT JOIN LATERAL(SELECT state,attempt_id,storage_epoch,revoked_at FROM durable_runtime.storage_write_grants
        WHERE storage_binding_id=b.id ORDER BY granted_at DESC,id DESC LIMIT 1) g ON true
      WHERE m.runtime_unit_id=$1 AND w.dataset_name=$2 AND w.id=ANY($3::uuid[]) ORDER BY b.id`, [id, actor.datasetName, actor.workspaceIds])
  const attempt = original.attempt
  return { id: original.unit.id, revision: original.unit.revision, intentRevision: original.unit.intent_revision,
    alias: null, desiredMode: original.unit.desired_mode, phase: original.unit.phase, observed: original.observed,
    observedAt: null,
    attempt: attempt ? { id: attempt.id, podUid: attempt.podUid, status: attempt.status, node: null, spot: null } : null,
    resources: { desired: null, admitted: null, usage: null, peak: null, nextDownsizeAt: null },
    counts: { pendingMessages: counts.pending, inputComponents: counts.inputs, inFlight: counts.flight, historicalUnknown: counts.unknown },
    mounts: mounts.rows.map(row => ({ id: row.id, accessState: row.access_state, storageEpoch: row.epoch,
      writerAttemptId: row.writer_attempt_id, grant: row.grant_state && row.grant_attempt_id && row.grant_epoch
        ? { state: row.grant_state, attemptId: row.grant_attempt_id, storageEpoch: row.grant_epoch, revokedAt: opsTime(row.revoked_at) } : null })),
    availableActions: [{ action: 'wake', enabled: controllerConnected && original.unit.desired_mode !== 'DELETED',
      reason: !controllerConnected ? 'CONTROLLER_NOT_CONNECTED' : original.unit.desired_mode === 'DELETED' ? 'UNIT_DELETED' : null },
    ...['sleep', 'profile', 'policy', 'retry'].map(action => ({ action, enabled: false, reason: 'ACTION_NOT_CONNECTED' }))] }
}
export async function readOpsDetailRows(tx: DurableTransaction, actor: OpsActor, id: string): Promise<Omit<OpsUnitDetail, 'unit'>> {
  await requireUnitAccess(tx, actor, id)
  const sessions = await tx.query<OpsSession>(`SELECT s.id,s.lifecycle,s.revision FROM durable_runtime.sessions s
    JOIN durable_runtime.workspaces w ON w.id=s.workspace_id JOIN durable_runtime.catalog_workspace_metadata c ON c.workspace_id=w.id
    WHERE c.runtime_unit_id=$1 AND w.dataset_name=$2 AND w.id=ANY($3::uuid[]) ORDER BY s.id`, [id, actor.datasetName, actor.workspaceIds])
  const tabs = await tx.query<OpsTab>(`SELECT t.id,t.workspace_id AS "workspaceId",t.session_id AS "sessionId",t.kind,
    t.terminal_handle AS "terminalHandle",t.lifecycle,t.revision FROM durable_runtime.tabs t JOIN durable_runtime.workspaces w ON w.id=t.workspace_id
    JOIN durable_runtime.catalog_workspace_metadata c ON c.workspace_id=w.id WHERE c.runtime_unit_id=$1 AND w.dataset_name=$2
    AND w.id=ANY($3::uuid[]) ORDER BY t.id`, [id, actor.datasetName, actor.workspaceIds])
  const incidents = await tx.query<{ id: string; runtime_unit_id: string; classification: string; observed_at: Date }>(
    'SELECT id,runtime_unit_id,classification,observed_at FROM durable_runtime.failure_incidents WHERE runtime_unit_id=$1 ORDER BY observed_at DESC,id LIMIT 100', [id])
  const operations = await tx.query<OpsOperationRow>(`${OPS_OPERATION_SELECT} WHERE o.runtime_unit_id=$1 ORDER BY o.id DESC LIMIT 100`, [id])
  const recentIncidents: OpsIncident[] = incidents.rows.map(row => ({ id: row.id, runtimeUnitId: row.runtime_unit_id,
    classification: row.classification, observedAt: opsTime(row.observed_at), state: null, revision: null }))
  return { sessions: sessions.rows, tabs: tabs.rows, recentIncidents, operations: operations.rows.map(projectOpsOperation) }
}
