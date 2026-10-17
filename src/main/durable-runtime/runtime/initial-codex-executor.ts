import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { SessionId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, runDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import type { AgentPodPlanRecord } from '../db/agent-pod-plan-record-rows.ts'
import { DurableCodexDriver } from '../providers/codex/driver.ts'
import type { CodexColdLaunch } from '../providers/codex/driver.ts'
import type { ProviderBinding, ProviderColdRequest, ProviderObservationSink, ReadyProviderBinding } from '../providers/shared/contracts.ts'
import { immutableSnapshot } from '../providers/shared/immutable-snapshot.ts'
import type { CommandClaim, GatewayContext } from './gateway/types.ts'
import { settleInitialEnsureAssigned } from './initial-provider-command-settlement.ts'
import { readInitialProviderPaths } from './initial-provider-paths.ts'
import type { InitialEmptyFolderDeclaration, InitialProviderPaths } from './initial-provider-paths.ts'
import { createInitialProviderProtection } from './initial-provider-protection.ts'
import { prepareInitialProviderStep } from './initial-provider-step.ts'
import { activateInitialProviderGrants } from './initial-provider-grants.ts'
import { createProviderEffectPermit } from './provider-effect-permit.ts'
import { settleInitialProviderReady } from './initial-provider-ready.ts'
import { captureFirstManagedBindingProfile } from '../storage/first-managed-binding-owner-profile.ts'
import { readOriginalFirstManagedDirectory } from '../storage/initial-directory-revalidation-guard.ts'

type ConcreteDeployment = Parameters<typeof createInitialProviderProtection>[1]
export type InitialCodexDeploymentInput = Readonly<{
  plan: AgentPodPlanRecord; podUid: string; paths: InitialProviderPaths
}>
export type InitialCodexExecutorConfiguration = Readonly<{
  sessionId: SessionId
  planDigest: string
  emptyFolder: InitialEmptyFolderDeclaration
  /** Trusted startup composition returns concrete original clients/configs,
   * never an observation, authority implementation or ready/pin boolean. */
  deployment(input: InitialCodexDeploymentInput, signal: AbortSignal): Promise<Readonly<{
    config: ConcreteDeployment
    originalAuditId: string
    pinId: string; ownerToken: string; actorId: string
    creationStartTime: string; creationEndTime: string
  }>>
  sink: ProviderObservationSink
}>
const deny = (suffix: string): never => { throw new DurableDatabaseError(`INITIAL_CODEX_${suffix}`) }

/** Continuation owned by the ORIGINAL controller callback, after the original
 * ensure/assignment returns. Lookup or receipt replay never calls this path.
 * Every uncertain step retains its original resources and consumes this owner;
 * it cannot create a second control, native connection or cold attempt. */
export function createInitialCodexExecutor(pool: Pool, original: InitialCodexExecutorConfiguration) {
  const selected = immutableSnapshot({ sessionId: original.sessionId, planDigest: original.planDigest, emptyFolder: original.emptyFolder })
  const deployment = original.deployment.bind(original), sink = original.sink.bind(original)
  const connect = pool.connect.bind(pool), borrowed: Pool = Object.create(pool, { connect: { value: connect } })
  let used = false, phase = 'UNUSED'
  let protection: ReturnType<typeof createInitialProviderProtection> | null = null
  let driver: DurableCodexDriver | null = null, ready: ReadyProviderBinding | null = null
  return Object.freeze({
    phase: () => phase,
    current: () => ready && driver?.ownsReadyBinding(ready) ? Object.freeze({ binding: ready, driver, protection }) : null,
    async continueAssigned(originalClaim: CommandClaim, signal: AbortSignal, originalContext: GatewayContext): Promise<void> {
      if (used) { return deny('ALREADY_USED') }
      used = true
      const context = immutableSnapshot(originalContext), claim = immutableSnapshot(originalClaim)
      function active(): void { if (signal.aborted) { deny('ABORTED') } }
      try {
        active(); phase = 'ENSURE_SETTLEMENT'
        const assigned = await settleInitialEnsureAssigned(borrowed, { context, claim, planDigest: selected.planDigest })
        if (!assigned.continuation) { return deny('ENSURE_COMMIT_UNCONFIRMED') }
        const ensured = assigned.continuation, plan = ensured.plan
        phase = 'CATALOG_SOURCE'
        const source = await runDurableTransaction(borrowed, async tx => {
          await lockAggregates(tx, { sessionIds: [selected.sessionId], runtimeUnitIds: [context.runtimeUnitId] })
          const paths = await readInitialProviderPaths(tx, context.runtimeUnitId, selected.sessionId, selected.emptyFolder)
          const rows = await tx.query<{ tab_id: string; terminal_handle: string; pod_uid: string; identity_proof_ref: string }>(
            `SELECT t.id AS tab_id,t.terminal_handle,a.pod_uid,b.identity_proof_ref
             FROM durable_runtime.runtime_members m JOIN durable_runtime.runtime_units u ON u.id=m.runtime_unit_id
             JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id JOIN durable_runtime.tabs t ON t.session_id=m.session_id
             JOIN durable_runtime.storage_bindings b ON b.id=m.storage_binding_id
             WHERE m.runtime_unit_id=$1 AND m.session_id=$2 AND t.lifecycle='OPEN' AND t.kind='terminal'
             AND a.id=$3 AND a.status='POD_ASSIGNED' AND a.incarnation IS NULL AND u.phase='PROVISIONING'
             AND b.canonical_directory=$4 AND b.access_state='RESERVED' AND b.writer_attempt_id=a.id`,
          [context.runtimeUnitId, selected.sessionId, plan.plan.identity.attemptId, paths.canonicalDirectory])
          if (rows.rowCount !== 1 || !rows.rows[0].pod_uid || !rows.rows[0].identity_proof_ref) { return deny('SOURCE_STALE') }
          return Object.freeze({ paths, ...rows.rows[0] })
        })
        if (!source.ok || source.commitOutcome !== 'ACKNOWLEDGED' || source.cleanupFailed) { return deny('SOURCE_UNCONFIRMED') }
        active(); phase = 'HELD_PROTECTION'
        const prepared = await deployment({ plan, podUid: source.value.pod_uid, paths: source.value.paths }, signal)
        protection = createInitialProviderProtection(borrowed, prepared.config)
        // The original directory identity must come from the collector/Storage
        // owner already bound to this reservation, not from a path-only tuple.
        const directoryRead = await runDurableTransaction(borrowed, async tx => {
          await lockAggregates(tx, { sessionIds: [selected.sessionId], runtimeUnitIds: [context.runtimeUnitId] })
          const accepted = captureFirstManagedBindingProfile(prepared.config.directory.acceptedProfileBytes,
            prepared.config.directory.expectedProfileDigest)
          return readOriginalFirstManagedDirectory(tx, accepted, { originalAuditId: prepared.originalAuditId,
            sessionId: selected.sessionId, context, bindingId: plan.plan.mountExpectations.protected[0].bindingId })
        })
        if (!directoryRead.ok || directoryRead.commitOutcome !== 'ACKNOWLEDGED' || directoryRead.cleanupFailed ||
            directoryRead.value.evidenceRef !== source.value.identity_proof_ref) { return deny('DIRECTORY_SOURCE_REQUIRED') }
        const owner = await protection.prepare({ plan, bindingId: plan.plan.mountExpectations.protected[0].bindingId,
          originalDirectoryReference: directoryRead.value.evidenceRef, originalDirectory: directoryRead.value.candidate,
          pinId: prepared.pinId, ownerToken: prepared.ownerToken, actorId: prepared.actorId,
          creationStartTime: prepared.creationStartTime, creationEndTime: prepared.creationEndTime }, signal)
        const lease = owner.takePreparedProtection(), control = protection.control()
        if (!control || lease.target.podUid !== source.value.pod_uid) { return deny('CONTROL_REQUIRED') }
        active(); phase = 'BIND_CLAIM'
        const bind = await prepareInitialProviderStep(borrowed, { context, sessionId: selected.sessionId,
          mutationKey: `initial-provider-bind:${randomUUID()}`, expectedUnitRevision: counter('row:runtime-unit', ensured.unitRevision),
          expectedIntentRevision: plan.plan.identity.intentRevision, expectedStepRevision: claim.identity.originalEnvelope.stepRevision,
          step: 'BIND', executorId: claim.executorId,
          input: { attemptId: lease.target.attemptId, podUid: lease.target.podUid, incarnation: lease.target.incarnation,
            workloadIdentity: { ...lease.workloadIdentity }, restoreEvidence: [], challengeResponse: lease.bindChallengeResponse },
          predecessor: ensured.receipt })
        if (bind.execution.disposition !== 'COMMITTED_EXECUTE') { return deny('BIND_CLAIM_UNCONFIRMED') }
        active(); phase = 'GRANT_COMMIT'
        const activated = await activateInitialProviderGrants(borrowed, { context, claim: bind.execution.claim,
          sessionId: selected.sessionId, expectedUnitRevision: counter('row:runtime-unit', ensured.unitRevision),
          planDigest: selected.planDigest }, owner)
        const grants = activated.database
        if (!grants.ok || grants.commitOutcome !== 'ACKNOWLEDGED' || grants.cleanupFailed) { return deny('GRANT_COMMIT_UNCONFIRMED') }
        active(); phase = 'RELEASE_GATE_CLAIM'
        const gate = await prepareInitialProviderStep(borrowed, { context, sessionId: selected.sessionId,
          mutationKey: `initial-provider-new-gate:${randomUUID()}`, expectedUnitRevision: counter('row:runtime-unit', grants.value.unitRevision),
          expectedIntentRevision: plan.plan.identity.intentRevision,
          expectedStepRevision: bind.execution.claim.identity.originalEnvelope.stepRevision,
          step: 'RELEASE_GATE', executorId: claim.executorId,
          input: { attemptId: lease.target.attemptId, coldStart: { kind: 'INITIAL_NEW', planDigest: selected.planDigest } },
          predecessor: grants.value.receipt })
        if (gate.execution.disposition !== 'COMMITTED_EXECUTE') { return deny('GATE_CLAIM_UNCONFIRMED') }
        const transport = control.transport
        driver = new DurableCodexDriver({ open: transport.open.bind(transport) }, sink)
        const binding: ProviderBinding = Object.freeze({ sessionId: selected.sessionId,
          tabId: logicalId('tab', source.value.tab_id), terminalHandle: source.value.terminal_handle,
          providerBindingRevision: counter('row:provider-binding', grants.value.providerBindingRevision),
          runtimeUnitId: context.runtimeUnitId, attemptId: lease.target.attemptId, podUid: lease.target.podUid,
          executionEpoch: lease.target.executionEpoch, connectionInstanceId: driver.connectionInstanceId })
        const launch = prepared.config.agent.policy.launch
        if (launch.cwd !== source.value.paths.checkout || launch.env.HOME !== source.value.paths.home ||
            launch.env.CODEX_HOME !== `${source.value.paths.home}/.codex` || launch.args.at(-1) !== 'app-server') { return deny('LAUNCH_MAPPING') }
        const cold: ProviderColdRequest<CodexColdLaunch> = immutableSnapshot({ mode: 'COLD', binding, native: { kind: 'NEW' },
          persistentHome: `${source.value.paths.home}/.codex`, checkout: source.value.paths.checkout,
          launch: { command: launch.command, args: launch.args.slice(0, -1), env: launch.env, options: {} } })
        const permit = createProviderEffectPermit(borrowed, context,
          { kind: 'COLD', binding, commandClaim: gate.execution.claim, coldRequest: cold }, owner,
          { provider: 'codex', home: source.value.paths.home, providerState: cold.persistentHome, request: cold,
            protectedRoots: lease.mounts.map(mount => ({ bindingId: mount.bindingId, clientRoot: mount.clientRoot })) })
        active(); phase = 'NATIVE_COLD'
        const native = await driver.cold(cold, gate.execution.claim, permit.permit)
        phase = 'READY_SETTLEMENT'
        const settled = await settleInitialProviderReady(borrowed, { context, claim: gate.execution.claim,
          planDigest: selected.planDigest }, native, driver, owner)
        if (!settled.ready) { return deny('READY_COMMIT_UNCONFIRMED') }
        ready = native; phase = 'READY'
      } catch (error) {
        phase = 'RETAINED_UNCONFIRMED'
        throw error
      }
    },
  })
}
