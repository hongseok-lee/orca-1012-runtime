import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { DurableDatabaseError, runDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { StorageStore } from '../storage/store.ts'
import { sameDirectory } from '../storage/canonical.ts'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { SessionId, RowRevision } from '../../../shared/durable-runtime/identity.ts'
import type { ProviderProtectionLease, ProviderProtectionOwner } from './provider-effect-permit.ts'
import type { CommandClaim, GatewayContext } from './gateway/types.ts'
import { LockedGatewayAuthority, currentAuthoritySql } from './gateway/authority.ts'
import { assertOriginal, commandById } from './gateway/store.ts'
import { readAgentPodPlan } from './agent-pod-plan-records.ts'
import { immutableSnapshot } from '../providers/shared/recovery-renderer.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { recordExecutionTarget } from './execution-target-records.ts'

const deny = (code: string): never => { throw new DurableDatabaseError(code) }

/** First cold, single-Session/single-protected-RW activation. This consumes real
 * held evidence, never collector snapshots. The original namespace/physical
 * owner is retained through COMMIT uncertainty AND the provider lifetime.
 * Grant activation is not provider readiness: bind returns a CLOSED gate. */
export async function activateInitialProviderGrants(pool: Pool, original: Readonly<{
  context: GatewayContext; claim: CommandClaim; sessionId: SessionId
  expectedUnitRevision: RowRevision<'runtime-unit'>; planDigest: string
}>, owner: ProviderProtectionOwner) {
  const input = immutableSnapshot(original), take = owner.takePreparedProtection.bind(owner)
  const connect = pool.connect.bind(pool), borrowed: Pool = Object.create(pool, { connect: { value: connect } })
  const lease: ProviderProtectionLease = take()
  if (!Object.isFrozen(lease) || !Object.isFrozen(lease.authority) || !Object.isFrozen(lease.mounts) ||
      lease.mounts.length !== 1 || !Object.isFrozen(lease.target)) { return deny('INITIAL_PROVIDER_PROTECTION_REQUIRED') }
  const { target, authority } = lease, mounted = lease.mounts[0]
  const execution = authority.executionTarget.bind(authority), executionValid = authority.executionTargetPinValid.bind(authority)
  const directory = authority.directory.bind(authority), directoryValid = authority.directoryPinValid.bind(authority)
  const mount = authority.mount.bind(authority), mountValid = authority.mountPinValid.bind(authority)
  const expectedRevision = counter('row:runtime-unit', input.expectedUnitRevision)
  function pins(): void {
    const record = lease.executionRecord
    if (!record || record.runtimeUnitId !== input.context.runtimeUnitId || record.attemptId !== target.attemptId ||
        record.podUid !== target.podUid || record.incarnation !== target.incarnation || record.executionEpoch !== target.executionEpoch ||
        record.nodeUid !== target.nodeUid || record.computeIdentityRef !== target.computeIdentityRef ||
        record.numericInstanceId !== target.numericInstanceId) { deny('INITIAL_PROVIDER_EXECUTION_RECORD') }
    if (execution(target.attemptId, target.podUid, target.incarnation, target.executionEpoch) !== target || !executionValid(target) ||
        mount(mounted.evidence.evidenceRef) !== mounted.evidence || !mountValid(mounted.evidence) ||
        mounted.evidence.target !== target || mounted.evidence.mode !== 'RW' || mounted.evidence.actualReadOnly ||
        !Object.isFrozen(mounted) || !Object.isFrozen(mounted.evidence) || mounted.clientRoot !== '/agent') {
      deny('INITIAL_PROVIDER_PIN_INVALID')
    }
  }
  const database = await runDurableTransaction(borrowed, async tx => {
    pins()
    await lockAggregates(tx, { sessionIds: [input.sessionId], runtimeUnitIds: [input.context.runtimeUnitId] })
    const members = await tx.query<{ session_id: string }>(
      'SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1', [input.context.runtimeUnitId])
    if (members.rowCount !== 1 || members.rows[0].session_id !== input.sessionId) { deny('INITIAL_PROVIDER_MEMBER_SET') }
    const bindings = await tx.query<{ id: string; backend_id: string; export_id: string; canonical_directory: string;
      identity_proof_ref: string; epoch: string; revision: string; access_state: string; writer_attempt_id: string }>(
      `SELECT b.* FROM durable_runtime.runtime_member_storage_bindings m JOIN durable_runtime.storage_bindings b ON b.id=m.storage_binding_id
       WHERE m.runtime_unit_id=$1 AND m.session_id=$2`, [input.context.runtimeUnitId, input.sessionId])
    if (bindings.rowCount !== 1 || bindings.rows[0].id !== mounted.bindingId) { deny('INITIAL_PROVIDER_BINDING_SET') }
    const binding = bindings.rows[0]
    await lockAggregates(tx, { storageDomains: [{ backendId: binding.backend_id, exportId: binding.export_id }],
      operationIds: [input.context.operationId] })
    const gateway = await LockedGatewayAuthority.acquire(tx, input.context)
    const command = await commandById(gateway, input.claim.commandId)
    assertOriginal(command, input.claim.identity)
    const claim = input.claim
    if (command.command_name !== 'bind' || command.state !== 'EXECUTING' || command.executor_id !== claim.executorId ||
        command.execution_token !== claim.executionToken || command.owner_controller_term !== input.context.controller.term ||
        claim.controllerTerm !== input.context.controller.term || claim.identity.originalEnvelope.podTarget !== 'EXISTING_POD' ||
        claim.identity.originalEnvelope.expectedPodUid !== target.podUid || claim.identity.originalEnvelope.executionEpoch !== target.executionEpoch) {
      deny('INITIAL_PROVIDER_COMMAND_STALE')
    }
    await gateway.assertExecutionTarget(claim.identity.originalEnvelope, false)
    const plan = await readAgentPodPlan(tx, input.context.operationId)
    if (!plan || plan.planDigest !== input.planDigest || plan.plan.identity.attemptId !== target.attemptId ||
        plan.plan.identity.unitId !== input.context.runtimeUnitId || plan.plan.identity.executionEpoch !== target.executionEpoch ||
        plan.plan.mountExpectations.protected.length !== 1 || plan.plan.mountExpectations.protected[0].bindingId !== binding.id ||
        plan.plan.mountExpectations.protected[0].mode !== 'RW' || plan.plan.mountExpectations.protected[0].clientPath !== mounted.clientRoot) {
      deny('INITIAL_PROVIDER_PLAN_SCOPE')
    }
    const unit = await tx.query(`SELECT id FROM durable_runtime.runtime_units WHERE id=$1 AND revision=$2 AND active_attempt_id=$3
      AND execution_epoch=$4 AND desired_mode='RUNNING' AND phase='PROVISIONING'`,
    [input.context.runtimeUnitId, expectedRevision, target.attemptId, target.executionEpoch])
    const attempt = await tx.query(`SELECT id FROM durable_runtime.attempts WHERE id=$1 AND runtime_unit_id=$2 AND pod_uid=$3
      AND execution_epoch=$4 AND mode='COLD' AND status='POD_ASSIGNED' AND incarnation IS NULL
      AND started_at IS NULL AND ready_at IS NULL AND stopped_at IS NULL`,
    [target.attemptId, input.context.runtimeUnitId, target.podUid, target.executionEpoch])
    const writers = await tx.query<{ id: string; revision: string }>(`SELECT id,revision FROM durable_runtime.storage_write_grants
      WHERE storage_binding_id=$1 AND attempt_id=$2 AND storage_epoch=$3 AND state='RESERVED'`,
    [binding.id, target.attemptId, binding.epoch])
    const d = directory(binding.identity_proof_ref)
    if (unit.rowCount !== 1 || attempt.rowCount !== 1 || writers.rowCount !== 1 || binding.access_state !== 'RESERVED' ||
        binding.writer_attempt_id !== target.attemptId || !d || !directoryValid(d) || !sameDirectory(d.candidate, mounted.evidence.directory)) {
      deny('INITIAL_PROVIDER_RESERVATION_STALE')
    }
    // This specialization never revives or replaces another execution/writer.
    if ((await tx.query('SELECT id FROM durable_runtime.attempts WHERE runtime_unit_id=$1 AND id<>$2',
      [input.context.runtimeUnitId, target.attemptId])).rowCount || (await tx.query(`SELECT g.id FROM durable_runtime.storage_write_grants g
      JOIN durable_runtime.storage_bindings b ON b.id=g.storage_binding_id WHERE g.attempt_id<>$4
      AND b.backend_id=$1 AND b.export_id=$2 AND (b.canonical_directory=$3 OR b.canonical_directory='/' OR $3='/'
      OR left(b.canonical_directory,length($3)+1)=$3||'/' OR left($3,length(b.canonical_directory)+1)=b.canonical_directory||'/')`,
    [binding.backend_id, binding.export_id, binding.canonical_directory, target.attemptId])).rowCount) { deny('INITIAL_PROVIDER_OLD_WRITER') }
    const auth = [input.context.controller.scope, input.context.controller.owner, input.context.controller.term]
    async function write(sql: string, values: readonly unknown[]): Promise<void> {
      pins()
      if ((await tx.query(sql, [...auth, ...values])).rowCount !== 1) { deny('INITIAL_PROVIDER_ACTIVATION_STALE') }
    }
    await write(`UPDATE durable_runtime.attempts SET incarnation=$5,status='BOUND',started_at=clock_timestamp()
      WHERE id=$4 AND incarnation IS NULL AND status='POD_ASSIGNED' AND ${currentAuthoritySql} RETURNING id`,
    [target.attemptId, target.incarnation])
    await write(`UPDATE durable_runtime.execution_grants SET state='ACTIVE',revision=revision+1 WHERE attempt_id=$4
      AND runtime_unit_id=$5 AND execution_epoch=$6 AND state='RESERVED' AND ${currentAuthoritySql} RETURNING id`,
    [target.attemptId, input.context.runtimeUnitId, target.executionEpoch])
    await recordExecutionTarget(tx, input.context, lease.executionRecord)
    const store = new StorageStore(authority)
    const result = await store.observeMount(tx, { sessionId: input.sessionId, unitId: input.context.runtimeUnitId,
      expectedUnitRevision: expectedRevision, actorId: input.context.controller.owner, bindingId: mounted.bindingId,
      expectedBindingRevision: counter('row:storage-binding', binding.revision), storageEpoch: counter('storage-epoch', binding.epoch),
      attemptId: target.attemptId, podUid: target.podUid, executionEpoch: target.executionEpoch,
      mountId: randomUUID(), mountEvidenceRef: mounted.evidence.evidenceRef,
      writer: { grantId: writers.rows[0].id, expectedRevision: writers.rows[0].revision } })
    if (result.status !== 'APPLIED') { deny('INITIAL_PROVIDER_MOUNT_NOT_ACTIVE') }
    await write(`UPDATE durable_runtime.runtime_units SET phase='REHYDRATING',revision=revision+1
      WHERE id=$4 AND revision=$5 AND phase='PROVISIONING' AND ${currentAuthoritySql} RETURNING id`,
    [input.context.runtimeUnitId, expectedRevision])
    const event = { kind: 'INITIAL_PROVIDER_GRANTS_ACTIVATED', attemptId: target.attemptId, podUid: target.podUid,
      executionEpoch: target.executionEpoch, bindingId: mounted.bindingId, gate: 'CLOSED', providerReady: false }
    const audit = await appendAudit(tx, { actorId: input.context.controller.owner, runtimeUnitId: input.context.runtimeUnitId,
      operationId: input.context.operationId, sessionId: input.sessionId, kind: event.kind, nextState: event,
      occurredAt: new Date(), receivedAt: new Date(), producerId: randomUUID(), producerSeq: counter('sequence:producer', '1'),
      evidenceRefs: [mounted.evidence.evidenceRef, d.evidenceRef] })
    await enqueueOutbox(tx, { eventId: logicalId('event', audit), aggregateId: input.context.runtimeUnitId, aggregateKind: 'runtime-unit',
      revision: counter('row:runtime-unit', String(BigInt(expectedRevision) + 1n)), event })
    await gateway.assertCurrent(); pins()
    return Object.freeze({ gate: 'CLOSED' as const, providerReady: false as const, writerGrantActivated: true as const,
      unitRevision: String(BigInt(expectedRevision) + 1n) })
  })
  // No release or provider callback here, even when COMMIT was acknowledged.
  // The exact original runtime owner retains this lifetime through cold/inputs.
  return Object.freeze({ database, retainedProtection: lease })
}
