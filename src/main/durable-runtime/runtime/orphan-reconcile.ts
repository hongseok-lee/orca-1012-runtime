import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, runDurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import { lockAggregates } from '../db/locks.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { writerStopNotification } from './writer-stop-notification.ts'
import { currentAuthoritySql } from './gateway/authority.ts'
import { isCollectedAgentPodStop, type AgentPodObservation } from './agent-pod-stop-evidence.ts'
import type { PreparedComputeStopEvidence } from './compute-stop-evidence-types.ts'

export { observeAgentPod } from './agent-pod-stop-evidence.ts'
const deny = (code: string): never => { throw new DurableDatabaseError(`ORPHAN_RECONCILE_${code}`) }

export type OrphanCandidate = Readonly<{
  attemptId: string; runtimeUnitId: string; podUid: string; podName: string; executionEpoch: string; incarnation: string; status: string
}>
export type OrphanPodObservation = AgentPodObservation
export type OrphanController = Readonly<{ scope: string; owner: string; term: string }>
export type OrphanReconcileResult = Readonly<{
  attemptId: string; proofRef: string; sessions: readonly string[]
  revoked: Readonly<{ executionGrants: number; writeGrants: number; mounts: number; bindings: number }>
  uncertainDeliveries: number
}>

/** Attempts the database still treats as the active execution of their unit. */
export async function listOrphanCandidates(pool: Pool): Promise<readonly OrphanCandidate[]> {
  const rows = await pool.query<{ attempt_id: string; runtime_unit_id: string; pod_uid: string; resource_name: string; execution_epoch: string; incarnation: string; status: string }>(
    `SELECT a.id AS attempt_id,a.runtime_unit_id,a.pod_uid,p.resource_name,a.execution_epoch::text,a.incarnation,a.status
     FROM durable_runtime.attempts a JOIN durable_runtime.runtime_units u ON u.active_attempt_id=a.id
     JOIN durable_runtime.agent_pod_plans p ON p.attempt_id=a.id
     WHERE a.stopped_at IS NULL AND a.pod_uid IS NOT NULL ORDER BY a.started_at`)
  return Object.freeze(rows.rows.map(row => Object.freeze({ attemptId: row.attempt_id, runtimeUnitId: row.runtime_unit_id,
    podUid: row.pod_uid, podName: row.resource_name, executionEpoch: row.execution_epoch, incarnation: row.incarnation, status: row.status })))
}

