import type { Pool } from 'pg'
import { performance } from 'node:perf_hooks'
import { DurableDatabaseError, runDurableTransaction, type DurableTransactionResult } from '../db/connection.ts'
import { AgentPodCreateError, createAgentPodCreateTransport } from '../lifecycle/agent-pod-create.ts'
import type { AgentPodCreateConfig, AgentPodCreateObservation } from '../lifecycle/agent-pod-create.ts'
import type { AgentPodCreateHttps } from '../lifecycle/agent-pod-create-types.ts'
import type { StorageEvidenceAuthority } from '../storage/evidence.ts'
import type { CommandClaim, CommandId, GatewayContext } from './gateway/types.ts'
import type { InitialAgentAttemptInput } from './initial-agent-attempt.ts'
import { reserveInitialAgentAttemptWithPreparedPins } from './initial-agent-attempt-transaction.ts'
import type { InitialAgentAttemptTransactionResult, PreparedInitialAgentPinsOwner } from './initial-agent-attempt-transaction.ts'
import { assignInitialAgentPod, assignInitialAgentPodLookup, readInitialAgentPodAssignmentTarget,
  readInitialAgentPodLookupTarget } from './initial-agent-pod-assignment.ts'
import { agentPodWithin } from './agent-pod-policy.ts'
import { CLOSED_AGENT_BOOTSTRAP, isClosedAgentBootstrap } from './closed-agent-bootstrap.ts'
import { createFirstManagedInitialReservationOwner } from '../storage/first-managed-initial-owner.ts'
import type { FirstManagedInitialInput, FirstManagedInitialResult } from '../storage/first-managed-initial-owner.ts'
import type { FirstManagedBindingOwnerConfig } from '../storage/first-managed-observation-source.ts'
import type { ManagedLeafCollectorDependencies } from '../storage/managed-leaf-collector-types.ts'

export type InitialAgentPodExecutionStart = Readonly<{
  context: GatewayContext
  attempt: InitialAgentAttemptInput
  directoryEvidenceReferences: readonly string[]
  remainingMs: number
}>
export type InitialAgentPodExecutionLookup = Readonly<{
  context: GatewayContext; claim: CommandClaim; planDigest: string; remainingMs: number
}>
export type InitialAgentPodLookupInput = Readonly<{
  context: GatewayContext; commandId: CommandId; planDigest: string; remainingMs: number
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

function captureOriginalLookup(original: InitialAgentPodLookupInput) {
  const c = original.context
  const context: GatewayContext = Object.freeze({ runtimeUnitId: c.runtimeUnitId, operationId: c.operationId,
    controller: Object.freeze({ ...c.controller }) })
  const commandId = original.commandId, remainingMs = original.remainingMs, planDigest = original.planDigest
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0 || remainingMs > 2_147_483_647 ||
      typeof planDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(planDigest)) {
    throw new DurableDatabaseError('INITIAL_AGENT_EXECUTION_INPUT')
  }
  return Object.freeze({ context, commandId, planDigest, remainingMs })
}
type CapturedOriginalLookup = ReturnType<typeof captureOriginalLookup>

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

