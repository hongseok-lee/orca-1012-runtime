import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { SessionId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, runDurableTransaction } from '../db/connection.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import type { AgentPodPlanRecord } from '../db/agent-pod-plan-record-rows.ts'
import { DurableCodexDriver } from '../providers/codex/driver.ts'
import type { CodexColdLaunch } from '../providers/codex/driver.ts'
import type { CodexProtocolDependencies } from '../providers/codex/protocol.ts'
import { ClaudeDurableProvider } from '../providers/claude/driver.ts'
import type { ClaudeColdRequest } from '../providers/claude/transport.ts'
import { agentClaudeTransport } from './agent-claude-transport.ts'
import type { ProviderBinding, ProviderColdRequest, ProviderDispatchRequest, ProviderDispatchResult,
  ProviderObservationSink, ReadyProviderBinding } from '../providers/shared/contracts.ts'
import { immutableSnapshot } from '../providers/shared/immutable-snapshot.ts'
import type { ProviderRef } from './runtime-evidence.ts'
import type { CommandClaim, ExecutorId, GatewayContext } from './gateway/types.ts'
import type { ControlledCreationWindow } from './controlled-creation-window.ts'
import { settleInitialEnsureAssigned } from './initial-provider-command-settlement.ts'
import { readInitialProviderPaths } from './initial-provider-paths.ts'
import type { InitialEmptyFolderDeclaration, InitialProviderPaths } from './initial-provider-paths.ts'
import { createInitialProviderProtection } from './initial-provider-protection.ts'
import { prepareInitialProviderStep } from './initial-provider-step.ts'
import { activateInitialProviderGrants } from './initial-provider-grants.ts'
import { createProviderEffectPermit } from './provider-effect-permit.ts'
import type { ProviderProtectionOwner } from './provider-effect-permit.ts'
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
    nativeOptions: Readonly<Record<string, string>>
  }> & ControlledCreationWindow>
  sink: ProviderObservationSink
  onNativeNotification?: CodexProtocolDependencies['onNativeNotification']
  onReady?(): void
  /** Absent means Codex. Claude runs under the same Pod-local control host. */
  provider?: 'claude'
  /** A later wake of a Session whose earlier Pod is gone: reuse its checkout and
   * HOME and resume this native session instead of starting a new one. */
  resume?: Readonly<{ nativeSessionRef: string }>
}>
const deny = (suffix: string): never => { throw new DurableDatabaseError(`INITIAL_CODEX_${suffix}`) }

/** Continuation owned by the ORIGINAL controller callback, after the original
 * ensure/assignment returns. Lookup or receipt replay never calls this path.
 * Every uncertain step retains its original resources and consumes this owner;
 * it cannot create a second control, native connection or cold attempt. */
