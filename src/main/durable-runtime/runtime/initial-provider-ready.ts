import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, runDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import type { ReadyProviderBinding } from '../providers/shared/contracts.ts'
import type { ProviderProtectionOwner } from './provider-effect-permit.ts'
import type { CommandClaim, GatewayContext } from './gateway/types.ts'
import { LockedGatewayAuthority, currentAuthoritySql } from './gateway/authority.ts'
import { settleOwnedExecution } from './gateway/claim.ts'
import { originalIdentity, commandById, assertOriginal } from './gateway/store.ts'
import { captureReleaseGateInput } from './release-gate-input.ts'
import { readAgentPodPlan } from './agent-pod-plan-records.ts'
import { immutableSnapshot } from '../providers/shared/immutable-snapshot.ts'
import { publishCatalogTerminalNativeSessionReady } from '../catalog/terminal-native-session.ts'

const deny = (): never => { throw new DurableDatabaseError('INITIAL_PROVIDER_READY_UNCONFIRMED') }
/** Identity of the Pod-local control host the READY provider runs under. */
export type ReadyControlHost = Readonly<{ provider: 'codex' | 'claude'; controlId: string; pid: number; startTicks: string; device: string; inode: string
  controlSha256: string }>

/** The original driver of this cold (Codex DurableCodexDriver or ClaudeDurableProvider). */
export type ReadyDriver = Readonly<{ ownsReadyBinding(binding: ReadyProviderBinding): boolean; readonly connectionInstanceId: string; nativeSessionObserved?(): boolean }>

/** Only the original driver's actual thread/start response may settle READY.
 * This does not start a provider, replay an effect or release its held pins. */