/** Stop evidence is collected before the transaction; absence alone retains the writer. */
export async function reconcileOrphanedAttempt(pool: Pool, controller: OrphanController,
  candidate: OrphanCandidate, observation: OrphanPodObservation, actorId: string, computeStop?: PreparedComputeStopEvidence) {
  if (observation.podUid !== candidate.podUid || observation.podName !== candidate.podName) { return deny('POD_IDENTITY') }
  const sandbox = observation.stopEvidence
  const permanent = computeStop?.permanentComputeStop(computeStop.reference)
  const target = computeStop?.executionTarget(logicalId('attempt', candidate.attemptId), candidate.podUid, candidate.incarnation, candidate.executionEpoch)
  const computeVerified = !!(permanent && target && computeStop?.computeStopPinValid(permanent) && computeStop.executionTargetPinValid(target) &&
    permanent.disposition === 'DELETED_NO_REENTRY' && permanent.numericInstanceId === target.numericInstanceId &&
    permanent.proof.attemptId === candidate.attemptId && permanent.proof.podUid === candidate.podUid &&
    permanent.proof.executionEpoch === candidate.executionEpoch && permanent.proof.incarnation === candidate.incarnation)
  const sandboxVerified = !!(sandbox && isCollectedAgentPodStop(sandbox) && sandbox.attemptId === candidate.attemptId &&
    sandbox.runtimeUnitId === candidate.runtimeUnitId && sandbox.podUid === candidate.podUid && sandbox.executionEpoch === candidate.executionEpoch)
  const proofRef = sandboxVerified ? sandbox!.proofRef : computeVerified ? computeStop!.reference : null
  const auth = [controller.scope, controller.owner, controller.term]
  return runDurableTransaction(pool, async tx => {
    const members = await tx.query<{ session_id: string }>(
      'SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1 ORDER BY session_id', [candidate.runtimeUnitId])
    const sessions = members.rows.map(row => row.session_id)
    const domains = await tx.query<{ backend_id: string; export_id: string }>(`SELECT DISTINCT b.backend_id,b.export_id
      FROM durable_runtime.storage_bindings b WHERE b.writer_attempt_id=$1 OR b.id IN (SELECT storage_binding_id
      FROM durable_runtime.storage_write_grants WHERE attempt_id=$1)`, [candidate.attemptId])
    await lockAggregates(tx, { sessionIds: sessions.map(id => logicalId('session', id)), runtimeUnitIds: [logicalId('runtime-unit', candidate.runtimeUnitId)],
      storageDomains: domains.rows.map(row => ({ backendId: row.backend_id, exportId: row.export_id })) })
    const current = await tx.query(`SELECT a.id FROM durable_runtime.attempts a JOIN durable_runtime.runtime_units u ON u.active_attempt_id=a.id
      WHERE a.id=$1 AND a.runtime_unit_id=$2 AND a.pod_uid=$3 AND a.stopped_at IS NULL AND a.execution_epoch=$4 AND a.incarnation IS NOT DISTINCT FROM $5`,
    [candidate.attemptId, candidate.runtimeUnitId, candidate.podUid, candidate.executionEpoch,candidate.incarnation])
    if (current.rowCount !== 1) { return deny('ATTEMPT_NOT_CURRENT') }
    if (!(await tx.query(`SELECT 1 WHERE ${currentAuthoritySql}`, auth)).rowCount) { return deny('CONTROLLER_NOT_CURRENT') }
    if (sandboxVerified) {
      const matches = await tx.query(`SELECT 1 FROM durable_runtime.agent_pod_plans p WHERE p.attempt_id=$1 AND p.namespace=$2
        AND p.resource_name=$3 AND NOT EXISTS(SELECT 1 FROM durable_runtime.execution_target_records e
          WHERE e.attempt_id=$1 AND (e.pod_uid<>$4 OR e.node_name<>$5 OR e.execution_epoch<>$6))`,
      [candidate.attemptId,sandbox!.namespace,candidate.podName,candidate.podUid,sandbox!.nodeName,candidate.executionEpoch])
      if (!matches.rowCount) { return deny('STOP_TARGET_MISMATCH') }
    }
    if (!proofRef) {
      const grants = await tx.query(`UPDATE durable_runtime.storage_write_grants SET state='REVOKING',revision=revision+1
        WHERE attempt_id=$1 AND state IN ('RESERVED','ACTIVE')`, [candidate.attemptId])
      const mounts = await tx.query(`UPDATE durable_runtime.storage_mounts SET desired_state='REVOKED',observed_state='REVOKING',revoking_at=clock_timestamp()
        WHERE attempt_id=$1 AND observed_state NOT IN ('REVOKED','REVOKING')`, [candidate.attemptId])
      const bindings = await tx.query(`UPDATE durable_runtime.storage_bindings SET access_state='REVOKING',revision=revision+1
        WHERE writer_attempt_id=$1 AND access_state<>'REVOKING'`, [candidate.attemptId])
      const changed = await tx.query<{ revision: string }>(`UPDATE durable_runtime.runtime_units SET phase='BLOCKED',revision=revision+1
        WHERE id=$1 AND active_attempt_id=$2 AND (phase<>'BLOCKED' OR $3) RETURNING revision`,
      [candidate.runtimeUnitId,candidate.attemptId,!!(grants.rowCount || mounts.rowCount || bindings.rowCount)])
      if (changed.rowCount) {
        const audit = await appendAudit(tx, { actorId, runtimeUnitId: candidate.runtimeUnitId, attemptId: candidate.attemptId, podUid: candidate.podUid,
          kind: 'AGENT_WRITER_STOP_BLOCKED', reasonCode: 'WRITER_STOP_UNCONFIRMED',
          nextState: { observation: observation.state, observedAt: observation.observedAt, observedUid: observation.observedUid },
          occurredAt: new Date(), receivedAt: new Date(), producerId: randomUUID(), producerSeq: counter('sequence:producer','1'), evidenceRefs: [] })
        await enqueueOutbox(tx, { eventId: logicalId('event',audit), aggregateId:candidate.runtimeUnitId, aggregateKind:'runtime-unit',
          revision:counter('row:runtime-unit',changed.rows[0].revision), event:{kind:'AGENT_WRITER_STOP_BLOCKED',reasonCode:'WRITER_STOP_UNCONFIRMED',attemptId:candidate.attemptId} })
        await writerStopNotification(tx,candidate.runtimeUnitId,candidate.attemptId,actorId)
      }
      return Object.freeze({ status: 'BLOCKED' as const, attemptId: candidate.attemptId, reason: 'WRITER_STOP_UNCONFIRMED' })
    }
    // An exact stopped sandbox covers every process in its containers, including detached tools.
    // An epoch increment protects future commands, not old direct NFS writers.
    const writeGrants = await tx.query(`UPDATE durable_runtime.storage_write_grants SET state='REVOKED',revoked_at=clock_timestamp(),
      revocation_proof_ref=$2,revision=revision+1 WHERE attempt_id=$1 AND state<>'REVOKED' RETURNING id`, [candidate.attemptId, proofRef])
    const mounts = await tx.query(`UPDATE durable_runtime.storage_mounts SET desired_state='REVOKED',observed_state='REVOKED',
      revoked_at=clock_timestamp(),evidence_ref=$2 WHERE attempt_id=$1 AND observed_state<>'REVOKED' RETURNING id`, [candidate.attemptId, proofRef])
    // The physical stop was proven above; retain binding identity for the next attempt.
    const bindings = await tx.query(`UPDATE durable_runtime.storage_bindings SET epoch=epoch+1,revision=revision+1,writer_attempt_id=NULL,
      access_state=CASE WHEN identity_verified_at IS NULL THEN 'UNVERIFIED' ELSE 'VERIFIED' END
      WHERE writer_attempt_id=$1 RETURNING id`, [candidate.attemptId])
    const executionGrants = await tx.query(`UPDATE durable_runtime.execution_grants SET state='REVOKED',revoked_at=clock_timestamp(),
      stopped_proof_ref=$2,revision=revision+1 WHERE attempt_id=$1 AND state<>'REVOKED' RETURNING id`, [candidate.attemptId, proofRef])
    if ((await tx.query(`UPDATE durable_runtime.attempts SET status='STOPPED',stopped_at=clock_timestamp(),reason='WRITER_STOP_CONFIRMED'
      WHERE id=$1 AND stopped_at IS NULL`, [candidate.attemptId])).rowCount !== 1) { return deny('ATTEMPT_CAS') }
    // The unit is idle until a new input wakes it; no new attempt is created here.
    // The fenced attempt keeps its execution epoch; the next attempt gets the next one.
    const unit = await tx.query<{ revision: string }>(`UPDATE durable_runtime.runtime_units SET active_attempt_id=NULL,phase='ABSENT',
      execution_epoch=execution_epoch+1,
      desired_mode=CASE WHEN desired_mode='DELETED' THEN desired_mode ELSE 'SUSPENDED' END,intent_revision=intent_revision+1,
      reconcile_due_at=NULL,idle_due_at=NULL,revision=revision+1
      WHERE id=$4 AND active_attempt_id=$5 AND ${currentAuthoritySql} RETURNING revision`, [...auth, candidate.runtimeUnitId, candidate.attemptId])
    if (unit.rowCount !== 1) { return deny('UNIT_CAS') }
    const uncertain = await tx.query(`SELECT id FROM durable_runtime.delivery_attempts WHERE attempt_id=$1 AND state IN ('EFFECT_POSSIBLE','UNKNOWN')`,
      [candidate.attemptId])
    const stopEvidence: JsonValue = sandboxVerified && sandbox ? { ...sandbox, containers:sandbox.containers.map(row=>({...row})) } : permanent ? {
        kind:permanent.proof.kind,evidenceRef:permanent.proof.evidenceRef,observedAt:permanent.proof.observedAt,
        attemptId:permanent.proof.attemptId,podUid:permanent.proof.podUid,executionEpoch:permanent.proof.executionEpoch,
        incarnation:permanent.proof.incarnation,nodeUid:permanent.proof.nodeUid,computeIdentityRef:permanent.proof.computeIdentityRef,
        observationSource:permanent.proof.observationSource,numericInstanceId:permanent.numericInstanceId } : null
    const event = { kind: 'AGENT_ORPHAN_RECONCILED', attemptId: candidate.attemptId, podUid: candidate.podUid, podName: candidate.podName,
      observedAt: observation.observedAt, observedUid: observation.observedUid, proofRef, sessions,
      stopEvidence,
      revoked: { executionGrants: executionGrants.rowCount ?? 0, writeGrants: writeGrants.rowCount ?? 0,
        mounts: mounts.rowCount ?? 0, bindings: bindings.rowCount ?? 0 }, uncertainDeliveries: uncertain.rowCount ?? 0 }
    const audit = await appendAudit(tx, { actorId, runtimeUnitId: candidate.runtimeUnitId, attemptId: candidate.attemptId, podUid: candidate.podUid,
      ...(sessions[0] ? { sessionId: logicalId('session', sessions[0]) } : {}),
      kind: event.kind, nextState: event, occurredAt: new Date(), receivedAt: new Date(), producerId: randomUUID(),
      producerSeq: counter('sequence:producer', '1'), evidenceRefs: [] })
    await enqueueOutbox(tx, { eventId: logicalId('event', audit), aggregateId: candidate.runtimeUnitId, aggregateKind: 'runtime-unit',
      revision: counter('row:runtime-unit', unit.rows[0].revision), event })
    await writerStopNotification(tx,candidate.runtimeUnitId,candidate.attemptId,actorId,proofRef)
    const result: OrphanReconcileResult = Object.freeze({ attemptId: candidate.attemptId, proofRef, sessions: Object.freeze(sessions),
      revoked: Object.freeze(event.revoked), uncertainDeliveries: event.uncertainDeliveries })
    if (computeVerified && (!computeStop?.computeStopPinValid(permanent!) || !computeStop.executionTargetPinValid(target!))) { return deny('STOP_EVIDENCE_RELEASED') }
    return Object.freeze({ status: 'RECONCILED' as const, ...result })
  })
}
