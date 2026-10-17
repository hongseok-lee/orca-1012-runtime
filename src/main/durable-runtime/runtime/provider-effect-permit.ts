import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import type { Pool } from 'pg'
import { DurableDatabaseError, runDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import type { StorageBindingId } from '../../../shared/durable-runtime/identity.ts'
import type { StorageEvidenceAuthority, ExecutionTarget, VerifiedMountEvidence } from '../storage/evidence.ts'
import type { ProviderColdRequest, ProviderEffectIdentity, ProviderEffectPermit } from '../providers/shared/contracts.ts'
import { immutableSnapshot } from '../providers/shared/recovery-renderer.ts'
import { LockedGatewayAuthority } from './gateway/authority.ts'
import { commandById, assertOriginal } from './gateway/store.ts'
import type { GatewayContext } from './gateway/types.ts'
import type { ExecutionTargetObservation } from './execution-target-records.ts'
import { captureReleaseGateInput } from './release-gate-input.ts'
import { readAgentPodPlan } from './agent-pod-plan-records.ts'

/** The physical issuer transfers an ALREADY held lifetime, not a snapshot or
 * an assertion that a mount is ready. No issuer or grant activation is supplied
 * by this boundary. A retained lifetime must be resolved by its original owner. */
export type ProviderProtectionLease = Readonly<{
  authority: StorageEvidenceAuthority
  target: ExecutionTarget
  executionRecord: ExecutionTargetObservation
  mounts: readonly Readonly<{ bindingId: StorageBindingId; clientRoot: string; evidence: VerifiedMountEvidence }>[]
  release(): void | Promise<void>
}>
export type ProviderProtectionOwner = Readonly<{
  takePreparedProtection(): ProviderProtectionLease
}>
/** Captured by trusted server configuration, never from a public request. Full
 * launch/native/env comparison is in memory; no secret-bearing request digest. */
export type ProviderColdExecutionPolicy = Readonly<{
  provider: 'codex' | 'claude'
  home: string
  providerState: string
  request: ProviderColdRequest<unknown>
  protectedRoots: readonly Readonly<{ bindingId: StorageBindingId; clientRoot: string }>[]
}>
export type ProviderEffectLifetime = Readonly<{
  phase: 'UNUSED' | 'VALIDATING' | 'REJECTED' | 'EFFECT_POSSIBLE' | 'COMPLETED'
  protection: 'NOT_TAKEN' | 'HELD' | 'RETAINED'
  commit: 'NOT_ATTEMPTED' | 'ACKNOWLEDGED' | 'NOT_COMMITTED' | 'UNKNOWN'
}>

const deny = (code: string): never => { throw new DurableDatabaseError(code) }

/** Server-internal executor boundary. The original command must already be
 * committed and EXECUTING; TRANSACTION_LOCAL claim shape authenticates nothing.
 * Construction performs no I/O. Invoke borrows a new transaction, confirms its
 * actual COMMIT, and only then runs one effect outside that transaction. */
export function createProviderEffectPermit(pool: Pool, originalContext: GatewayContext,
  originalIdentity: ProviderEffectIdentity, protectionOwner: ProviderProtectionOwner,
  originalColdPolicy?: ProviderColdExecutionPolicy): Readonly<{
    permit: ProviderEffectPermit
    lifetime(): ProviderEffectLifetime
    retainedProtection(): ProviderProtectionLease | null
  }> {
  const context = immutableSnapshot(originalContext), identity = immutableSnapshot(originalIdentity)
  const coldPolicy = originalColdPolicy ? immutableSnapshot(originalColdPolicy) : null
  if (identity.kind !== 'COLD' && identity.kind !== 'DISPATCH') { deny('PROVIDER_EFFECT_KIND') }
  if (!Object.isFrozen(protectionOwner)) { deny('PROVIDER_PROTECTION_OWNER_REQUIRED') }
  const take = protectionOwner.takePreparedProtection, connect = pool.connect
  if (typeof take !== 'function' || typeof connect !== 'function') { deny('PROVIDER_PROTECTION_OWNER_REQUIRED') }
  const borrowed: Pool = Object.create(pool, { connect: { value: () => Reflect.apply(connect, pool, []) } })
  let phase: ProviderEffectLifetime['phase'] = 'UNUSED'
  let protection: ProviderEffectLifetime['protection'] = 'NOT_TAKEN'
  let commit: ProviderEffectLifetime['commit'] = 'NOT_ATTEMPTED'
  let consumed = false
  let retained: ProviderProtectionLease | null = null

  const permit: ProviderEffectPermit = Object.freeze({
    async invoke<T>(supplied: ProviderEffectIdentity, effect: () => Promise<T>): Promise<T> {
      if (consumed) { return deny('PROVIDER_EFFECT_ALREADY_INVOKED') }
      consumed = true
      if (typeof effect !== 'function' || !isDeepStrictEqual(immutableSnapshot(supplied), identity)) {
        phase = 'REJECTED'
        return deny('PROVIDER_EFFECT_IDENTITY')
      }
      phase = 'VALIDATING'
      let lease: ProviderProtectionLease
      try { lease = Reflect.apply(take, protectionOwner, []) }
      catch { phase = 'REJECTED'; protection = 'RETAINED'; return deny('PROVIDER_PROTECTION_HANDOFF') }
      retained = lease
      protection = 'HELD'
      if (!lease || !Object.isFrozen(lease) || !Object.isFrozen(lease.authority) ||
          !Object.isFrozen(lease.target) || !Object.isFrozen(lease.mounts) || !lease.mounts.length ||
          typeof lease.release !== 'function') {
        phase = 'REJECTED'; protection = 'RETAINED'
        return deny('PROVIDER_PROTECTION_HANDOFF')
      }
      const authority = lease.authority, target = lease.target, mounts = lease.mounts
      const directory = authority.directory.bind(authority), directoryValid = authority.directoryPinValid.bind(authority)
      const mount = authority.mount.bind(authority), mountValid = authority.mountPinValid.bind(authority)
      const execution = authority.executionTarget.bind(authority), executionValid = authority.executionTargetPinValid.bind(authority)
      const binding = identity.binding, claim = identity.commandClaim
      function pins(): void {
        const current = execution(binding.attemptId, binding.podUid, target.incarnation, binding.executionEpoch)
        if (current !== target || !executionValid(target) || target.attemptId !== binding.attemptId ||
            target.podUid !== binding.podUid || target.executionEpoch !== binding.executionEpoch ||
            !/^[1-9]\d*$/.test(target.numericInstanceId)) { deny('PROVIDER_EXECUTION_PIN_REQUIRED') }
        const ids = new Set<string>()
        for (const entry of mounts) {
          const evidence = entry.evidence
          if (!Object.isFrozen(entry) || !Object.isFrozen(evidence) || !Object.isFrozen(evidence.directory) ||
              ids.has(entry.bindingId) || evidence.target !== target || evidence.mode !== 'RW' || evidence.actualReadOnly ||
              mount(evidence.evidenceRef) !== evidence || !mountValid(evidence)) { deny('PROVIDER_MOUNT_PIN_REQUIRED') }
          ids.add(entry.bindingId)
        }
        if (identity.kind === 'COLD') {
          if (!coldPolicy || !identity.coldRequest ||
              !isDeepStrictEqual(coldPolicy.request, identity.coldRequest) ||
              !isDeepStrictEqual(identity.coldRequest.binding, binding)) { deny('PROVIDER_COLD_POLICY_REQUIRED') }
          const request = coldPolicy.request
          function within(value: string, root: string): boolean {
            return typeof value === 'string' && typeof root === 'string' && path.posix.isAbsolute(value) &&
              path.posix.normalize(value) === value && path.posix.isAbsolute(root) &&
              path.posix.normalize(root) === root && ![...value, ...root].some(char => char.charCodeAt(0) < 32) &&
              (value === root || value.startsWith(`${root}/`))
          }
          const roots = coldPolicy.protectedRoots
          if (roots.length !== mounts.length || new Set(roots.map(root => root.bindingId)).size !== roots.length || roots.some(expected =>
            !mounts.some(held => held.bindingId === expected.bindingId && held.clientRoot === expected.clientRoot))) {
            deny('PROVIDER_COLD_MOUNT_SET')
          }
          for (const location of [coldPolicy.home, coldPolicy.providerState, request.checkout]) {
            if (!roots.some(root => within(location, root.clientRoot))) { deny('PROVIDER_COLD_PATH_SCOPE') }
          }
          const launch = request.launch
          if (!launch || typeof launch !== 'object' || !('env' in launch) ||
              !launch.env || typeof launch.env !== 'object') { deny('PROVIDER_COLD_ENV_REQUIRED') }
          const env = launch.env
          if (!('HOME' in env) || env.HOME !== coldPolicy.home ||
              ('CODEX_HOME' in env && env.CODEX_HOME !== coldPolicy.providerState) ||
              ('CLAUDE_CONFIG_DIR' in env && env.CLAUDE_CONFIG_DIR !== coldPolicy.providerState) ||
              request.persistentHome !== (coldPolicy.provider === 'codex' ? coldPolicy.providerState : coldPolicy.home) ||
              (request.native.kind === 'RESUME' && request.native.providerRef.provider !== coldPolicy.provider)) {
            deny('PROVIDER_COLD_NATIVE_SCOPE')
          }
          const resumePath = 'resumePath' in launch ? launch.resumePath : null
          if (resumePath !== null && resumePath !== undefined &&
              (typeof resumePath !== 'string' || !roots.some(root => within(resumePath, root.clientRoot)))) {
            deny('PROVIDER_COLD_RESUME_PATH_SCOPE')
          }
        }
      }
      const database = await runDurableTransaction(borrowed, async tx => {
        pins()
        // Membership is authoritative only under the original Session/Unit
        // locks. Discover storage domains after those locks, never from a
        // pre-lock projection that can omit a newly attached binding.
        await lockAggregates(tx, { sessionIds: [binding.sessionId], runtimeUnitIds: [binding.runtimeUnitId] })
        const members = await tx.query<{ storage_binding_id: StorageBindingId; backend_id: string; export_id: string }>(
          `SELECT m.storage_binding_id,b.backend_id,b.export_id FROM durable_runtime.runtime_member_storage_bindings m
           JOIN durable_runtime.storage_bindings b ON b.id=m.storage_binding_id
           WHERE m.runtime_unit_id=$1 AND m.session_id=$2`, [binding.runtimeUnitId, binding.sessionId])
        await lockAggregates(tx, { storageDomains: members.rows.map(row => ({ backendId: row.backend_id, exportId: row.export_id })),
          operationIds: [context.operationId] })
        const gateway = await LockedGatewayAuthority.acquire(tx, context)
        const row = await commandById(gateway, claim.commandId)
        assertOriginal(row, claim.identity)
        if (context.runtimeUnitId !== binding.runtimeUnitId || row.state !== 'EXECUTING' ||
            row.execution_token !== claim.executionToken || row.executor_id !== claim.executorId ||
            row.owner_controller_term !== context.controller.term || claim.controllerTerm !== context.controller.term ||
            row.command_name !== (identity.kind === 'COLD' ? 'releaseGate' : 'dispatchInput')) { deny('PROVIDER_COMMAND_NOT_CURRENT') }
        await gateway.assertExecutionTarget(claim.identity.originalEnvelope, false)
        if (identity.kind === 'COLD') {
          const gate = captureReleaseGateInput(row.input)
          if (gate.attemptId !== binding.attemptId) { deny('PROVIDER_GATE_ATTEMPT') }
          if (gate.coldStart) {
            const plan = await readAgentPodPlan(tx, context.operationId)
            if (!coldPolicy || coldPolicy.request.native.kind !== 'NEW' || !plan ||
                plan.planDigest !== gate.coldStart.planDigest || plan.plan.identity.attemptId !== binding.attemptId ||
                plan.plan.identity.unitId !== binding.runtimeUnitId || plan.plan.identity.executionEpoch !== binding.executionEpoch) {
              deny('PROVIDER_NEW_GATE_PLAN')
            }
            const history = await tx.query(`SELECT id FROM durable_runtime.attempts WHERE runtime_unit_id=$1 AND id<>$2
              UNION ALL SELECT id FROM durable_runtime.provider_context_deliveries WHERE session_id=$3
              UNION ALL SELECT id FROM durable_runtime.delivery_attempts WHERE session_id=$3
                AND (provider_ref IS NOT NULL OR state IN ('EFFECT_POSSIBLE','ADMITTED','SETTLED','UNKNOWN','INTERRUPTED'))
              UNION ALL SELECT id FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1
                AND command_name='releaseGate' AND id<>$4`,
            [binding.runtimeUnitId, binding.attemptId, binding.sessionId, claim.commandId])
            if (history.rowCount) { deny('PROVIDER_NEW_GATE_HISTORY') }
            const oldWriters = await tx.query(`SELECT g.id FROM durable_runtime.storage_write_grants g
              JOIN durable_runtime.storage_bindings old ON old.id=g.storage_binding_id
              JOIN durable_runtime.runtime_member_storage_bindings member ON member.runtime_unit_id=$1 AND member.session_id=$2
              JOIN durable_runtime.storage_bindings current ON current.id=member.storage_binding_id
              WHERE g.attempt_id<>$3 AND old.backend_id=current.backend_id AND old.export_id=current.export_id
              AND (old.canonical_directory=current.canonical_directory OR old.canonical_directory='/' OR current.canonical_directory='/'
                OR left(old.canonical_directory,length(current.canonical_directory)+1)=current.canonical_directory||'/'
                OR left(current.canonical_directory,length(old.canonical_directory)+1)=old.canonical_directory||'/')`,
            [binding.runtimeUnitId, binding.sessionId, binding.attemptId])
            if (oldWriters.rowCount) { deny('PROVIDER_NEW_GATE_WRITER_HISTORY') }
          }
        }
        const active = await tx.query(
          `SELECT a.id FROM durable_runtime.attempts a JOIN durable_runtime.runtime_units u ON u.active_attempt_id=a.id
           JOIN durable_runtime.execution_grants g ON g.attempt_id=a.id AND g.runtime_unit_id=u.id
           JOIN durable_runtime.runtime_members m ON m.runtime_unit_id=u.id
           JOIN durable_runtime.sessions s ON s.id=m.session_id JOIN durable_runtime.tabs tab ON tab.session_id=s.id
           WHERE u.id=$1 AND a.id=$2 AND a.pod_uid=$3 AND a.incarnation=$4 AND a.execution_epoch=$5
           AND u.execution_epoch=$5 AND g.execution_epoch=$5 AND g.state='ACTIVE'
           AND u.desired_mode='RUNNING' AND a.stopped_at IS NULL AND s.id=$6 AND s.lifecycle='OPEN'
           AND s.provider_binding_revision=$7 AND tab.id=$8 AND tab.terminal_handle=$9 AND tab.lifecycle='OPEN'
           AND (($10='COLD' AND u.phase='REHYDRATING') OR ($10='DISPATCH' AND u.phase='READY'))`,
          [binding.runtimeUnitId, binding.attemptId, binding.podUid, target.incarnation, binding.executionEpoch,
            binding.sessionId, binding.providerBindingRevision, binding.tabId, binding.terminalHandle, identity.kind])
        if (active.rowCount !== 1) { deny('PROVIDER_EXECUTION_GRANT_REQUIRED') }
        const protectedMounts = await tx.query<{ id: StorageBindingId; identity_proof_ref: string; evidence_ref: string }>(
          `SELECT b.id,b.identity_proof_ref,x.evidence_ref FROM durable_runtime.runtime_member_storage_bindings m
           JOIN durable_runtime.storage_bindings b ON b.id=m.storage_binding_id
           JOIN durable_runtime.storage_write_grants w ON w.storage_binding_id=b.id AND w.attempt_id=$3
           JOIN durable_runtime.storage_mounts x ON x.write_grant_id=w.id
           WHERE m.runtime_unit_id=$1 AND m.session_id=$2 AND b.writer_attempt_id=$3
           AND b.access_state='ACTIVE' AND w.state='ACTIVE' AND w.storage_epoch=b.epoch
           AND x.attempt_id=$3 AND x.pod_uid=$4 AND x.grant_epoch=b.epoch AND x.mode='RW'
           AND x.desired_state='ACTIVE' AND x.observed_state='ACTIVE'`,
          [binding.runtimeUnitId, binding.sessionId, binding.attemptId, binding.podUid])
        if (protectedMounts.rowCount !== members.rowCount || members.rowCount !== mounts.length ||
            members.rows.some(member => !protectedMounts.rows.some(row => row.id === member.storage_binding_id)) ||
            members.rows.some(member => !mounts.some(held => held.bindingId === member.storage_binding_id))) {
          deny('PROVIDER_ALL_PROTECTED_WRITERS_REQUIRED')
        }
        for (const stored of protectedMounts.rows) {
          const entry = mounts.find(item => item.bindingId === stored.id)
          const d = directory(stored.identity_proof_ref)
          if (!entry || entry.evidence.evidenceRef !== stored.evidence_ref || !d || !directoryValid(d) ||
              !isDeepStrictEqual(d.candidate, entry.evidence.directory)) { deny('PROVIDER_DIRECTORY_PIN_REQUIRED') }
        }
        if (identity.kind === 'DISPATCH') {
          const delivery = await tx.query(
            `SELECT d.id FROM durable_runtime.delivery_attempts d JOIN durable_runtime.messages m ON m.id=d.message_id
             JOIN durable_runtime.sessions s ON s.id=d.session_id
             WHERE d.id=$1 AND d.message_id=$2 AND d.session_id=$3 AND d.runtime_unit_id=$4 AND d.attempt_id=$5
             AND d.execution_epoch=$6 AND d.state='EFFECT_POSSIBLE' AND m.intake_status='EFFECT_POSSIBLE'
             AND m.sealed_revision=$7 AND m.sealed_payload_hash=$8 AND m.cancel_revision=0 AND s.context_revision=$9`,
            [identity.deliveryAttemptId, identity.messageId, binding.sessionId, binding.runtimeUnitId,
              binding.attemptId, binding.executionEpoch, identity.sealedRevision, identity.sealedPayloadHash,
              identity.contextRevision])
          if (delivery.rowCount !== 1) { deny('PROVIDER_DELIVERY_NOT_CURRENT') }
        }
        await gateway.assertCurrent()
        pins()
      })
      commit = database.commitOutcome
      if (!database.ok || database.cleanupFailed) {
        phase = 'REJECTED'
        protection = 'RETAINED'
        throw database.ok ? new DurableDatabaseError('PROVIDER_COMMIT_CLEANUP_UNCONFIRMED') : database.error
      }
      // No callback ever runs inside runDurableTransaction. An unknown outcome
      // retains its physical lifetime and never falls through to native I/O.
      try {
        pins()
        phase = 'EFFECT_POSSIBLE'
        const result = await effect()
        phase = 'COMPLETED'
        // COLD completion is native readiness, not process/descendant shutdown.
        // Keep the physical lifetime with the runtime owner through its actual
        // stopped/revoked resolution; dispatch completion must not unpin HOME.
        return result
      } catch (error) {
        // Native failure can leave descendants/effects alive. Retain protection
        // for the owner's explicit reconciliation, never issue another permit.
        protection = 'RETAINED'
        throw error
      }
    }
  })
  return Object.freeze({ permit, lifetime: () => Object.freeze({ phase, protection, commit }),
    retainedProtection: () => retained })
}