export async function settleInitialProviderReady(pool: Pool, original: Readonly<{
  context: GatewayContext; claim: CommandClaim; planDigest: string
}>, binding: ReadyProviderBinding, driver: ReadyDriver, owner: ProviderProtectionOwner, host?: ReadyControlHost) {
  if (!driver.ownsReadyBinding(binding)) { return deny() }
  // Claude runs only under a recorded host; an unhosted READY stays Codex.
  const provider = host?.provider ?? 'codex'
  const nativeObserved = provider === 'codex' || driver.nativeSessionObserved?.() === true
  const input = immutableSnapshot(original), take = owner.takePreparedProtection.bind(owner)
  const native = immutableSnapshot(binding), lease = take()
  const connect = pool.connect.bind(pool), borrowed: Pool = Object.create(pool, { connect: { value: connect } })
  function pins(): void {
    if (!driver.ownsReadyBinding(binding) || lease !== take() || native.providerRef.provider !== provider ||
        native.connectionInstanceId !== driver.connectionInstanceId || lease.target.attemptId !== native.attemptId ||
        lease.target.podUid !== native.podUid || lease.target.executionEpoch !== native.executionEpoch ||
        !lease.authority.executionTargetPinValid(lease.target) || lease.mounts.length !== 1 ||
        lease.mounts.some(m => !lease.authority.mountPinValid(m.evidence))) { deny() }
  }
  const database = await runDurableTransaction(borrowed, async tx => {
    pins()
    await lockAggregates(tx, { sessionIds: [native.sessionId], runtimeUnitIds: [native.runtimeUnitId] })
    const members = await tx.query<{ session_id: string }>(
      'SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1', [native.runtimeUnitId])
    if (members.rowCount !== 1 || members.rows[0].session_id !== native.sessionId) { return deny() }
    const domains = await tx.query<{ backend_id: string; export_id: string }>(`SELECT b.backend_id,b.export_id
      FROM durable_runtime.runtime_member_storage_bindings m JOIN durable_runtime.storage_bindings b ON b.id=m.storage_binding_id
      WHERE m.runtime_unit_id=$1 AND m.session_id=$2`, [native.runtimeUnitId, native.sessionId])
    await lockAggregates(tx, { storageDomains: domains.rows.map(row => ({ backendId: row.backend_id, exportId: row.export_id })),
      operationIds: [input.context.operationId] })
    const authority = await LockedGatewayAuthority.acquire(tx, input.context)
    const command = await commandById(authority, input.claim.commandId)
    assertOriginal(command, input.claim.identity)
    if (input.context.runtimeUnitId !== native.runtimeUnitId || command.command_name !== 'releaseGate' ||
        command.state !== 'EXECUTING' || command.executor_id !== input.claim.executorId ||
        command.execution_token !== input.claim.executionToken || command.owner_controller_term !== input.context.controller.term) { return deny() }
    await authority.assertExecutionTarget(input.claim.identity.originalEnvelope, false)
    const gate = captureReleaseGateInput(command.input), plan = await readAgentPodPlan(tx, input.context.operationId)
    if (!gate.coldStart || gate.attemptId !== native.attemptId || gate.coldStart.planDigest !== input.planDigest ||
        !plan || plan.planDigest !== input.planDigest || plan.plan.identity.attemptId !== native.attemptId) { return deny() }
    const active = await tx.query(`SELECT a.id FROM durable_runtime.attempts a
      JOIN durable_runtime.runtime_units u ON u.active_attempt_id=a.id
      JOIN durable_runtime.execution_grants g ON g.attempt_id=a.id AND g.runtime_unit_id=u.id
      JOIN durable_runtime.sessions s ON s.id=$6 JOIN durable_runtime.tabs tab ON tab.session_id=s.id
      WHERE u.id=$1 AND u.desired_mode='RUNNING' AND u.phase='REHYDRATING' AND u.execution_epoch=$4
      AND a.id=$2 AND a.pod_uid=$3 AND a.execution_epoch=$4 AND a.incarnation=$5 AND a.status='BOUND'
      AND a.mode='COLD' AND a.ready_at IS NULL AND a.stopped_at IS NULL AND g.state='ACTIVE'
      AND g.execution_epoch=$4 AND s.lifecycle='OPEN' AND s.provider_binding_revision=$7
      AND tab.id=$8 AND tab.terminal_handle=$9 AND tab.lifecycle='OPEN'`,
    [native.runtimeUnitId, native.attemptId, native.podUid, native.executionEpoch, lease.target.incarnation,
      native.sessionId, native.providerBindingRevision, native.tabId, native.terminalHandle])
    if (active.rowCount !== 1) { return deny() }
    for (const held of lease.mounts) {
      const mount = await tx.query(`SELECT b.id FROM durable_runtime.storage_bindings b
        JOIN durable_runtime.storage_write_grants w ON w.storage_binding_id=b.id
        JOIN durable_runtime.storage_mounts m ON m.write_grant_id=w.id
        WHERE b.id=$1 AND b.writer_attempt_id=$2 AND b.access_state='ACTIVE' AND w.attempt_id=$2
        AND w.state='ACTIVE' AND w.storage_epoch=b.epoch AND m.attempt_id=$2 AND m.pod_uid=$3
        AND m.evidence_ref=$4 AND m.mode='RW' AND m.desired_state='ACTIVE' AND m.observed_state='ACTIVE'`,
      [held.bindingId, native.attemptId, native.podUid, held.evidence.evidenceRef])
      if (mount.rowCount !== 1) { return deny() }
    }
    const auth = [input.context.controller.scope, input.context.controller.owner, input.context.controller.term]
    pins()
    if ((await tx.query(`UPDATE durable_runtime.attempts SET status='READY',ready_at=clock_timestamp()
      WHERE id=$4 AND status='BOUND' AND ready_at IS NULL AND ${currentAuthoritySql}`, [...auth, native.attemptId])).rowCount !== 1) { return deny() }
    const unit = await tx.query<{ revision: string }>(`UPDATE durable_runtime.runtime_units SET phase='READY',revision=revision+1
      WHERE id=$4 AND phase='REHYDRATING' AND active_attempt_id=$5 AND ${currentAuthoritySql} RETURNING revision`,
    [...auth, native.runtimeUnitId, native.attemptId])
    if (unit.rowCount !== 1) { return deny() }
    const result = { ready: true, nativeSessionObserved: nativeObserved,
      providerBindings: nativeObserved ? [{ ...native.providerRef }] : [],
      ...(!nativeObserved ? { launchProviderRef: { ...native.providerRef } } : {}) }
    const settled = await settleOwnedExecution(authority, input.claim, { state: 'RESOLVED', result, evidenceRefs: [] })
    if ((await tx.query(`UPDATE durable_runtime.operations SET result=$5::jsonb,revision=revision+1
      WHERE id=$4 AND result IS NULL AND step='RELEASE_GATE' AND ${currentAuthoritySql}`,
    [...auth, input.context.operationId, JSON.stringify({ state: 'SUCCEEDED', ...result })])).rowCount !== 1) { return deny() }
    const event = { kind: 'INITIAL_PROVIDER_READY', attemptId: native.attemptId, podUid: native.podUid,
      executionEpoch: native.executionEpoch, providerBindingRevision: native.providerBindingRevision,
      nativeSessionObserved: nativeObserved,
      ...(nativeObserved ? { providerRef: { ...native.providerRef } } : { launchProviderRef: { ...native.providerRef } }),
      connectionInstanceId: native.connectionInstanceId }
    const audit = await appendAudit(tx, { actorId: input.context.controller.owner, runtimeUnitId: native.runtimeUnitId,
      operationId: input.context.operationId, sessionId: native.sessionId, kind: event.kind, nextState: event,
      occurredAt: new Date(), receivedAt: new Date(), producerId: randomUUID(), producerSeq: counter('sequence:producer', '1'), evidenceRefs: [] })
    await enqueueOutbox(tx, { eventId: logicalId('event', audit), aggregateId: native.runtimeUnitId, aggregateKind: 'runtime-unit',
      revision: counter('row:runtime-unit', unit.rows[0].revision), event })
    if (host) {
      // Recorded with READY so a later backend can re-attach to this exact control.
      await tx.query(`INSERT INTO durable_runtime.agent_control_hosts(attempt_id,runtime_unit_id,session_id,provider,pod_uid,
        control_id,control_pid,control_start_ticks,root_device,root_inode,connection_instance_id,control_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [native.attemptId, native.runtimeUnitId, native.sessionId, host.provider,
        native.podUid, host.controlId, host.pid, host.startTicks, host.device, host.inode, native.connectionInstanceId, host.controlSha256])
    }
    // Final rank10: publish only the original driver's committed native read
    // identity together with READY. No metadata state or principal is made.
    // Init may race READY settlement after the launch-ready snapshot. The
    // committed native observation can certify the identity without rewriting
    // that original snapshot or missing its first Catalog notification.
    const observed = nativeObserved || (await tx.query(`SELECT 1 FROM durable_runtime.runtime_audit_events
      WHERE attempt_id=$1 AND pod_uid=$2 AND kind='INITIAL_PROVIDER_NATIVE_OBSERVED'
      AND next_state->'providerRef'=$3::jsonb`, [native.attemptId,native.podUid,JSON.stringify(native.providerRef)])).rowCount === 1
    if (observed) { await publishCatalogTerminalNativeSessionReady(tx, audit, native) }
    await authority.assertCurrent(); pins()
    return Object.freeze({ receipt: Object.freeze({ identity: originalIdentity(settled), state: 'RESOLVED' as const, result }),
      unitRevision: unit.rows[0].revision })
  })
  return Object.freeze({ database, ready: database.ok && database.commitOutcome === 'ACKNOWLEDGED' && !database.cleanupFailed,
    retainedProtection: lease })
}
