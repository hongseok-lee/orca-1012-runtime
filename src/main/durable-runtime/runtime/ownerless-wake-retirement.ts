import type { Pool } from 'pg'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { runDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { adoptOperation } from '../lifecycle/controller.ts'
import type { LifecycleOperation } from '../lifecycle/types.ts'
import { LockedGatewayAuthority } from './gateway/authority.ts'
import { originalIdentity, takeOverCommand } from './gateway/store.ts'
import type { CommandRow, VerifiedControllerIdentity } from './gateway/types.ts'
import type { AgentPodIdentity } from './agent-pod-stop-evidence.ts'

/** Adopt original operation/commands without replaying them, before retiring its exact failed cold Pod. */
export async function claimOwnerlessWakeRetirement(pool: Pool, controller: VerifiedControllerIdentity,
  operationId: string): Promise<AgentPodIdentity | null> {
  const result = await runDurableTransaction(pool, async tx => {
    const original = (await tx.query<LifecycleOperation>('SELECT * FROM durable_runtime.operations WHERE id=$1 AND kind=\'WAKE\'', [operationId])).rows[0]
    if (!original || original.controller_scope !== controller.scope) { return null }
    const members = (await tx.query<{session_id:string}>('SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1', [original.runtime_unit_id])).rows
    await lockAggregates(tx, {sessionIds:members.map(row=>logicalId('session',row.session_id)),runtimeUnitIds:[original.runtime_unit_id]})
    const context = {controller,runtimeUnitId:original.runtime_unit_id,operationId:original.id}
    const authority = await LockedGatewayAuthority.acquire(tx,context)
    const operation = (await tx.query<LifecycleOperation>('SELECT * FROM durable_runtime.operations WHERE id=$1', [operationId])).rows[0]
    const commands = (await tx.query<CommandRow>(`SELECT * FROM durable_runtime.runtime_commands WHERE operation_id=$1
      AND state IN ('ACCEPTED','EXECUTING','UNKNOWN')`,[operationId])).rows
    if (operation.result !== null && !commands.length) { return null }
    for (const command of commands) { await takeOverCommand(authority,originalIdentity(command)) }
    const unit = (await tx.query<{revision:string;intent_revision:string}>('SELECT revision::text,intent_revision::text FROM durable_runtime.runtime_units WHERE id=$1',[original.runtime_unit_id])).rows[0]
    await adoptOperation(tx,{context,mutationKey:`retire:${operationId}`,expectedUnitRevision:counter('row:runtime-unit',unit.revision),
      expectedIntentRevision:counter('intent-revision',unit.intent_revision),expectedStepRevision:operation.step_revision},operation,new Date())
    // READY runtimes belong to adoption, never failed-wake garbage collection.
    const attempt = (await tx.query<AgentPodIdentity>(`SELECT a.id AS "attemptId",a.runtime_unit_id AS "runtimeUnitId",a.pod_uid AS "podUid",
      p.resource_name AS "podName",a.execution_epoch::text AS "executionEpoch" FROM durable_runtime.attempts a
      JOIN durable_runtime.agent_pod_plans p ON p.attempt_id=a.id JOIN durable_runtime.runtime_units u ON u.active_attempt_id=a.id
      WHERE p.operation_id=$1 AND a.stopped_at IS NULL AND a.ready_at IS NULL AND a.pod_uid IS NOT NULL`,[operationId])).rows[0]
    await authority.assertCurrent()
    return attempt ? Object.freeze(attempt) : null
  })
  return result.ok && result.commitOutcome==='ACKNOWLEDGED' && !result.cleanupFailed ? result.value : null
}
