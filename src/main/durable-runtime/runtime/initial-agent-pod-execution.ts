import type { Pool } from 'pg'
import { performance } from 'node:perf_hooks'
import { DurableDatabaseError, runDurableTransaction, type DurableTransactionResult } from '../db/connection.ts'
import { AgentPodCreateError, createAgentPodCreateTransport } from '../lifecycle/agent-pod-create.ts'
import type { AgentPodCreateConfig, AgentPodCreateObservation } from '../lifecycle/agent-pod-create.ts'
import type { AgentPodCreateHttps } from '../lifecycle/agent-pod-create-types.ts'
import type { StorageEvidenceAuthority } from '../storage/evidence.ts'
import type { CommandClaim, GatewayContext } from './gateway/types.ts'
import type { InitialAgentAttemptInput } from './initial-agent-attempt.ts'
import { reserveInitialAgentAttemptWithPreparedPins } from './initial-agent-attempt-transaction.ts'
import type { InitialAgentAttemptTransactionResult, PreparedInitialAgentPinsOwner } from './initial-agent-attempt-transaction.ts'
import { assignInitialAgentPod, readInitialAgentPodAssignmentTarget } from './initial-agent-pod-assignment.ts'
import { agentPodWithin } from './agent-pod-policy.ts'
import { CLOSED_AGENT_BOOTSTRAP, isClosedAgentBootstrap } from './closed-agent-bootstrap.ts'

export type InitialAgentPodExecutionStart = Readonly<{
  context: GatewayContext
  attempt: InitialAgentAttemptInput
  directoryEvidenceReferences: readonly string[]
  remainingMs: number
}>
export type InitialAgentPodExecutionLookup = Readonly<{
  context: GatewayContext; claim: CommandClaim; planDigest: string; remainingMs: number
}>
export type InitialAgentPodExecutionResult = Readonly<{
  phase: 'RESERVATION' | 'TARGET' | 'TRANSPORT' | 'ASSIGNMENT'
  reservation: InitialAgentAttemptTransactionResult | null
  target: DurableTransactionResult<Awaited<ReturnType<typeof readInitialAgentPodAssignmentTarget>>> | null
  observation: AgentPodCreateObservation | null
  assignment: DurableTransactionResult<Awaited<ReturnType<typeof assignInitialAgentPod>>> | null
  error: DurableDatabaseError | AgentPodCreateError | null
  createRequested: boolean
  gate: 'CLOSED'; providerReady: false; writerGrantActivated: false
}>

function captureCall(original: InitialAgentPodExecutionLookup) {
  const c = original.context, supplied = original.claim
  const context: GatewayContext = Object.freeze({ runtimeUnitId: c.runtimeUnitId, operationId: c.operationId,
    controller: Object.freeze({ ...c.controller }) })
  const claim: CommandClaim = Object.freeze({ visibility: supplied.visibility, commandId: supplied.commandId,
    executorId: supplied.executorId, executionToken: supplied.executionToken, controllerTerm: supplied.controllerTerm,
    identity: Object.freeze({ command: supplied.identity.command, inputHash: supplied.identity.inputHash,
      originalEnvelope: Object.freeze({ ...supplied.identity.originalEnvelope }) }) })
  const remainingMs = original.remainingMs, planDigest = original.planDigest
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0 || remainingMs > 2_147_483_647 ||
      typeof planDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(planDigest)) {
    throw new DurableDatabaseError('INITIAL_AGENT_EXECUTION_INPUT')
  }
  return Object.freeze({ context, claim, planDigest, remainingMs })
}
type CapturedCall = ReturnType<typeof captureCall>

/** Fixed idle bootstrap only. This is not the image ENTRYPOINT, native CLI or a provider launcher. */
function requireClosedBootstrap(plan: Awaited<ReturnType<typeof readInitialAgentPodAssignmentTarget>>['plan'], createRequested: boolean): void {
  const containers = plan.pod.spec.containers, container = containers[0]
  const hasCheckout = Object.hasOwn(plan.pod.metadata.annotations, CLOSED_AGENT_BOOTSTRAP.checkoutAnnotation)
  const checkout = hasCheckout ? plan.pod.metadata.annotations[CLOSED_AGENT_BOOTSTRAP.checkoutAnnotation] : container?.workingDir
  if (containers.length !== 1 || !container || !isClosedAgentBootstrap(container) || typeof checkout !== 'string' ||
      !agentPodWithin('/agent', checkout) || checkout === '/agent' ||
      plan.mountExpectations.protected.filter(binding => agentPodWithin(binding.clientPath, checkout)).length !== 1 ||
      (hasCheckout && container.workingDir !== CLOSED_AGENT_BOOTSTRAP.workingDir) || (createRequested && !hasCheckout)) {
    throw new DurableDatabaseError('INITIAL_AGENT_EXECUTION_BOOTSTRAP')
  }
}

