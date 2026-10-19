import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, runDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { currentAuthoritySql } from './gateway/authority.ts'
import { defaultPodAuthHttps, exchangePodAuth } from './kubernetes-pod-auth-transport.ts'

const deny = (code: string): never => { throw new DurableDatabaseError(`ORPHAN_RECONCILE_${code}`) }

export type OrphanCandidate = Readonly<{
  attemptId: string; runtimeUnitId: string; podUid: string; podName: string; executionEpoch: string; status: string
}>
export type OrphanPodObservation = Readonly<{
  state: 'GONE' | 'PRESENT' | 'UNKNOWN'; podName: string; podUid: string; observedAt: string; observedUid: string | null
}>
export type OrphanController = Readonly<{ scope: string; owner: string; term: string }>
export type OrphanReconcileResult = Readonly<{
  attemptId: string; proofRef: string; sessions: readonly string[]
  revoked: Readonly<{ executionGrants: number; writeGrants: number; mounts: number; bindings: number }>
  uncertainDeliveries: number
}>

/** Attempts the database still treats as the active execution of their unit. */
export async function listOrphanCandidates(pool: Pool): Promise<readonly OrphanCandidate[]> {
  const rows = await pool.query<{ attempt_id: string; runtime_unit_id: string; pod_uid: string; resource_name: string; execution_epoch: string; status: string }>(
    `SELECT a.id AS attempt_id,a.runtime_unit_id,a.pod_uid,p.resource_name,a.execution_epoch::text,a.status
     FROM durable_runtime.attempts a JOIN durable_runtime.runtime_units u ON u.active_attempt_id=a.id
     JOIN durable_runtime.agent_pod_plans p ON p.attempt_id=a.id
     WHERE a.stopped_at IS NULL AND a.pod_uid IS NOT NULL ORDER BY a.started_at`)
  return Object.freeze(rows.rows.map(row => Object.freeze({ attemptId: row.attempt_id, runtimeUnitId: row.runtime_unit_id,
    podUid: row.pod_uid, podName: row.resource_name, executionEpoch: row.execution_epoch, status: row.status })))
}

/** Exact-name read of the Agent Pod. The attempt's Pod is GONE when the name is
 * absent or now names a different UID: a gracefully deleted Pod object is
 * removed only after the kubelet reports its containers terminated. Anything
 * else, including a failed read, is UNKNOWN and reconciles nothing. */
export async function observeAgentPod(api: Readonly<{ apiOrigin: string; ca: Uint8Array; namespace: string; reviewer: string }>,
  candidate: Pick<OrphanCandidate, 'podName' | 'podUid'>, signal: AbortSignal): Promise<OrphanPodObservation> {
  const base = { podName: candidate.podName, podUid: candidate.podUid }
  const path = `/api/v1/namespaces/${encodeURIComponent(api.namespace)}/pods/${encodeURIComponent(candidate.podName)}`
  try {
    const pod = await exchangePodAuth(defaultPodAuthHttps, api.apiOrigin, api.ca, path, api.reviewer, undefined, 'POD_NOT_FOUND', signal)
    const uid = pod && typeof pod === 'object' ? Reflect.get(Object(Reflect.get(pod, 'metadata')), 'uid') : null
    if (typeof uid !== 'string' || !uid) { return Object.freeze({ ...base, state: 'UNKNOWN', observedAt: new Date().toISOString(), observedUid: null }) }
    return Object.freeze({ ...base, state: uid === candidate.podUid ? 'PRESENT' : 'GONE', observedAt: new Date().toISOString(), observedUid: uid })
  } catch (error) {
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null
    return Object.freeze({ ...base, state: code === 'POD_NOT_FOUND' ? 'GONE' : 'UNKNOWN', observedAt: new Date().toISOString(), observedUid: null })
  }
}

/** Revokes every grant, mount and writer reservation of an attempt whose Pod
 * is observed GONE, under the current controller lease, in one transaction.
 * Storage bindings get a new epoch so no late write of the old writer can be
 * accepted. The Session and its history stay; an UNKNOWN delivery stays UNKNOWN. */
