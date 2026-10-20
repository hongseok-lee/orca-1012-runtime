import { reconcileClosedUnits } from '../durable-runtime/lifecycle/closed-unit.ts'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../shared/durable-runtime/identity.ts'
import { withDurableTransaction } from '../durable-runtime/db/connection.ts'
import { discoverUnitMembers, lockUnitMembers } from '../durable-runtime/lifecycle/locks.ts'
import { reserveSleep, type PreparedMemberActivity } from '../durable-runtime/lifecycle/sleep.ts'
import type { LifecyclePolicy } from '../durable-runtime/lifecycle/types.ts'
import type { ControllerPassRequest } from '../durable-runtime/ha/pass.ts'
import type { TerminalRuntimeLookup } from '../durable-runtime/input/runtime-input-types.ts'
import { currentAuthoritySql } from '../durable-runtime/runtime/gateway/authority.ts'
import type { ExecutorId, GatewayContext } from '../durable-runtime/runtime/gateway/types.ts'
import { retireAgentPod } from '../durable-runtime/runtime/agent-pod-retirement.ts'
import type { OrcadControllerConfig } from './orcad-controller-config.ts'
import { readOrcadControllerCredential } from './orcad-controller-credential.ts'

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' ? value as Record<string, unknown> : null

/** Uses the existing controller lease, lifecycle operation and exact Pod stop
 * proof. It does not create another timer, execution owner or permission layer. */
