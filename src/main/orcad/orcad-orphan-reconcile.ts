import { settleJournaledAttemptTurns } from '../durable-runtime/runtime/orphaned-turn-settlement.ts'
import type { Pool } from 'pg'
import type { ControllerPassRequest } from '../durable-runtime/ha/pass.ts'
import { listOrphanCandidates, observeAgentPod, reconcileOrphanedAttempt, type OrphanCandidate } from '../durable-runtime/runtime/orphan-reconcile.ts'
import { retireAgentPod, releaseAgentPodStopFinalizer } from '../durable-runtime/runtime/agent-pod-retirement.ts'
import { currentAuthoritySql } from '../durable-runtime/runtime/gateway/authority.ts'
import type { OrcadControllerConfig } from './orcad-controller-config.ts'
import { readOrcadControllerCredential } from './orcad-controller-credential.ts'
import { prepareOrphanComputeStop } from './orcad-orphan-compute-stop.ts'

export type OrcadOrphanReconcileSnapshot = Readonly<{ passes: number; reconciled: number; skipped: number; lastError: string | null }>

/** Current controller owns reconciliation; a missing Pod alone never releases its writer. */
export function prepareOrcadOrphanReconcile(pool: Pool, config: OrcadControllerConfig, ca: Uint8Array) {
  const caBytes = Buffer.from(ca)
  let passes = 0, reconciled = 0, skipped = 0, lastError: string | null = null
  const reconcileOrphans: NonNullable<ControllerPassRequest['reconcileOrphans']> = async (signal, controller) => {
    passes++
    let handled = 0
    // Terminal provider frames remain authoritative after finalizer cleanup; a
    // previous owner may have journaled the frame before its input settlement.
    const terminalStopped = await pool.query<{ id: string; pod_uid: string }>(`SELECT DISTINCT a.id,a.pod_uid
      FROM durable_runtime.attempts a JOIN durable_runtime.delivery_attempts d ON d.attempt_id=a.id AND d.state='ADMITTED'
      JOIN durable_runtime.agent_control_hosts h ON h.attempt_id=a.id
      JOIN durable_runtime.session_events e ON e.session_id=d.session_id
      WHERE a.stopped_at IS NOT NULL AND e.body->>'kind'='TERMINAL_CODEX_NOTIFICATION'
        AND e.body->'notification'->>'connectionId'=h.connection_instance_id
        AND e.body->'notification'->>'method'='turn/completed'
        AND e.body->'notification'->'params'->'turn'->>'id'=d.provider_ref
        AND e.body->'notification'->'params'->'turn'->>'status' IN ('completed','failed') LIMIT 32`)
    for (const row of terminalStopped.rows) { await settleJournaledAttemptTurns(pool, row.id, row.pod_uid) }
    const api = () => ({ apiOrigin: config.inventory.apiOrigin, ca: caBytes, namespace: config.inventory.namespace,
      reviewer: readOrcadControllerCredential(config.inventory.tokenFile, 'TOKEN').toString('utf8').trim() })
    for (const candidate of await listOrphanCandidates(pool)) {
      await settleJournaledAttemptTurns(pool, candidate.attemptId, candidate.podUid)
      if (signal.aborted) { break }
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(config.inventory.requestTimeoutMs)])
      const observed = await observeAgentPod(api(), candidate, bounded)
      const childExit=(await pool.query(`SELECT id FROM durable_runtime.runtime_audit_events WHERE attempt_id=$1
        AND pod_uid=$2 AND kind='PROVIDER_CHILD_EXIT_OBSERVED' LIMIT 1`,[candidate.attemptId,candidate.podUid])).rowCount
      if(observed.containerExit && (await pool.query(`SELECT 1 WHERE ${currentAuthoritySql}`,[controller.scope,controller.owner,controller.term])).rowCount) {
        await pool.query(`INSERT INTO durable_runtime.runtime_audit_events(id,actor_id,runtime_unit_id,attempt_id,pod_uid,kind,
          next_state,occurred_at,received_at,producer_id,producer_seq,evidence_refs,payload)
          SELECT gen_random_uuid(),$1,$2,$3,$4,'AGENT_CONTAINER_EXIT_OBSERVED',$5::jsonb,clock_timestamp(),clock_timestamp(),gen_random_uuid(),1,'[]','{}'
          WHERE NOT EXISTS(SELECT 1 FROM durable_runtime.runtime_audit_events WHERE attempt_id=$3 AND kind='AGENT_CONTAINER_EXIT_OBSERVED')`,
        [controller.owner,candidate.runtimeUnitId,candidate.attemptId,candidate.podUid,JSON.stringify(observed.containerExit)])
      }
      if (observed.state === 'PRESENT') {
        if(!observed.containerExit && !childExit) {skipped++;continue}
        if(!(await pool.query(`SELECT 1 WHERE ${currentAuthoritySql}`,[controller.scope,controller.owner,controller.term])).rowCount) {break}
        // Child/root exit leaves host/tool writers possible. Retirement request
        // is not proof: retain status/finalizer and wait for actual sandbox stop.
        const retired=await retireAgentPod(api(),candidate,bounded)
        lastError=retired==='REQUESTED'?'PROCESS_EXIT_RETIREMENT_PENDING':`PROCESS_EXIT_RETIRE_${retired}`
        skipped++;continue
      }
      if (observed.state === 'UNKNOWN') { skipped++; continue }
      let computeStop
      try {
        if (!observed.stopEvidence) { computeStop = await prepareOrphanComputeStop(pool, config, candidate, bounded) ?? undefined }
      } catch { lastError = 'COMPUTE_STOP_UNCONFIRMED' }
      try {
        const result = await reconcileOrphanedAttempt(pool, { scope: controller.scope, owner: controller.owner, term: controller.term },
          candidate, observed, controller.owner, computeStop)
        if (result.ok && result.commitOutcome === 'ACKNOWLEDGED' && !result.cleanupFailed) {
          if (result.value.status === 'RECONCILED') { handled++; reconciled++ }
          else { skipped++; lastError = result.value.reason }
        } else { lastError = result.ok ? 'CLEANUP' : 'ORPHAN_TRANSACTION_FAILED' }
      } finally { computeStop?.release() }
    }
    // Retry cleanup after a crash/uncertain COMMIT; stop facts and revocation are already durable.
    const stopped = await pool.query<OrphanCandidate>(`SELECT a.id AS "attemptId",a.runtime_unit_id AS "runtimeUnitId",
      a.pod_uid AS "podUid",p.resource_name AS "podName",a.execution_epoch::text AS "executionEpoch",a.incarnation,a.status
      FROM durable_runtime.attempts a JOIN durable_runtime.agent_pod_plans p ON p.attempt_id=a.id
      WHERE a.stopped_at IS NOT NULL AND a.reason='WRITER_STOP_CONFIRMED'
        AND EXISTS(SELECT 1 FROM durable_runtime.runtime_audit_events e WHERE e.attempt_id=a.id AND e.kind='AGENT_ORPHAN_RECONCILED')
        AND NOT EXISTS(SELECT 1 FROM durable_runtime.runtime_audit_events e WHERE e.attempt_id=a.id AND e.kind='AGENT_STOP_FINALIZER_RELEASED')
      ORDER BY a.stopped_at LIMIT 32`)
    for (const candidate of stopped.rows) {
      await settleJournaledAttemptTurns(pool, candidate.attemptId, candidate.podUid)
      if (signal.aborted || !(await pool.query(`SELECT 1 WHERE ${currentAuthoritySql}`, [controller.scope,controller.owner,controller.term])).rowCount) { break }
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(config.inventory.requestTimeoutMs)])
      if (await releaseAgentPodStopFinalizer(api(), candidate, bounded)) {
        await pool.query(`INSERT INTO durable_runtime.runtime_audit_events(id,actor_id,runtime_unit_id,attempt_id,pod_uid,kind,
          next_state,occurred_at,received_at,producer_id,producer_seq,evidence_refs,payload)
          VALUES(gen_random_uuid(),$1,$2,$3,$4,'AGENT_STOP_FINALIZER_RELEASED','{}',clock_timestamp(),clock_timestamp(),gen_random_uuid(),1,'[]','{}')`,
        [controller.owner,candidate.runtimeUnitId,candidate.attemptId,candidate.podUid])
      } else { lastError = 'STOP_FINALIZER_CLEANUP_PENDING' }
    }
    return handled
  }
  return Object.freeze({ reconcileOrphans,
    snapshot: (): OrcadOrphanReconcileSnapshot => Object.freeze({ passes, reconciled, skipped, lastError }) })
}