/** Private execution sharing only; the original-command factory never supplies a claim or allows CREATE. */
async function executeAgentPodCall(borrowed: Pool,
  observeOrCreate: ReturnType<typeof createAgentPodCreateTransport>['observeOrCreate'],
  call: CapturedCall | CapturedOriginalLookup, deadline: number, signal: AbortSignal,
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
    target = await runDurableTransaction(borrowed, tx => 'claim' in call ?
      readInitialAgentPodAssignmentTarget(tx, call.context, { claim: call.claim, planDigest: call.planDigest }) :
      readInitialAgentPodLookupTarget(tx, call.context, { commandId: call.commandId, planDigest: call.planDigest }))
    if (!target.ok || target.settlement !== 'COMMITTED' || target.commitOutcome !== 'ACKNOWLEDGED' || target.cleanupFailed) { return result() }
    // An already assigned target cannot become a new CREATE after a concurrent assignment.
    const requestCreate = 'claim' in call && allowCreate && target.value.status === 'RESERVED' && target.value.podUid === null
    requireClosedBootstrap(target.value.plan, requestCreate)
    const budget = remaining()
    createRequested = requestCreate
    phase = 'TRANSPORT'
    observation = await observeOrCreate({ record: target.value.record,
      mode: createRequested ? 'CREATE_ONCE' : 'LOOKUP_ONLY', remainingMs: budget }, signal)
    if (observation.disposition !== 'FOUND' && (!('claim' in call) || observation.disposition !== 'CREATED')) { return result() }
    remaining()
    phase = 'ASSIGNMENT'
    const capturedObservation = observation
    assignment = await runDurableTransaction(borrowed, tx => 'claim' in call ?
      assignInitialAgentPod(tx, call.context, { claim: call.claim, planDigest: call.planDigest, observation: capturedObservation }) :
      assignInitialAgentPodLookup(tx, call.context, { commandId: call.commandId, planDigest: call.planDigest, observation: capturedObservation }))
    // Keep transaction-local result and actual COMMIT/cleanup facts separate from Pod API observation.
    return result()
  } catch (error) {
    return result(error instanceof DurableDatabaseError || error instanceof AgentPodCreateError ? error :
      new DurableDatabaseError('INITIAL_AGENT_EXECUTION_FAILED'))
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
      return executeAgentPodCall(borrowed, observeOrCreate, call, deadline, signal, reservation, true)
    },
    async lookup(original: InitialAgentPodExecutionLookup, signal: AbortSignal): Promise<InitialAgentPodExecutionResult> {
      const started = performance.now(), call = captureCall(original)
      return executeAgentPodCall(borrowed, observeOrCreate, call, started + call.remainingMs, signal, null, false)
    },
  })
}

/** Original command lookup under current controller authority; no prepared pins or CREATE authority. */
export function createInitialAgentPodLookup(deployment: Readonly<{
  pool: Pool; podConfig: AgentPodCreateConfig
}>, https?: AgentPodCreateHttps) {
  const pool = deployment.pool, connect = pool.connect.bind(pool)
  const borrowed: Pool = Object.create(pool, { connect: { value: connect } })
  const transport = createAgentPodCreateTransport(deployment.podConfig, https)
  const observeOrCreate = transport.observeOrCreate.bind(transport)
  return Object.freeze({
    async lookup(original: InitialAgentPodLookupInput, signal: AbortSignal): Promise<InitialAgentPodExecutionResult> {
      const started = performance.now(), call = captureOriginalLookup(original)
      return executeAgentPodCall(borrowed, observeOrCreate, call, started + call.remainingMs, signal, null, false)
    },
  })
}

export type FirstManagedInitialAgentPodStart = FirstManagedInitialInput & Readonly<{ remainingMs: number }>
export type FirstManagedInitialAgentPodExecutionResult = Readonly<{
  preparation: FirstManagedInitialResult
  execution: InitialAgentPodExecutionResult | null
  gate: 'CLOSED'; providerReady: false; writerGrantActivated: false
}>

/** A private conversion of the owned owner's actual fully-released result only.
 * No retained handles, success callback or caller-supplied authority crosses it. */
function releasedFirstManagedReservation(preparation: FirstManagedInitialResult): InitialAgentAttemptTransactionResult | null {
  const reserved = preparation.reservation, database = reserved?.database
  const released = preparation.release
  if (preparation.phase !== 'RESERVATION' || preparation.outcome !== 'RESERVED' ||
      preparation.pin.state !== 'RELEASED' || !preparation.pin.handedOff || !reserved || reserved.engineError ||
      reserved.pins.disposition !== 'RELEASED' || reserved.pins.releaseError !== null ||
      !database || !database.ok || database.settlement !== 'COMMITTED' || database.commitOutcome !== 'ACKNOWLEDGED' ||
      database.cleanupFailed || database.value.disposition !== 'RESERVED' ||
      !released || !released.database.ok || released.database.settlement !== 'COMMITTED' ||
      released.database.commitOutcome !== 'ACKNOWLEDGED' || released.database.cleanupFailed ||
      (released.disposition?.status !== 'RELEASED' && released.disposition?.status !== 'ALREADY_RELEASED')) { return null }
  return Object.freeze({ database, engineError: reserved.engineError,
    pins: Object.freeze({ disposition: 'RELEASED', releaseError: null, retainedOwner: null, retainedLease: null }),
    kubernetesExecutionAuthorized: false, physicalPinIssuerImplemented: false })
}