export async function reconcileOrphanedAttempt(pool: Pool, controller: OrphanController,
  candidate: OrphanCandidate, observation: OrphanPodObservation, actorId: string) {
  if (observation.state !== 'GONE' || observation.podUid !== candidate.podUid || observation.podName !== candidate.podName) {
    return deny('POD_NOT_PROVEN_GONE')
  }
  const proofRef = `k8s-pod-absent:${candidate.podName}:${candidate.podUid}:${observation.observedAt}`
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
      WHERE a.id=$1 AND a.runtime_unit_id=$2 AND a.pod_uid=$3 AND a.stopped_at IS NULL AND a.execution_epoch=$4`,
    [candidate.attemptId, candidate.runtimeUnitId, candidate.podUid, candidate.executionEpoch])
    if (current.rowCount !== 1) { return deny('ATTEMPT_NOT_CURRENT') }
    if (!(await tx.query(`SELECT 1 WHERE ${currentAuthoritySql}`, auth)).rowCount) { return deny('CONTROLLER_NOT_CURRENT') }
    const writeGrants = await tx.query(`UPDATE durable_runtime.storage_write_grants SET state='REVOKED',revoked_at=clock_timestamp(),
      revocation_proof_ref=$2,revision=revision+1 WHERE attempt_id=$1 AND state<>'REVOKED' RETURNING id`, [candidate.attemptId, proofRef])
    const mounts = await tx.query(`UPDATE durable_runtime.storage_mounts SET desired_state='REVOKED',observed_state='REVOKED',
      revoked_at=clock_timestamp(),evidence_ref=$2 WHERE attempt_id=$1 AND observed_state<>'REVOKED' RETURNING id`, [candidate.attemptId, proofRef])
    // New epoch fences any late write of the old writer; identity proof is kept.
    const bindings = await tx.query(`UPDATE durable_runtime.storage_bindings SET epoch=epoch+1,revision=revision+1,writer_attempt_id=NULL,
      access_state=CASE WHEN identity_verified_at IS NULL THEN 'UNVERIFIED' ELSE 'VERIFIED' END
      WHERE writer_attempt_id=$1 RETURNING id`, [candidate.attemptId])
    const executionGrants = await tx.query(`UPDATE durable_runtime.execution_grants SET state='REVOKED',revoked_at=clock_timestamp(),
      stopped_proof_ref=$2,revision=revision+1 WHERE attempt_id=$1 AND state<>'REVOKED' RETURNING id`, [candidate.attemptId, proofRef])
    if ((await tx.query(`UPDATE durable_runtime.attempts SET status='STOPPED',stopped_at=clock_timestamp(),reason='ORPHAN_POD_ABSENT'
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
    const event = { kind: 'AGENT_ORPHAN_RECONCILED', attemptId: candidate.attemptId, podUid: candidate.podUid, podName: candidate.podName,
      observedAt: observation.observedAt, observedUid: observation.observedUid, proofRef, sessions,
      revoked: { executionGrants: executionGrants.rowCount ?? 0, writeGrants: writeGrants.rowCount ?? 0,
        mounts: mounts.rowCount ?? 0, bindings: bindings.rowCount ?? 0 }, uncertainDeliveries: uncertain.rowCount ?? 0 }
    const audit = await appendAudit(tx, { actorId, runtimeUnitId: candidate.runtimeUnitId, attemptId: candidate.attemptId, podUid: candidate.podUid,
      ...(sessions[0] ? { sessionId: logicalId('session', sessions[0]) } : {}),
      kind: event.kind, nextState: event, occurredAt: new Date(), receivedAt: new Date(), producerId: randomUUID(),
      producerSeq: counter('sequence:producer', '1'), evidenceRefs: [] })
    await enqueueOutbox(tx, { eventId: logicalId('event', audit), aggregateId: candidate.runtimeUnitId, aggregateKind: 'runtime-unit',
      revision: counter('row:runtime-unit', unit.rows[0].revision), event })
    const result: OrphanReconcileResult = Object.freeze({ attemptId: candidate.attemptId, proofRef, sessions: Object.freeze(sessions),
      revoked: Object.freeze(event.revoked), uncertainDeliveries: event.uncertainDeliveries })
    return result
  })
}
