import { isDeepStrictEqual } from 'node:util'
import type { Pool } from 'pg'
import { DurableDatabaseError, runDurableTransaction } from '../db/connection.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import type { StorageBindingId } from '../../../shared/durable-runtime/identity.ts'
import type { ProviderEffectIdentity, ProviderEffectPermit } from '../providers/shared/contracts.ts'
import { immutableSnapshot } from '../providers/shared/recovery-renderer.ts'
import { LockedGatewayAuthority } from './gateway/authority.ts'
import { commandById, assertOriginal } from './gateway/store.ts'
import type { GatewayContext } from './gateway/types.ts'

const deny = (code: string): never => { throw new DurableDatabaseError(code) }

/** DISPATCH permit for a provider this process ADOPTED from an earlier owner.
 * The database checks are those of the original permit: the dispatch command
 * is EXECUTING under this controller term, the attempt/grant/session/tab are
 * current, every protected writer and mount is ACTIVE, and the delivery is the
 * EFFECT_POSSIBLE one. In place of in-memory evidence pins of the original
 * owner, the adopted control must still be the same live re-attached process. */
export function createAdoptedDispatchPermit(pool: Pool, originalContext: GatewayContext,
  originalIdentity: ProviderEffectIdentity, control: Readonly<{ valid(): boolean }>,
  commitGuard?: (tx: DurableTransaction) => Promise<void>): Readonly<{ permit: ProviderEffectPermit }> {
  const context = immutableSnapshot(originalContext), identity = immutableSnapshot(originalIdentity)
  if (identity.kind !== 'DISPATCH') { deny('ADOPTED_EFFECT_KIND') }
  const valid = control.valid.bind(control), connect = pool.connect
  const borrowed: Pool = Object.create(pool, { connect: { value: () => Reflect.apply(connect, pool, []) } })
  let consumed = false
  const permit: ProviderEffectPermit = Object.freeze({
    async invoke<T>(supplied: ProviderEffectIdentity, effect: () => Promise<T>): Promise<T> {
      if (consumed) { return deny('PROVIDER_EFFECT_ALREADY_INVOKED') }
      consumed = true
      if (typeof effect !== 'function' || !isDeepStrictEqual(immutableSnapshot(supplied), identity)) { return deny('PROVIDER_EFFECT_IDENTITY') }
      const binding = identity.binding, claim = identity.commandClaim
      const live = (): void => { if (!valid()) { deny('ADOPTED_CONTROL_NOT_ATTACHED') } }
      const database = await runDurableTransaction(borrowed, async tx => {
        live()
        await lockAggregates(tx, { sessionIds: [binding.sessionId], runtimeUnitIds: [binding.runtimeUnitId] })
        const members = await tx.query<{ storage_binding_id: StorageBindingId; backend_id: string; export_id: string }>(
          `SELECT m.storage_binding_id,b.backend_id,b.export_id FROM durable_runtime.runtime_member_storage_bindings m
           JOIN durable_runtime.storage_bindings b ON b.id=m.storage_binding_id WHERE m.runtime_unit_id=$1 AND m.session_id=$2`,
          [binding.runtimeUnitId, binding.sessionId])
        await lockAggregates(tx, { storageDomains: members.rows.map(row => ({ backendId: row.backend_id, exportId: row.export_id })),
          operationIds: [context.operationId] })
        const gateway = await LockedGatewayAuthority.acquire(tx, context)
        const row = await commandById(gateway, claim.commandId)
        assertOriginal(row, claim.identity)
        if (context.runtimeUnitId !== binding.runtimeUnitId || row.state !== 'EXECUTING' || row.execution_token !== claim.executionToken ||
            row.executor_id !== claim.executorId || row.owner_controller_term !== context.controller.term ||
            claim.controllerTerm !== context.controller.term || row.command_name !== 'dispatchInput') { deny('PROVIDER_COMMAND_NOT_CURRENT') }
        await gateway.assertExecutionTarget(claim.identity.originalEnvelope, false)
        const active = await tx.query(`SELECT a.id FROM durable_runtime.attempts a JOIN durable_runtime.runtime_units u ON u.active_attempt_id=a.id
          JOIN durable_runtime.execution_grants g ON g.attempt_id=a.id AND g.runtime_unit_id=u.id
          JOIN durable_runtime.agent_control_hosts h ON h.attempt_id=a.id AND h.connection_instance_id=$9
          JOIN durable_runtime.sessions s ON s.id=$6 JOIN durable_runtime.tabs tab ON tab.session_id=s.id
          WHERE u.id=$1 AND a.id=$2 AND a.pod_uid=$3 AND a.execution_epoch=$4 AND u.execution_epoch=$4 AND g.execution_epoch=$4
          AND g.state='ACTIVE' AND u.desired_mode='RUNNING' AND u.phase='READY' AND a.stopped_at IS NULL AND a.status='READY'
          AND s.lifecycle='OPEN' AND s.provider_binding_revision=$5 AND tab.id=$7 AND tab.terminal_handle=$8 AND tab.lifecycle='OPEN'
          AND h.pod_uid=$3`,
        [binding.runtimeUnitId, binding.attemptId, binding.podUid, binding.executionEpoch, binding.providerBindingRevision,
          binding.sessionId, binding.tabId, binding.terminalHandle, binding.connectionInstanceId])
        if (active.rowCount !== 1) { deny('PROVIDER_EXECUTION_GRANT_REQUIRED') }
        const writers = await tx.query<{ id: StorageBindingId }>(`SELECT b.id FROM durable_runtime.runtime_member_storage_bindings m
          JOIN durable_runtime.storage_bindings b ON b.id=m.storage_binding_id
          JOIN durable_runtime.storage_write_grants w ON w.storage_binding_id=b.id AND w.attempt_id=$3
          JOIN durable_runtime.storage_mounts x ON x.write_grant_id=w.id
          WHERE m.runtime_unit_id=$1 AND m.session_id=$2 AND b.writer_attempt_id=$3 AND b.access_state='ACTIVE' AND w.state='ACTIVE'
          AND w.storage_epoch=b.epoch AND x.attempt_id=$3 AND x.pod_uid=$4 AND x.grant_epoch=b.epoch AND x.mode='RW'
          AND x.desired_state='ACTIVE' AND x.observed_state='ACTIVE'`, [binding.runtimeUnitId, binding.sessionId, binding.attemptId, binding.podUid])
        if (writers.rowCount !== members.rowCount || members.rows.some(member => !writers.rows.some(row => row.id === member.storage_binding_id))) {
          deny('PROVIDER_ALL_PROTECTED_WRITERS_REQUIRED')
        }
        const delivery = await tx.query(`SELECT d.id FROM durable_runtime.delivery_attempts d JOIN durable_runtime.messages m ON m.id=d.message_id
          JOIN durable_runtime.sessions s ON s.id=d.session_id
          WHERE d.id=$1 AND d.message_id=$2 AND d.session_id=$3 AND d.runtime_unit_id=$4 AND d.attempt_id=$5
          AND d.execution_epoch=$6 AND d.state='EFFECT_POSSIBLE' AND m.intake_status='EFFECT_POSSIBLE'
          AND m.sealed_revision=$7 AND m.sealed_payload_hash=$8 AND m.cancel_revision=0 AND s.context_revision=$9`,
        [identity.deliveryAttemptId, identity.messageId, binding.sessionId, binding.runtimeUnitId, binding.attemptId,
          binding.executionEpoch, identity.sealedRevision, identity.sealedPayloadHash, identity.contextRevision])
        if (delivery.rowCount !== 1) { deny('PROVIDER_DELIVERY_NOT_CURRENT') }
        if (commitGuard) { await commitGuard(tx) }
        await gateway.assertCurrent()
        live()
      })
      if (!database.ok || database.cleanupFailed) {
        throw database.ok ? new DurableDatabaseError('PROVIDER_COMMIT_CLEANUP_UNCONFIRMED') : database.error
      }
      // As in the original permit, no effect runs inside the transaction and an
      // uncertain COMMIT never falls through to native I/O.
      live()
      return effect()
    },
  })
  return Object.freeze({ permit })
}
