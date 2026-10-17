import type { Pool } from 'pg'
import { runDurableTransaction, safeDatabaseError } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { ownedInputJson } from './stage-binding.ts'
import { InputStoreError } from './types.ts'
import { immutableSnapshot } from '../providers/shared/recovery-renderer.ts'
import type { ProviderObservation, ProviderDispatchRequest } from '../providers/shared/contracts.ts'
import type { InputDeliveryObservation } from './observation-types.ts'
import { observeInputDeliveryInTransaction } from './observe.ts'
import { recordContextDeliveryInTransaction } from '../context/delivery.ts'
import { LockedGatewayAuthority } from '../runtime/gateway/authority.ts'
import { lookupCommand } from '../runtime/gateway/store.ts'
import { settleOwnedExecution, markCommandUnknown } from '../runtime/gateway/claim.ts'
import { assertTerminalExecutionOrigin, committedInputTarget, stageTerminalRuntimeInput, claimTerminalRuntimeInput } from './runtime-input-store.ts'
import type { CommittedTerminalInput, ReadyTerminalInputPort, TerminalInputRuntimeHost } from './runtime-input-types.ts'

type Submission = {input: CommittedTerminalInput; port: ReadyTerminalInputPort;
  staged: Extract<Awaited<ReturnType<typeof stageTerminalRuntimeInput>>, {disposition: 'STAGED'}>;
  request: ProviderDispatchRequest}
type RuntimeNotice = Readonly<{phase: 'QUEUED' | 'STAGED' | 'CLAIMED' | 'OBSERVED' | 'RETAINED'; code?: string}>

/** The only intake producer is the real authenticated RPC owner. SQL never
 * reconstructs authority from stored principals. This bounded first integration
 * retains unresolved original operations; it does not automatically resend. */
