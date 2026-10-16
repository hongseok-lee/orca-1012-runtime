import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, runDurableTransaction, safeDatabaseError } from '../db/connection.ts'
import type { DurableTransactionResult } from '../db/connection.ts'
import type { ControllerPassRequest } from '../ha/pass.ts'
import { snapshotGatewayContext } from '../lifecycle/reconcile-request.ts'
import type { AgentPodCreateConfig } from '../lifecycle/agent-pod-create.ts'
import type { AgentPodCreateHttps } from '../lifecycle/agent-pod-create-types.ts'
import type { FirstManagedBindingOwnerConfig } from '../storage/first-managed-binding-owner.ts'
import type { FirstManagedInitialResult } from '../storage/first-managed-initial-owner.ts'
import type { ManagedLeafCollectorDependencies } from '../storage/managed-leaf-collector-types.ts'
import { createAgentPodPlanner, type TrustedAgentPodRequest } from './agent-pod-plan.ts'
import { prepareAgentPodPlan, recordAgentPodPlan } from './agent-pod-plan-records.ts'
import { agentPodInteger, agentPodText, agentPodUuid } from './agent-pod-policy.ts'
import { CLOSED_AGENT_BOOTSTRAP, isClosedAgentBootstrap } from './closed-agent-bootstrap.ts'
import { inputDigest } from './gateway/input.ts'
import type { CommandClaim, ExecutorId, GatewayContext } from './gateway/types.ts'
import { createFirstManagedInitialAgentPodExecution, createInitialAgentPodLookup } from './initial-agent-pod-execution.ts'
import type { InitialAgentPodExecutionResult } from './initial-agent-pod-execution.ts'
import { recordInitialAgentResourceProfile } from './initial-agent-resource-profile.ts'

export type FirstManagedInitialDispatchConfig = Readonly<{
  pool: Pool; policy: unknown; request: TrustedAgentPodRequest; policyRevision: string
  sessionId: string; actorId: string; originalAuditId: string; pinId: string
  binding: Readonly<{ bindingId: string; expectedRevision: string; storageEpoch: string }>
  executorId: ExecutorId; externalBudgetMs: number
  readOwnerToken(pinId: string, signal: AbortSignal): Promise<string>
  podConfig: AgentPodCreateConfig; firstManagedDirectory: FirstManagedBindingOwnerConfig
}>
type TransactionSnapshot = Readonly<{
  settlement: string; commitOutcome: string; cleanupFailed: boolean; disposition: string | null; errorCode: string | null
}>
export type FirstManagedInitialDispatchSnapshot = Readonly<{
  phase: 'IDLE' | 'PLAN' | 'PROFILE' | 'EXECUTION' | 'LOOKUP'
  status: 'IDLE' | 'PENDING' | 'FINISHED' | 'FAILED'
  planDigest: string; commandId: string | null; errorCode: string | null
  plan: TransactionSnapshot | null; profile: TransactionSnapshot | null
  preparationPhase: FirstManagedInitialResult['phase'] | null
  preparationOutcome: FirstManagedInitialResult['outcome'] | null
  preparationErrorCode: string | null; pinState: FirstManagedInitialResult['pin']['state'] | null
  executionPhase: InitialAgentPodExecutionResult['phase'] | null
  executionErrorCode: string | null
  target: TransactionSnapshot | null; assignment: TransactionSnapshot | null
  observationDisposition: string | null; createRequested: boolean
  gate: 'CLOSED'; providerReady: false; writerGrantActivated: false
}>
type Callbacks = Required<Pick<ControllerPassRequest, 'planStep' | 'executeCommitted' | 'lookupOriginal'>>

function deny(suffix: string): never { throw new DurableDatabaseError(`FIRST_MANAGED_DISPATCH_${suffix}`) }
function confirmed<T>(result: DurableTransactionResult<T>): result is Extract<DurableTransactionResult<T>, { ok: true }> {
  return result.ok && result.settlement === 'COMMITTED' && result.commitOutcome === 'ACKNOWLEDGED' && !result.cleanupFailed
}
function transactionSnapshot<T>(result: DurableTransactionResult<T> | null, disposition: string | null = null): TransactionSnapshot | null {
  return result === null ? null : Object.freeze({ settlement: result.settlement,
    commitOutcome: result.commitOutcome, cleanupFailed: result.cleanupFailed, disposition,
    errorCode: result.ok ? null : result.error.code })
}
function captureClaim(claim: CommandClaim): CommandClaim {
  return Object.freeze({ visibility: claim.visibility, commandId: claim.commandId, executorId: claim.executorId,
    executionToken: claim.executionToken, controllerTerm: claim.controllerTerm,
    identity: Object.freeze({ command: claim.identity.command, inputHash: claim.identity.inputHash,
      originalEnvelope: Object.freeze({ ...claim.identity.originalEnvelope }) }) })
}