export function createInitialCodexExecutor(pool: Pool, original: InitialCodexExecutorConfiguration) {
  const selected = immutableSnapshot({ sessionId: original.sessionId, planDigest: original.planDigest, emptyFolder: original.emptyFolder,
    resume: original.resume ?? null })
  const deployment = original.deployment.bind(original), sink = original.sink.bind(original)
  const onReady = original.onReady?.bind(original)
  const onNativeNotification = original.onNativeNotification?.bind(original)
  const connect = pool.connect.bind(pool), borrowed: Pool = Object.create(pool, { connect: { value: connect } })
  let used = false, phase = 'UNUSED', failure: string | null = null
  let writerActivated = false
  let protection: ReturnType<typeof createInitialProviderProtection> | null = null
  let readyProtection: ProviderProtectionOwner | null = null, readyContext: GatewayContext | null = null
  let readyExecutor: ExecutorId | null = null
  let driver: DurableCodexDriver | ClaudeDurableProvider | null = null, ready: ReadyProviderBinding | null = null
  const claude = original.provider === 'claude'
  function nativeStart(provider: 'codex' | 'claude') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the native session this Session's earlier READY recorded.
    return selected.resume ? { kind: 'RESUME' as const, providerRef: { provider, nativeSessionRef: selected.resume.nativeSessionRef } as ProviderRef }
      : { kind: 'NEW' as const }
  }
  async function dispatch(originalContext: GatewayContext, originalRequest: ProviderDispatchRequest,
    commitGuard?: (tx: DurableTransaction) => Promise<void>): Promise<ProviderDispatchResult> {
    const context = immutableSnapshot(originalContext), request = immutableSnapshot(originalRequest)
    const native = ready, activeDriver = driver, owner = readyProtection, controller = readyContext?.controller
    if (!native || !activeDriver || !owner || !controller || !activeDriver.ownsReadyBinding(native) ||
        context.runtimeUnitId !== native.runtimeUnitId || context.controller.scope !== controller.scope ||
        context.controller.owner !== controller.owner || context.controller.term !== controller.term) { return deny('DISPATCH_OWNER') }
    // SQL staging/operation/claim and observation belong to the input owner.
    // This seam owns only the same held physical lifetime and original driver.
    const effect = createProviderEffectPermit(borrowed, context, { kind: 'DISPATCH', binding: native,
      commandClaim: request.commandClaim, messageId: request.sealed.messageId, deliveryAttemptId: request.deliveryAttemptId,
      sealedRevision: request.sealed.sealedRevision, sealedPayloadHash: request.sealed.payloadHash,
      contextRevision: request.context.revision, contextHash: request.context.hash }, owner, undefined, commitGuard)
    return activeDriver.dispatch(request, effect.permit)
  }
  return Object.freeze({
    phase: () => phase,
    snapshot: () => Object.freeze({ phase, failure, writerGrantActivated: writerActivated,
      providerReady: ready !== null && driver !== null && driver.ownsReadyBinding(ready) }),
    current: () => ready && driver?.ownsReadyBinding(ready) && readyProtection && readyContext && readyExecutor
      ? Object.freeze({ binding: ready, driver, protection: readyProtection, context: readyContext, executorId: readyExecutor, dispatch }) : null,
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
          const paths = await readInitialProviderPaths(tx, context.runtimeUnitId, selected.sessionId, selected.emptyFolder, selected.resume !== null)
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
          ...(prepared.creationWindow === 'AUTHENTICATED_NODE' ? { creationWindow: prepared.creationWindow }
            : { creationStartTime: prepared.creationStartTime, creationEndTime: prepared.creationEndTime }) }, signal)
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
        // Keep the transaction's own fixed code for diagnosis (e.g. which guard refused).
        if (!grants.ok) { throw new DurableDatabaseError(grants.error.code) }
        if (grants.commitOutcome !== 'ACKNOWLEDGED' || grants.cleanupFailed) { return deny('GRANT_COMMIT_UNCONFIRMED') }
        writerActivated = true
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
        // A host-capable control already tagged its HELLO; its id and frame
        // sequence then name notifications identically for any later owner.
        const hosted = control.frameSequence() > 0
        const launch = prepared.config.agent.policy.launch, home = source.value.paths.home
        let native: ReadyProviderBinding
        if (claude) {
          if (!hosted) { return deny('CLAUDE_HOST_REQUIRED') }
          const sessionAt = launch.args.indexOf('--session-id'), nativeSessionId = sessionAt === -1 ? null : launch.args[sessionAt + 1]
          if ((selected.resume ? sessionAt !== -1 : !nativeSessionId) || launch.cwd !== source.value.paths.checkout || launch.env.HOME !== home ||
              launch.command !== `${home}/.orca-native/claude`) { return deny('LAUNCH_MAPPING') }
          const attach = agentClaudeTransport(control, handlers => transport.open(launch, handlers), onNativeNotification)
          const claudeDriver = new ClaudeDurableProvider((_request, handlers) => attach(handlers), sink, control.controlId)
          driver = claudeDriver
          const binding: ProviderBinding = Object.freeze({ sessionId: selected.sessionId,
            tabId: logicalId('tab', source.value.tab_id), terminalHandle: source.value.terminal_handle,
            providerBindingRevision: counter('row:provider-binding', grants.value.providerBindingRevision),
            runtimeUnitId: context.runtimeUnitId, attemptId: lease.target.attemptId, podUid: lease.target.podUid,
            executionEpoch: lease.target.executionEpoch, connectionInstanceId: claudeDriver.connectionInstanceId })
          const cold: ClaudeColdRequest = immutableSnapshot({ mode: 'COLD', binding, native: nativeStart('claude'), persistentHome: home,
            checkout: source.value.paths.checkout,
            launch: { executable: launch.command, args: launch.args, options: selected.resume ? {} : { sessionId: nativeSessionId }, env: launch.env } })
          const permit = createProviderEffectPermit(borrowed, context,
            { kind: 'COLD', binding, commandClaim: gate.execution.claim, coldRequest: cold }, owner,
            { provider: 'claude', home, providerState: `${home}/.claude`, request: cold,
              protectedRoots: lease.mounts.map(mount => ({ bindingId: mount.bindingId, clientRoot: mount.clientRoot })) })
          active(); phase = 'NATIVE_COLD'
          // The native artifact transfer runs inside this cold; bound it like the control timeout.
          native = await claudeDriver.cold(cold, gate.execution.claim, permit.permit, prepared.config.agent.timeoutMs)
        } else {
          const codexDriver = new DurableCodexDriver({ open: transport.open.bind(transport), onNativeNotification,
            ...(hosted ? { connectionId: control.controlId, frameSequence: control.frameSequence } : {}) }, sink)
          driver = codexDriver
          const binding: ProviderBinding = Object.freeze({ sessionId: selected.sessionId,
            tabId: logicalId('tab', source.value.tab_id), terminalHandle: source.value.terminal_handle,
            providerBindingRevision: counter('row:provider-binding', grants.value.providerBindingRevision),
            runtimeUnitId: context.runtimeUnitId, attemptId: lease.target.attemptId, podUid: lease.target.podUid,
            executionEpoch: lease.target.executionEpoch, connectionInstanceId: codexDriver.connectionInstanceId })
          if (launch.cwd !== source.value.paths.checkout || launch.env.HOME !== home ||
              launch.env.CODEX_HOME !== `${home}/.codex` || launch.args.at(-1) !== 'app-server') { return deny('LAUNCH_MAPPING') }
          const cold: ProviderColdRequest<CodexColdLaunch> = immutableSnapshot({ mode: 'COLD', binding, native: nativeStart('codex'),
            persistentHome: `${home}/.codex`, checkout: source.value.paths.checkout,
            launch: { command: launch.command, args: launch.args.slice(0, -1), env: launch.env, options: prepared.nativeOptions } })
          const permit = createProviderEffectPermit(borrowed, context,
            { kind: 'COLD', binding, commandClaim: gate.execution.claim, coldRequest: cold }, owner,
            { provider: 'codex', home, providerState: cold.persistentHome, request: cold,
              protectedRoots: lease.mounts.map(mount => ({ bindingId: mount.bindingId, clientRoot: mount.clientRoot })) })
          active(); phase = 'NATIVE_COLD'
          native = await codexDriver.cold(cold, gate.execution.claim, permit.permit)
        }
        phase = 'READY_SETTLEMENT'
        const settled = await settleInitialProviderReady(borrowed, { context, claim: gate.execution.claim,
          planDigest: selected.planDigest }, native, driver, owner, hosted ? Object.freeze({ provider: claude ? 'claude' as const : 'codex' as const,
          controlId: control.controlId, pid: control.controlPid, startTicks: control.startTicks,
          device: control.root.device, inode: control.root.inode, controlSha256: prepared.config.agent.bootstrapSha256 }) : undefined)
        if (!settled.ready) { return deny('READY_COMMIT_UNCONFIRMED') }
        readyProtection = owner; readyContext = context; readyExecutor = claim.executorId; ready = native; phase = 'READY'
        onReady?.()
      } catch (error) {
        // Only a fixed code is kept for diagnostics, never a message body.
        failure = `${phase}:${error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'UNCLASSIFIED'}`
        phase = 'RETAINED_UNCONFIRMED'
        throw error
      }
    },
  })
}