export function createTerminalInputRuntime(poolOwner: Pool, host: TerminalInputRuntimeHost,
  onNotice: (notice: RuntimeNotice) => void = () => undefined) {
  const connect = poolOwner.connect.bind(poolOwner), query = poolOwner.query.bind(poolOwner)
  const pool = new Proxy(poolOwner, {get(target, key) {
    if (key === 'connect') { return connect }
    if (key === 'query') { return query }
    return Reflect.get(target, key, target)
  }})
  const current = host.current.bind(host), notify = onNotice
  const waiting = new Map<string, CommittedTerminalInput>(), seen = new Set<string>()
  const submissions = new Map<string, Submission>()
  let tail = Promise.resolve(), closed = false
  const notice = (phase: RuntimeNotice['phase'], code?: string): void => {
    try { notify(Object.freeze({phase, ...(code ? {code} : {})})) } catch { /* Telemetry cannot change a durable outcome. */ }
  }
  const enqueue = (work: () => Promise<void>): void => {
    tail = tail.then(work).catch(error => { notice('RETAINED', safeDatabaseError(error).code) })
  }
  const assertReady = (port: ReadyTerminalInputPort): void => {
    const actual = current()
    if (closed || !actual || actual.binding !== port.binding || actual.context.controller !== port.context.controller ||
        actual.executorId !== port.executorId) { throw new InputStoreError('TERMINAL_RUNTIME_OWNER_CHANGED') }
  }
  const execute = async (input: CommittedTerminalInput, port: ReadyTerminalInputPort): Promise<void> => {
    assertReady(port); input.assertCurrent()
    const stagedOutcome = await runDurableTransaction(pool, tx => stageTerminalRuntimeInput(tx, input, port))
    if (!stagedOutcome.ok) { throw stagedOutcome.error }
    const staged = stagedOutcome.value
    if (staged.disposition !== 'STAGED') { notice('RETAINED', 'TERMINAL_RUNTIME_LOOKUP_ONLY'); return }
    notice('STAGED')
    assertReady(port); input.assertCurrent()
    const claimed = await runDurableTransaction(pool, tx => claimTerminalRuntimeInput(tx, input, port, staged))
    if (!claimed.ok) { throw claimed.error }
    const request = claimed.value
    if (!request) { notice('RETAINED', 'TERMINAL_RUNTIME_NOT_CLAIMABLE'); return }
    notice('CLAIMED')
    // Register before native I/O because admission can arrive within dispatch.
    submissions.set(request.deliveryAttemptId, {input, port, staged, request})
    assertReady(port); input.assertCurrent()
    const result = await port.dispatch(staged.context, request, async tx => {
      assertReady(port)
      await assertTerminalExecutionOrigin(tx, input)
      assertReady(port); input.assertCurrent()
    })
    if (result.state === 'UNSUPPORTED') { notice('RETAINED', 'TERMINAL_RUNTIME_PROVIDER_UNSUPPORTED') }
    // Only the original driver sink proves ADMITTED/COMPLETED/UNKNOWN. A return
    // value or dispatch exception never synthesizes an observation or retry.
  }
  const pump = (): void => {
    if (closed) { return }
    const port = current()
    if (!port) { return }
    for (const [key, input] of waiting) {
      if (input.authority.sessionId !== port.binding.sessionId) { continue }
      waiting.delete(key)
      enqueue(() => execute(input, port))
    }
  }
  const committed = (original: CommittedTerminalInput): void => {
    if (closed) { throw new InputStoreError('TERMINAL_RUNTIME_CLOSED') }
    const check = original.assertCurrent.bind(original)
    check()
    const input: CommittedTerminalInput = Object.freeze({authority: Object.freeze({...original.authority,
      scope: Object.freeze({...original.authority.scope})}), binding: Object.freeze({...original.binding}),
      targetPin: Object.freeze({...original.targetPin, payload: ownedInputJson(original.targetPin.payload)}),
      receipt: Object.freeze({...original.receipt, key: Object.freeze({...original.receipt.key}),
        response: ownedInputJson(original.receipt.response)}), assertCurrent: check})
    committedInputTarget(input)
    if (input.authority.scope.kind !== 'TERMINAL' || input.authority.sessionId !== input.binding.sessionId ||
        input.authority.scope.terminalHandle !== input.binding.logicalHandle || input.receipt.key.method !== 'terminal.send' ||
        input.receipt.key.principalId !== input.authority.principal || input.binding.principalId !== input.authority.principal) {
      throw new InputStoreError('TERMINAL_RUNTIME_AUTHENTICATED_ORIGIN')
    }
    const key = JSON.stringify(input.receipt.key)
    if (seen.has(key)) { return }
    seen.add(key); waiting.set(key, input); notice('QUEUED'); pump()
  }
  const observe = (original: ProviderObservation): void => {
    const observation = immutableSnapshot(original)
    const pending = submissions.get(observation.identity.deliveryAttemptId)
    if (!pending || !sameSubmission(pending, observation)) { notice('RETAINED', 'TERMINAL_RUNTIME_OBSERVATION_UNMATCHED'); return }
    enqueue(async () => {
      const delivery: InputDeliveryObservation | null = observation.kind === 'ADMITTED'
        ? {kind: 'ADMITTED', proof: observation.admission}
        : observation.kind === 'TARGET_STOPPED' ? {kind: 'INTERRUPTED', proof: observation.stopped}
          : observation.kind === 'COMPLETED' && observation.completed ? {kind: 'SETTLED', proof: observation.completed}
            : observation.kind === 'UNKNOWN' && observation.uncertainty ? {kind: 'UNKNOWN', uncertainty: observation.uncertainty} : null
      if (!delivery) { notice('RETAINED', 'TERMINAL_RUNTIME_VERIFIED_OBSERVATION_REQUIRED'); return }
      const binding = pending.port.binding
      const stored = await runDurableTransaction(pool, async tx => {
        await lockAggregates(tx, {sessionIds: [binding.sessionId], runtimeUnitIds: [binding.runtimeUnitId]})
        if (observation.kind === 'ADMITTED') {
          await recordContextDeliveryInTransaction(tx, pending.input.authority, pending.request.context, observation.contextDelivery)
        }
        return observeInputDeliveryInTransaction(tx, pending.input.authority, {messageId: pending.request.sealed.messageId,
          deliveryAttemptId: pending.request.deliveryAttemptId, runtimeUnitId: binding.runtimeUnitId,
          attemptId: binding.attemptId, podUid: binding.podUid, executionEpoch: binding.executionEpoch}, delivery)
      })
      if (!stored.ok) { throw stored.error }
      notice('OBSERVED')
      // Historical observation survives loss of the old controller's settlement
      // authority. Only the original live owner may settle its command, separately.
      const settled = await runDurableTransaction(pool, async tx => {
        await lockAggregates(tx, {sessionIds: [binding.sessionId], runtimeUnitIds: [binding.runtimeUnitId]})
        const authority = await LockedGatewayAuthority.acquire(tx, pending.staged.context)
        const command = await lookupCommand(authority, pending.request.commandClaim.identity)
        if (!command || command.state !== 'EXECUTING') { return }
        if (delivery.kind === 'UNKNOWN') { await markCommandUnknown(authority, pending.request.commandClaim) }
        else { await settleOwnedExecution(authority, pending.request.commandClaim, {state: 'RESOLVED',
          result: {receipt: delivery.kind}, evidenceRefs: [delivery.proof.evidenceRef]}) }
      })
      if (!settled.ok) { throw settled.error }
    })
  }
  return Object.freeze({committed, ready: pump, observe, drain: () => tail,
    dispose: () => { closed = true; waiting.clear() }})
}

function sameSubmission(pending: Submission, observation: ProviderObservation): boolean {
  const actual = observation.identity, expected = pending.request
  return observation.source === 'PROVIDER_PROTOCOL' &&
    JSON.stringify(actual.binding) === JSON.stringify(pending.port.binding) &&
    actual.messageId === expected.sealed.messageId && actual.deliveryAttemptId === expected.deliveryAttemptId &&
    actual.sealedRevision === expected.sealed.sealedRevision && actual.sealedPayloadHash === expected.sealed.payloadHash &&
    actual.contextRevision === expected.context.revision && actual.contextHash === expected.context.hash &&
    JSON.stringify(actual.commandClaim) === JSON.stringify(expected.commandClaim)
}