/** Internal callbacks for one fixed deployment target. No pass, lease or startup is activated here. */
export function createFirstManagedInitialDispatch(original: FirstManagedInitialDispatchConfig,
  https?: AgentPodCreateHttps, collectorDependencies?: ManagedLeafCollectorDependencies): Readonly<Callbacks & {
    snapshot(): FirstManagedInitialDispatchSnapshot
  }> {
  const prepared = prepareAgentPodPlan(createAgentPodPlanner(original.policy).plan(original.request))
  const { plan, planDigest } = prepared, id = plan.identity, container = plan.pod.spec.containers[0]
  if (!isClosedAgentBootstrap(container) || container.workingDir !== CLOSED_AGENT_BOOTSTRAP.workingDir ||
      !Object.hasOwn(plan.pod.metadata.annotations, CLOSED_AGENT_BOOTSTRAP.checkoutAnnotation) ||
      plan.mountExpectations.protected.length !== 1) { return deny('CLOSED_PLAN') }
  const binding = Object.freeze({ bindingId: logicalId('storage-binding', agentPodUuid(original.binding.bindingId)),
    expectedRevision: counter('row:storage-binding', original.binding.expectedRevision),
    storageEpoch: counter('storage-epoch', original.binding.storageEpoch) })
  if (binding.bindingId !== plan.mountExpectations.protected[0].bindingId) { return deny('BINDING') }
  const sessionId = logicalId('session', agentPodUuid(original.sessionId)), actorId = agentPodText(original.actorId)
  const originalAuditId = logicalId('event', agentPodUuid(original.originalAuditId))
  const pinId = logicalId('storage-namespace-pin', agentPodUuid(original.pinId))
  const policyRevision = counter('policy-revision', original.policyRevision), executorId = original.executorId
  agentPodText(executorId)
  const budget = agentPodInteger(original.externalBudgetMs)
  if (budget > 2_147_483_647) { return deny('BUDGET') }
  const readOwnerToken = original.readOwnerToken.bind(original)
  const pool = original.pool, connect = pool.connect.bind(pool)
  const borrowed: Pool = Object.create(pool, { connect: { value: connect } })
  const execution = createFirstManagedInitialAgentPodExecution({ pool: borrowed, podConfig: original.podConfig,
    firstManagedDirectory: original.firstManagedDirectory }, https, collectorDependencies)
  const start = execution.start.bind(execution)
  const lookupOwner = createInitialAgentPodLookup({ pool: borrowed, podConfig: original.podConfig }, https)
  const lookup = lookupOwner.lookup.bind(lookupOwner)
  const body = Object.freeze({ mode: 'COLD', planDigest, attemptId: id.attemptId,
    resourceProfileRevision: plan.pod.metadata.annotations['orca.dev/resource-profile-revision'] })
  const expectedInputHash = inputDigest({ resourceName: id.resourceName, body })
  let state: FirstManagedInitialDispatchSnapshot = Object.freeze({ phase: 'IDLE', status: 'IDLE', planDigest,
    commandId: null, errorCode: null, plan: null, profile: null, preparationPhase: null, preparationOutcome: null,
    preparationErrorCode: null, pinState: null, executionPhase: null, executionErrorCode: null, target: null, assignment: null,
    observationDisposition: null, createRequested: false, gate: 'CLOSED', providerReady: false, writerGrantActivated: false })
  let inFlight = false

  function begin(phase: 'PLAN' | 'LOOKUP', commandId: string): void {
    if (inFlight) { return deny('IN_FLIGHT') }
    inFlight = true
    state = Object.freeze({ ...state, phase, status: 'PENDING', commandId, errorCode: null,
      plan: null, profile: null, preparationPhase: null, preparationOutcome: null, preparationErrorCode: null,
      pinState: null, executionPhase: null, executionErrorCode: null, target: null, assignment: null, observationDisposition: null, createRequested: false })
  }
  function remaining(deadline: number, signal: AbortSignal): number {
    if (signal.aborted) { return deny('ABORTED') }
    const ms = Math.floor(deadline - performance.now())
    if (ms <= 0) { return deny('BUDGET') }
    return ms
  }
  function requireContext(context: GatewayContext): void {
    if (context.operationId !== id.operationId || context.runtimeUnitId !== id.unitId) { return deny('TARGET') }
  }
  function observeExecution(result: InitialAgentPodExecutionResult): void {
    state = Object.freeze({ ...state, executionPhase: result.phase, createRequested: result.createRequested,
      executionErrorCode: result.error?.code ?? null,
      target: transactionSnapshot(result.target, result.target?.ok ? result.target.value.status : null),
      assignment: transactionSnapshot(result.assignment, result.assignment?.ok ? result.assignment.value.disposition : null),
      observationDisposition: result.observation?.disposition ?? null })
    if (result.error) { throw result.error }
    if (!result.target || !confirmed(result.target) || !result.assignment || !confirmed(result.assignment)) {
      return deny('EXECUTION_NOT_CONFIRMED')
    }
  }
  function failed(error: unknown): never {
    const safe = safeDatabaseError(error)
    state = Object.freeze({ ...state, status: 'FAILED', errorCode: safe.code })
    throw safe
  }

  const callbacks: Callbacks = {
    planStep(operation, unit) {
      if (operation.id !== id.operationId || operation.runtime_unit_id !== id.unitId || unit.id !== id.unitId ||
          operation.kind !== 'WAKE' || operation.external_resource_name !== id.resourceName ||
          operation.execution_epoch !== id.executionEpoch || operation.intent_revision !== id.intentRevision) { return null }
      // Fresh reconciliation key prevents receipt replay from suppressing original-command lookup.
      return Object.freeze({ mutationKey: `first-managed-initial:${id.operationId}:${unit.revision}:${operation.step_revision}:${randomUUID()}`,
        step: 'ENSURE_ATTEMPT', executorId, input: body })
    },
    async executeCommitted(originalClaim, signal, originalContext) {
      const deadline = performance.now() + budget
      const context = snapshotGatewayContext(originalContext), claim = captureClaim(originalClaim)
      begin('PLAN', claim.commandId)
      try {
        requireContext(context)
        const envelope = claim.identity.originalEnvelope
        if (claim.visibility !== 'TRANSACTION_LOCAL' || claim.identity.command !== 'ensureAttempt' ||
            claim.executorId !== executorId || claim.controllerTerm !== context.controller.term ||
            envelope.operationId !== id.operationId || envelope.executionEpoch !== id.executionEpoch ||
            envelope.intentRevision !== id.intentRevision || envelope.podTarget !== 'CREATE_WITHOUT_POD' ||
            envelope.expectedPodUid !== null || claim.identity.inputHash !== expectedInputHash) { return deny('CLAIM') }
        remaining(deadline, signal)
        const recorded = await runDurableTransaction(borrowed, tx => recordAgentPodPlan(tx, context, plan))
        state = Object.freeze({ ...state, plan: transactionSnapshot(recorded, recorded.ok ? recorded.value.disposition : null) })
        if (!confirmed(recorded)) { return deny('PLAN_NOT_CONFIRMED') }
        remaining(deadline, signal)
        state = Object.freeze({ ...state, phase: 'PROFILE' })
        const profile = await runDurableTransaction(borrowed, tx => recordInitialAgentResourceProfile(tx, context,
          { planDigest, policyRevision }))
        state = Object.freeze({ ...state, profile: transactionSnapshot(profile, profile.ok ? profile.value.disposition : null) })
        if (!confirmed(profile)) { return deny('PROFILE_NOT_CONFIRMED') }
        const expectedUnitRevision = counter('row:runtime-unit', profile.value.currentUnitRevision)
        remaining(deadline, signal)
        const ownerToken = await readOwnerToken(pinId, signal)
        const remainingMs = remaining(deadline, signal)
        state = Object.freeze({ ...state, phase: 'EXECUTION' })
        const result = await start({ context, sessionId, actorId, originalAuditId, pinId, ownerToken,
          attempt: Object.freeze({ claim, planDigest, expectedUnitRevision, bindings: Object.freeze([binding]) }), remainingMs }, signal)
        const preparation = result.preparation
        state = Object.freeze({ ...state, preparationPhase: preparation?.phase ?? null,
          preparationOutcome: preparation?.outcome ?? null, preparationErrorCode: preparation?.errorCode ?? null,
          pinState: preparation?.pin.state ?? null })
        if (!preparation || preparation.outcome !== 'RESERVED' || !result.execution) { return deny('PREPARATION_NOT_RESERVED') }
        observeExecution(result.execution)
        remaining(deadline, signal)
        state = Object.freeze({ ...state, status: 'FINISHED' })
      } catch (error) { failed(error) }
      finally { inFlight = false }
    },
    async lookupOriginal(command, signal, originalContext) {
      const deadline = performance.now() + budget, context = snapshotGatewayContext(originalContext)
      const commandId = logicalId('runtime-command', command.id)
      const selected = Object.freeze({ operationId: command.operation_id, unitId: command.runtime_unit_id,
        name: command.command_name, inputHash: command.input_hash, executionEpoch: command.execution_epoch,
        intentRevision: command.intent_revision })
      begin('LOOKUP', commandId)
      try {
        requireContext(context)
        if (selected.operationId !== id.operationId || selected.unitId !== id.unitId || selected.name !== 'ensureAttempt' ||
            selected.inputHash !== expectedInputHash || selected.executionEpoch !== id.executionEpoch ||
            selected.intentRevision !== id.intentRevision) { return deny('ORIGINAL_COMMAND') }
        const result = await lookup({ context, commandId, planDigest, remainingMs: remaining(deadline, signal) }, signal)
        observeExecution(result)
        remaining(deadline, signal)
        state = Object.freeze({ ...state, status: 'FINISHED' })
      } catch (error) { failed(error) }
      finally { inFlight = false }
    },
  }
  return Object.freeze({ ...callbacks, snapshot: () => state })
}