/** Server composition only. No public DTO observation/COMMITTED boolean, SQL copy, permit issuer or live caller. */
export function createInitialAgentPodExecution(deployment: Readonly<{
  pool: Pool; podConfig: AgentPodCreateConfig; directoryAuthority: StorageEvidenceAuthority
  preparedPinsOwner: PreparedInitialAgentPinsOwner
}>, https?: AgentPodCreateHttps) {
  const pool = deployment.pool, authority = deployment.directoryAuthority, owner = deployment.preparedPinsOwner
  if (!Object.isFrozen(authority) || !Object.isFrozen(owner)) { throw new DurableDatabaseError('INITIAL_AGENT_EXECUTION_CONFIG') }
  const connect = pool.connect.bind(pool)
  const borrowed: Pool = Object.create(pool, { connect: { value: connect } })
  const transport = createAgentPodCreateTransport(deployment.podConfig, https)
  const observeOrCreate = transport.observeOrCreate.bind(transport)

  async function execute(call: CapturedCall, deadline: number, signal: AbortSignal,
    reservation: InitialAgentAttemptTransactionResult | null, allowCreate: boolean): Promise<InitialAgentPodExecutionResult> {
    let phase: InitialAgentPodExecutionResult['phase'] = 'TARGET'
    let target: InitialAgentPodExecutionResult['target'] = null, observation: AgentPodCreateObservation | null = null
    let assignment: InitialAgentPodExecutionResult['assignment'] = null, createRequested = false
    const result = (error: InitialAgentPodExecutionResult['error'] = null): InitialAgentPodExecutionResult => Object.freeze({
      phase, reservation, target, observation, assignment, error, createRequested,
      gate: 'CLOSED', providerReady: false, writerGrantActivated: false })
    function remaining(): number {
      if (signal.aborted) { throw new AgentPodCreateError('ABORTED') }
      const budget = Math.floor(deadline - performance.now())
      if (budget <= 0) { throw new AgentPodCreateError('TIMEOUT') }
      return budget
    }
    try {
      remaining()
      // Shared DB validation owns the original command/reservation/plan locks.
      // Its actual transaction must settle and release before any HTTPS call.
      target = await runDurableTransaction(borrowed, tx => readInitialAgentPodAssignmentTarget(tx, call.context,
        { claim: call.claim, planDigest: call.planDigest }))
      if (!target.ok || target.settlement !== 'COMMITTED' || target.commitOutcome !== 'ACKNOWLEDGED' || target.cleanupFailed) { return result() }
      // An already assigned target cannot become a new CREATE after a concurrent assignment.
      const requestCreate = allowCreate && target.value.status === 'RESERVED' && target.value.podUid === null
      requireClosedBootstrap(target.value.plan, requestCreate)
      const budget = remaining()
      createRequested = requestCreate
      phase = 'TRANSPORT'
      observation = await observeOrCreate({ record: target.value.record,
        mode: createRequested ? 'CREATE_ONCE' : 'LOOKUP_ONLY', remainingMs: budget }, signal)
      if (observation.disposition !== 'FOUND' && observation.disposition !== 'CREATED') { return result() }
      remaining()
      phase = 'ASSIGNMENT'
      const capturedObservation = observation
      assignment = await runDurableTransaction(borrowed, tx => assignInitialAgentPod(tx, call.context,
        { claim: call.claim, planDigest: call.planDigest, observation: capturedObservation }))
      // Keep transaction-local result and actual COMMIT/cleanup facts separate from Pod API observation.
      return result()
    } catch (error) {
      return result(error instanceof DurableDatabaseError || error instanceof AgentPodCreateError ? error :
        new DurableDatabaseError('INITIAL_AGENT_EXECUTION_FAILED'))
    }
  }

  return Object.freeze({
    async start(original: InitialAgentPodExecutionStart, signal: AbortSignal): Promise<InitialAgentPodExecutionResult> {
      const started = performance.now(), supplied = original.attempt
      const call = captureCall({ context: original.context, claim: supplied.claim, planDigest: supplied.planDigest, remainingMs: original.remainingMs })
      const input: InitialAgentAttemptInput = Object.freeze({ claim: call.claim, planDigest: call.planDigest,
        expectedUnitRevision: supplied.expectedUnitRevision,
        bindings: Object.freeze(supplied.bindings.map(b => Object.freeze({ bindingId: b.bindingId,
          expectedRevision: b.expectedRevision, storageEpoch: b.storageEpoch }))) })
      const references = Object.freeze(original.directoryEvidenceReferences.map(reference => {
        if (typeof reference !== 'string' || !reference || Array.from(reference).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
          throw new DurableDatabaseError('INITIAL_AGENT_EXECUTION_REFERENCE')
        }
        return reference
      }))
      const deadline = started + call.remainingMs
      const stopped = (reservation: InitialAgentAttemptTransactionResult | null,
        error: InitialAgentPodExecutionResult['error'] = null): InitialAgentPodExecutionResult => Object.freeze({
        phase: 'RESERVATION', reservation, target: null, observation: null, assignment: null, error, createRequested: false,
        gate: 'CLOSED', providerReady: false, writerGrantActivated: false })
      if (signal.aborted) { return stopped(null, new AgentPodCreateError('ABORTED')) }
      if (performance.now() >= deadline) { return stopped(null, new AgentPodCreateError('TIMEOUT')) }
      let reservation: InitialAgentAttemptTransactionResult
      try { reservation = await reserveInitialAgentAttemptWithPreparedPins(borrowed, call.context, input, authority, references, owner) }
      catch (error) { return stopped(null, error instanceof DurableDatabaseError ? error : new DurableDatabaseError('INITIAL_AGENT_RESERVATION_FAILED')) }
      const database = reservation.database
      if (reservation.engineError || reservation.pins.disposition !== 'RELEASED' || !database || !database.ok ||
          database.settlement !== 'COMMITTED' || database.commitOutcome !== 'ACKNOWLEDGED' || database.cleanupFailed ||
          database.value.disposition !== 'RESERVED') { return stopped(reservation) }
      return execute(call, deadline, signal, reservation, true)
    },
    async lookup(original: InitialAgentPodExecutionLookup, signal: AbortSignal): Promise<InitialAgentPodExecutionResult> {
      const started = performance.now(), call = captureCall(original)
      return execute(call, started + call.remainingMs, signal, null, false)
    },
  })
}