export function prepareOrcadIdleLifecycle(pool: Pool, config: OrcadControllerConfig, ca: Uint8Array,
  lookup: TerminalRuntimeLookup, policy: LifecyclePolicy) {
  const executorId = 'orca-idle-lifecycle' as ExecutorId
  let lastError: string | null = null
  const sweep: NonNullable<ControllerPassRequest['adoptRuntimes']> = async (signal, controller) => {
    const auth = [controller.scope, controller.owner, controller.term]
    if (signal.aborted) { return 0 }
    await reconcileClosedUnits(pool, controller, policy)
    // Initialization uses READY/input time, not the time a query opens a screen.
    if (policy.idleDurationMs !== null) {
      await pool.query(`UPDATE durable_runtime.runtime_units u SET idle_due_at=COALESCE(u.last_work_event_at,a.ready_at)+$4::bigint*interval '1 millisecond'
        FROM durable_runtime.attempts a WHERE a.id=u.active_attempt_id AND a.ready_at IS NOT NULL
        AND u.desired_mode='RUNNING' AND u.idle_due_at IS NULL AND ${currentAuthoritySql}`, [...auth, policy.idleDurationMs])
    }
    const candidates = await pool.query<{ id: string; revision: string; intent_revision: string; active_attempt_id: string; execution_epoch: string; pod_uid: string }>(`
      SELECT u.id,u.revision::text,u.intent_revision::text,u.active_attempt_id,u.execution_epoch::text,a.pod_uid
      FROM durable_runtime.runtime_units u JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id
      WHERE u.desired_mode='RUNNING' AND u.phase='READY' AND u.idle_due_at<=clock_timestamp()
      AND a.stopped_at IS NULL AND ${currentAuthoritySql} ORDER BY u.idle_due_at`, auth)
    let handled = 0, observed = 0
    for (const unit of candidates.rows) {
      if (signal.aborted || policy.idleDurationMs === null || observed >= 8) { break }
      const id = logicalId('runtime-unit', unit.id), members = await discoverUnitMembers(pool, id)
      const samples = new Map<string, { evidence: PreparedMemberActivity; idle: NonNullable<ReturnType<TerminalRuntimeLookup>>['idle']; lastWorkAt: number }>()
      let busy = false
      for (const sessionId of members) {
        const port = lookup(sessionId)
        if (!port?.idle?.supported() || port.binding.attemptId !== unit.active_attempt_id) { busy = true; break }
        let sample: Record<string, unknown> | null
        try { observed++; sample = record(await port.idle.request('IDLE_OBSERVE')) }
        catch { busy = true; lastError = 'IDLE_OBSERVATION_UNAVAILABLE'; break }
        if (!sample || typeof sample.lastWorkAt !== 'number' || !Number.isFinite(sample.lastWorkAt) || typeof sample.sequence !== 'string' || !/^\d+$/.test(sample.sequence)) { busy = true; break }
        if (sample.idle !== true) { busy = true }
        // This constructor is reached only through the resident authenticated
        // control. The existing brand marks prepared evidence, not a grant.
        const evidence = Object.freeze({ sessionId, attemptId: logicalId('attempt', unit.active_attempt_id), podUid: unit.pod_uid,
          executionEpoch: unit.execution_epoch, observedAt: new Date(), producerCommittedWatermark: sample.sequence,
          observedWatermark: sample.sequence, sourceEvidenceRef: `resident:${unit.active_attempt_id}:${sample.sequence}`,
          activeTurn: sample.activeTurn === true, activeTool: false, backgroundWriter: sample.backgroundWriter === true,
          inFlightDispatch: false }) as PreparedMemberActivity
        samples.set(sessionId, { evidence, idle: port.idle, lastWorkAt: Number(sample.lastWorkAt) })
      }
      if (!samples.size || samples.size !== members.length) { continue }
      const lastWorkAt = Math.max(...[...samples.values()].map(sample => sample.lastWorkAt))
      try {
        const result = await withDurableTransaction(pool, async tx => {
          await lockUnitMembers(tx, id, members)
          if (!(await tx.query(`SELECT 1 WHERE ${currentAuthoritySql}`, auth)).rowCount) { return null }
          // A currently active turn/tool is ongoing work. An idle read itself
          // never extends the deadline; it only imports a real resident event.
          if (busy || lastWorkAt + policy.idleDurationMs! > Date.now()) {
            await tx.query(`UPDATE durable_runtime.runtime_units SET last_work_event_at=GREATEST(last_work_event_at,
              CASE WHEN $4 THEN clock_timestamp() ELSE LEAST($3::timestamptz,clock_timestamp()) END),
              idle_due_at=GREATEST(COALESCE(last_work_event_at,'epoch'),CASE WHEN $4 THEN clock_timestamp() ELSE LEAST($3::timestamptz,clock_timestamp()) END)+$5::bigint*interval '1 millisecond',
              revision=revision+1 WHERE id=$1 AND revision=$2 AND desired_mode='RUNNING'`,
            [id, unit.revision, new Date(lastWorkAt), busy, policy.idleDurationMs])
            return null
          }
          return reserveSleep(tx, { unitId: id, actorId: controller.owner, discoveredMembers: members,
            expectedRevision: counter('row:runtime-unit', unit.revision), expectedIntentRevision: counter('intent-revision', unit.intent_revision),
            policy, onlyWhenIdleDue: true, activityFreshnessMs: 15000,
            activity: { member: sessionId => samples.get(sessionId)?.evidence ?? null,
              pinValid: evidence => samples.get(evidence.sessionId)?.idle === lookup(evidence.sessionId)?.idle && samples.get(evidence.sessionId)?.idle?.supported() === true } })
        })
        if (result?.status === 'RESERVED') { handled++ }
      } catch (error) { lastError = typeof Reflect.get(Object(error), 'code') === 'string' ? Reflect.get(Object(error), 'code') : 'IDLE_RESERVATION_FAILED' }
    }
    return handled
  }
  const planStep: NonNullable<ControllerPassRequest['planStep']> = (operation, unit) => {
    if (!['SLEEP', 'DELETE'].includes(operation.kind) || operation.terminal || !unit.active_attempt_id || !operation.expected_pod_uid ||
        operation.intent_revision !== unit.intent_revision) { return null }
    return { step: 'FENCE_ATTEMPT', executorId, mutationKey: `stop:${operation.id}:${operation.step_revision}`,
      input: { attemptId: unit.active_attempt_id, podUid: operation.expected_pod_uid } }
  }
  async function stop(commandId: string, signal: AbortSignal, context: Readonly<GatewayContext>) {
    const auth = [context.controller.scope, context.controller.owner, context.controller.term]
    const row = (await pool.query<{ attemptId: string; runtimeUnitId: string; podUid: string; podName: string; executionEpoch: string; kind: string }>(`
      SELECT a.id AS "attemptId",u.id AS "runtimeUnitId",a.pod_uid AS "podUid",p.resource_name AS "podName",a.execution_epoch::text AS "executionEpoch",o.kind
      FROM durable_runtime.runtime_commands c JOIN durable_runtime.operations o ON o.id=c.operation_id
      JOIN durable_runtime.runtime_units u ON u.id=c.runtime_unit_id JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id
      JOIN durable_runtime.agent_pod_plans p ON p.attempt_id=a.id
      WHERE c.id=$4 AND c.operation_id=$5 AND c.command_name='fenceAttempt' AND c.state IN ('EXECUTING','UNKNOWN')
      AND a.pod_uid=c.expected_pod_uid AND a.execution_epoch=c.execution_epoch AND a.stopped_at IS NULL
      AND o.kind IN ('SLEEP','DELETE') AND ${currentAuthoritySql}`,
    [...auth, commandId, context.operationId])).rows[0]
    if (!row || signal.aborted) { return }
    const members = await discoverUnitMembers(pool, logicalId('runtime-unit', row.runtimeUnitId))
    const started = (await pool.query(`SELECT 1 FROM durable_runtime.runtime_audit_events WHERE operation_id=$1 AND attempt_id=$2 AND kind='IDLE_STOP_STARTED' LIMIT 1`, [context.operationId,row.attemptId])).rowCount
    if (!started) {
    for (const member of members) {
      const port = lookup(member)
      if (row.kind === 'SLEEP') {
        // No fabricated idle on old hosts or a disconnected control.
        if (!port?.idle?.supported()) { lastError = 'IDLE_CONTROL_UNAVAILABLE'; return }
        const sample = record(await port.idle.request('IDLE_QUIESCE'))
        if (sample?.idle !== true || sample.quiesced !== true) { lastError = 'IDLE_MEMBER_ACTIVE'; return }
      }
    }
      // Persist the point of no return before closing the resident control.
      // Reconnect/owner takeover retries this same Pod even after CLOSE detached it.
      const begun = await pool.query(`INSERT INTO durable_runtime.runtime_audit_events(id,actor_id,runtime_unit_id,operation_id,attempt_id,pod_uid,kind,
        next_state,occurred_at,received_at,producer_id,producer_seq,evidence_refs,payload)
        SELECT gen_random_uuid(),$2,$4,$5,$6,$7,'IDLE_STOP_STARTED','{}',clock_timestamp(),clock_timestamp(),gen_random_uuid(),1,'[]','{}'
        WHERE ${currentAuthoritySql}`, [...auth,row.runtimeUnitId,context.operationId,row.attemptId,row.podUid])
      if (!begun.rowCount) { return }
      for (const member of members) { await lookup(member)?.closeForSleep?.() }
    }
    if (signal.aborted || !(await pool.query(`SELECT 1 WHERE ${currentAuthoritySql}`, auth)).rowCount) { return }
    const outcome = await retireAgentPod({ apiOrigin: config.inventory.apiOrigin, ca: Buffer.from(ca), namespace: config.inventory.namespace,
      reviewer: readOrcadControllerCredential(config.inventory.tokenFile, 'TOKEN').toString('utf8').trim() }, row,
    AbortSignal.any([signal, AbortSignal.timeout(config.inventory.requestTimeoutMs)]))
    lastError = outcome === 'REQUESTED' || outcome === 'ABSENT' ? null : `IDLE_RETIRE_${outcome}`
    // Leave the original command unresolved until the orphan reconciler has
    // exact physical stop proof and has revoked every old writer.
  }
  return Object.freeze({ sweep, planStep, executorId,
    executeCommitted: (claim: Parameters<NonNullable<ControllerPassRequest['executeCommitted']>>[0], signal: AbortSignal, context: Readonly<GatewayContext>) => stop(claim.commandId, signal, context),
    lookupOriginal: (command: Parameters<NonNullable<ControllerPassRequest['lookupOriginal']>>[0], signal: AbortSignal, context: Readonly<GatewayContext>) => stop(command.id, signal, context),
    snapshot: () => ({ lastError }) })
}