/** Dedicated server composition: fresh managed revalidation/reservation before
 * closed bootstrap. It neither opens the gate nor qualifies later mount lifetime. */
export function createFirstManagedInitialAgentPodExecution(deployment: Readonly<{
  pool: Pool; podConfig: AgentPodCreateConfig; firstManagedDirectory: FirstManagedBindingOwnerConfig
}>, https?: AgentPodCreateHttps, collectorDependencies?: ManagedLeafCollectorDependencies) {
  const pool = deployment.pool, connect = pool.connect.bind(pool)
  const borrowed: Pool = Object.create(pool, { connect: { value: connect, configurable: true } })
  const transport = createAgentPodCreateTransport(deployment.podConfig, https)
  const observeOrCreate = transport.observeOrCreate.bind(transport)
  const owner = createFirstManagedInitialReservationOwner(borrowed, deployment.firstManagedDirectory, collectorDependencies)
  const reserve = owner.reserveInitialAttempt.bind(owner)
  return Object.freeze({
    async start(original: FirstManagedInitialAgentPodStart, signal: AbortSignal): Promise<FirstManagedInitialAgentPodExecutionResult> {
      const started = performance.now()
      let call: CapturedCall, input: FirstManagedInitialInput
      try {
        const supplied = original.attempt
        call = captureCall({ context: original.context, claim: supplied.claim,
          planDigest: supplied.planDigest, remainingMs: original.remainingMs })
        input = Object.freeze({ sessionId: original.sessionId, actorId: original.actorId,
          originalAuditId: original.originalAuditId, pinId: original.pinId, ownerToken: original.ownerToken,
          context: call.context, attempt: Object.freeze({ claim: call.claim, planDigest: call.planDigest,
            expectedUnitRevision: supplied.expectedUnitRevision,
            bindings: Object.freeze(supplied.bindings.map(b => Object.freeze({ bindingId: b.bindingId,
              expectedRevision: b.expectedRevision, storageEpoch: b.storageEpoch }))) }) })
      } catch { throw new DurableDatabaseError('INITIAL_AGENT_EXECUTION_INPUT') }
      const deadline = started + call.remainingMs, controller = new AbortController()
      const abort = () => controller.abort(), addAbort = signal.addEventListener.bind(signal), removeAbort = signal.removeEventListener.bind(signal)
      if (signal.aborted) { throw new AgentPodCreateError('ABORTED') }
      if (performance.now() >= deadline) { throw new AgentPodCreateError('TIMEOUT') }
      const timer = setTimeout(abort, Math.max(0, deadline - performance.now()))
      addAbort('abort', abort, { once: true })
      if (signal.aborted) { controller.abort() }
      try {
        let preparation: FirstManagedInitialResult
        try { preparation = await reserve(input, controller.signal) }
        catch { throw new DurableDatabaseError('INITIAL_AGENT_RESERVATION_FAILED') }
        const reservation = releasedFirstManagedReservation(preparation)
        const execution = reservation ? await executeAgentPodCall(borrowed, observeOrCreate, call,
          deadline, controller.signal, reservation, true) : null
        return Object.freeze({ preparation, execution, gate: 'CLOSED', providerReady: false, writerGrantActivated: false })
      } finally {
        clearTimeout(timer); removeAbort('abort', abort); controller.abort()
      }
    },
  })
}
