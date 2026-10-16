import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Pool } from 'pg'
import { logicalId, counter, type RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, safeDatabaseError } from '../db/connection.ts'
import { canonicalInput } from '../runtime/gateway/input.ts'
import type { VerifiedControllerIdentity, CommandClaim, GatewayContext } from '../runtime/gateway/types.ts'
import { claimRuntimeEvent, processRuntimeEvent } from '../events/store.ts'
import type { ConsumerOptions, EventHandler, ProducerStream } from '../events/types.ts'
// Exact P113 dependency; these shared files belong to the lifecycle owner.
// Verification composes the pinned dependency instead of copying a new API.
import { listDueReconciliations } from '../lifecycle/due.ts'
import { expireInitialWake, prepareReconcileStep, type InitialWakeExpiryRequest, type ReconcileStepRequest } from '../lifecycle/controller.ts'
import { recoverListWatch, type ListWatchTransport, type ObservationSink } from '../lifecycle/watch.ts'
import { positiveInteger } from './instance.ts'
import type { TakeoverCommand, TakeoverOperation, TakeoverQueueHead, TakeoverUnit } from './takeover.ts'
import type { ControllerLeaseSession } from './session.ts'

type StepPlan = Pick<ReconcileStepRequest, 'mutationKey' | 'step' | 'executorId' | 'input'>
export type AbortableInventoryTransport = {
  list(signal: AbortSignal): ReturnType<ListWatchTransport['list']>
  watch(resourceVersion: string, signal: AbortSignal): ReturnType<ListWatchTransport['watch']>
  get(namespace: string, name: string, signal: AbortSignal): ReturnType<ListWatchTransport['get']>
}
export type ControllerInventoryContext = Readonly<{
  controller: VerifiedControllerIdentity
  signal: AbortSignal
}>
/** The private live worker supplies context. Existing two-argument sinks remain assignable. */
export type ControllerInventorySink = (...args: [...Parameters<ObservationSink>, ControllerInventoryContext]) => Promise<void>
export type ControllerPassRequest = {
  readonly controller: VerifiedControllerIdentity
  readonly maximumWork: number
  readonly externalBudgetMs: number
  readonly signal?: AbortSignal
  /** Pure selection of an original step. No mutation, authentication or I/O. */
  readonly planStep?: (operation: TakeoverOperation, unit: TakeoverUnit) => StepPlan | null
  readonly eventWork?: (head: TakeoverQueueHead) => {
    readonly handler: EventHandler; readonly options: ConsumerOptions
  } | null
  /** The existing verified controller is forwarded, never issued from a claim/row.
   * Existing two-argument callbacks remain assignable to this internal surface. */
  readonly executeCommitted?: (claim: CommandClaim, signal: AbortSignal, context: Readonly<GatewayContext>) => Promise<void>
  readonly lookupOriginal?: (command: TakeoverCommand, signal: AbortSignal, context: Readonly<GatewayContext>) => Promise<void>
  readonly inventory?: { readonly transport: AbortableInventoryTransport; readonly sink: ControllerInventorySink }
}
export type ControllerPassItem = { readonly kind: 'RECONCILE' | 'QUEUE' | 'INVENTORY';
  readonly identity: string; readonly disposition: string }
export type ControllerPassResult = { readonly status: 'FINISHED' | 'STOPPED'; readonly reason: string;
  readonly items: readonly ControllerPassItem[] }

function snapshotInventory(caller: ControllerPassRequest['inventory']): ControllerPassRequest['inventory'] {
  if (!caller) {return undefined}
  const transport = caller.transport
  // Method references and their original receivers are fixed now. The actual
  // AbortSignal is still supplied at invocation; transport state is not frozen.
  return Object.freeze({ sink: caller.sink.bind(caller), transport: Object.freeze({
    list: transport.list.bind(transport), watch: transport.watch.bind(transport), get: transport.get.bind(transport)
  }) })
}

/** One finite invocation. Caller owns wakeups/renewals, connection/query
 * timeouts, authenticated controller identity and actual external transports.
 * This module creates none of those boundaries or a background loop. */
export async function runControllerPass(pool: Pool, session: ControllerLeaseSession,
  caller: ControllerPassRequest): Promise<ControllerPassResult> {
  // Seal mutable caller policy and callbacks before the first await. Identity
  // keeps its existing private verification brand; we never fabricate it.
  const request = Object.freeze({ controller: Object.freeze({ ...caller.controller }),
    maximumWork: caller.maximumWork, externalBudgetMs: caller.externalBudgetMs, signal: caller.signal,
    planStep: caller.planStep, eventWork: caller.eventWork, executeCommitted: caller.executeCommitted,
    lookupOriginal: caller.lookupOriginal, inventory: snapshotInventory(caller.inventory) })
  positiveInteger(request.maximumWork)
  positiveInteger(request.externalBudgetMs)
  counter('controller-term', request.controller.term)
  const startingLease = session.lease
  if (!startingLease || session.signal.aborted) {return { status: 'STOPPED', reason: 'NO_CONFIRMED_LEASE', items: [] }}
  if (request.controller.scope !== startingLease.scope || request.controller.owner !== startingLease.owner ||
      request.controller.term !== startingLease.term) {throw new DurableDatabaseError('CONTROLLER_PASS_IDENTITY')}
  // This monotonic timer bounds external I/O only. It never decides a PG
  // operation deadline/retry or lease expiry.
  const end = performance.now() + request.externalBudgetMs
  const local = new AbortController()
  const abort = () => local.abort()
  const sessionSignal = session.signal
  sessionSignal.addEventListener('abort', abort, { once: true })
  request.signal?.addEventListener('abort', abort, { once: true })
  if (sessionSignal.aborted || request.signal?.aborted) {abort()}
  const items: ControllerPassItem[] = []
  let work = 0

  async function gate(): Promise<void> {
    if (local.signal.aborted) {throw new DurableDatabaseError('CONTROLLER_PASS_CANCELLED')}
    await session.assertCurrent(pool, startingLease!, local.signal)
  }

  async function external<T>(invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
    await gate()
    const remaining = end - performance.now()
    if (remaining <= 0) {throw new DurableDatabaseError('CONTROLLER_EXTERNAL_BUDGET')}
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled: (() => void) | undefined
    const timeout = new Promise<never>((_, reject) => {
      cancelled = () => reject(new DurableDatabaseError('CONTROLLER_PASS_CANCELLED'))
      local.signal.addEventListener('abort', cancelled, { once: true })
      // Chunk long caller budgets rather than letting JS overflow a timer.
      const tick = () => {
        const left = end - performance.now()
        if (left <= 0) {
          reject(new DurableDatabaseError('CONTROLLER_EXTERNAL_TIMEOUT'))
          local.abort()
        } else {timer = setTimeout(tick, Math.min(left, 2_147_483_647))}
      }
      timer = setTimeout(tick, Math.min(remaining, 2_147_483_647))
    })
    try {
      // Late transport resolution is observed by Promise.race but discarded;
      // it cannot schedule another effect or feed a late watch event.
      const result = await Promise.race([Promise.resolve().then(() => {
        if (local.signal.aborted) {throw new DurableDatabaseError('CONTROLLER_PASS_CANCELLED')}
        return invoke(local.signal)
      }), timeout])
      await gate()
      return result
    } finally {
      if (timer) {clearTimeout(timer)}
      if (cancelled) {local.signal.removeEventListener('abort', cancelled)}
    }
  }

  function room(): boolean { return work < request.maximumWork && performance.now() < end }
  try {
    await gate()
    const snapshot = await session.readTakeoverSnapshot(pool, startingLease, local.signal)
    const units = new Map(snapshot.units.map(unit => [unit.id, unit]))
    const pending = new Map(snapshot.commands.map(command => [command.runtime_unit_id, command]))
    const expiredInitialWakes = new Map<RuntimeUnitId, TakeoverOperation>()
    // Scheduling uses the actual PG snapshot flag, never a JS deadline clock.
    // The expiry transaction alone revalidates lease/CAS/clock/no-effect guards.
    for (const operation of snapshot.operations) {
      const unit = units.get(operation.runtime_unit_id)
      if (unit && !pending.has(unit.id) && !expiredInitialWakes.has(unit.id) &&
          operation.deadline_expired && !operation.terminal && operation.kind === 'WAKE' &&
          operation.step === 'INTENT_QUEUED' && operation.step_revision === '0' && operation.expected_pod_uid === null &&
          unit.desired_mode === 'RUNNING' && unit.active_attempt_id === null &&
          operation.intent_revision === unit.intent_revision && operation.execution_epoch === unit.execution_epoch) {
        expiredInitialWakes.set(unit.id, operation)
      }
    }
    // Without a planner, keep the non-expired due/gate/work skip optimization.
    // Only actual expired initial WAKE candidates enter the expiry-only path.
    if (request.planStep || expiredInitialWakes.size) {
      // listDueReconciliations retains its original PG deadline predicate/order.
      const due = request.planStep ? await listDueReconciliations(pool) : []
      // Unresolved original commands also need lookup, even if their normal
      // Unit projection does not currently appear in the due list.
      const candidates: RuntimeUnitId[] = request.planStep
        ? [...new Set([...due, ...snapshot.commands.map(c => c.runtime_unit_id), ...expiredInitialWakes.keys()])]
        : [...expiredInitialWakes.keys()]
      for (const unitId of candidates) {
        if (!room()) {break}
        const unit = units.get(unitId)
        if (!unit) {continue} // Never use a global due result to adopt another scope.
        await gate()
        const command = pending.get(unitId)
        const expired = expiredInitialWakes.get(unitId)
        const operation = command
          ? snapshot.operations.find(o => o.id === command.operation_id)
          : expired ?? snapshot.operations.find(o => o.runtime_unit_id === unitId && !o.terminal && o.retry_due)
        work++
        if (!operation) {
          items.push({ kind: 'RECONCILE', identity: unitId, disposition: 'NO_ORIGINAL_OPERATION' })
          continue
        }
        if (!command && expired) {
          const expiryRequest: InitialWakeExpiryRequest = {
            context: Object.freeze({ controller: request.controller, runtimeUnitId: unitId, operationId: expired.id }),
            mutationKey: `initial-wake-expiry:${expired.id}:${unit.revision}:${expired.step_revision}:${randomUUID()}`,
            expectedUnitRevision: unit.revision, expectedIntentRevision: unit.intent_revision,
            expectedStepRevision: expired.step_revision
          }
          const expiry = await expireInitialWake(pool, expiryRequest)
          if (expiry.mutation.status === 'UNCERTAIN') {
            session.stop()
            return { status: 'STOPPED', reason: 'UNCERTAIN_COMMIT', items }
          }
          await gate()
          items.push({ kind: 'RECONCILE', identity: expired.id, disposition: expiry.reason })
          continue
        }
        const selected = request.planStep?.(operation, unit)
        if (!selected) {
          items.push({ kind: 'RECONCILE', identity: operation.id, disposition: command ? 'LOOKUP_REQUIRED' : 'NO_STEP_HANDLER' })
          continue
        }
        if (!command && !request.executeCommitted) {
          items.push({ kind: 'RECONCILE', identity: operation.id, disposition: 'NO_EXECUTOR' })
          continue
        }
        const plan: StepPlan = Object.freeze({ mutationKey: selected.mutationKey, step: selected.step,
          executorId: selected.executorId, input: JSON.parse(canonicalInput(selected.input)) })
        const context: Readonly<GatewayContext> = Object.freeze({ controller: request.controller, runtimeUnitId: unitId, operationId: operation.id })
        const prepared = await prepareReconcileStep(pool, {
          ...plan, context,
          expectedUnitRevision: unit.revision, expectedIntentRevision: unit.intent_revision,
          expectedStepRevision: operation.step_revision
        })
        if (prepared.mutation.status === 'UNCERTAIN') {
          session.stop()
          return { status: 'STOPPED', reason: 'UNCERTAIN_COMMIT', items }
        }
        await gate()
        if (prepared.execution.disposition === 'COMMITTED_EXECUTE') {
          const claim = prepared.execution.claim
          if (!request.executeCommitted) {
            items.push({ kind: 'RECONCILE', identity: operation.id, disposition: 'COMMITTED_EXECUTE_NOT_WIRED' })
          } else {
            await external(signal => request.executeCommitted!(claim, signal, context))
            items.push({ kind: 'RECONCILE', identity: operation.id, disposition: 'COMMITTED_EXECUTE' })
          }
        } else if (prepared.execution.reason === 'LOOKUP_ORIGINAL' && command && request.lookupOriginal) {
          // P113 performed original gateway adoption. No receipt becomes a claim,
          // no ACCEPTED/EXECUTING/UNKNOWN command is executed a second time here.
          await external(signal => request.lookupOriginal!(command, signal, context))
          items.push({ kind: 'RECONCILE', identity: command.id, disposition: 'LOOKUP_ORIGINAL' })
        } else {items.push({ kind: 'RECONCILE', identity: operation.id, disposition: prepared.execution.reason })}
      }
    }
    for (const head of snapshot.queueHeads) {
      if (!room()) {break}
      if (head.state === 'RETRY' && !head.retry_due) {continue}
      const selected = request.eventWork?.(head)
      // No handler means no claim/attempt charge and certainly no DONE.
      if (!selected || typeof selected.handler !== 'function') {continue}
      const options: ConsumerOptions = Object.freeze({ claimDurationMs: positiveInteger(selected.options.claimDurationMs),
        operationIds: selected.options.operationIds === undefined ? undefined
          : Object.freeze(selected.options.operationIds.map(id => logicalId('operation', id))) })
      const handler = selected.handler
      const producer = snapshot.producers.find(p => p.producer_id === head.producer_id && p.incarnation === head.incarnation)!
      const stream: ProducerStream = { producerId: logicalId('producer', producer.producer_id),
        incarnation: producer.incarnation as ProducerStream['incarnation'] }
      await gate()
      work++
      const claim = await claimRuntimeEvent(pool, stream, request.controller, options)
      if (claim.status !== 'CLAIMED') {
        items.push({ kind: 'QUEUE', identity: head.event_id, disposition: claim.status })
        continue
      }
      await gate()
      const processed = await processRuntimeEvent(pool, claim.claim, handler, options)
      items.push({ kind: 'QUEUE', identity: claim.claim.eventId, disposition: processed.status })
      if (processed.status === 'UNCERTAIN' || processed.status === 'STALE') {
        session.stop()
        return { status: 'STOPPED', reason: `QUEUE_${processed.status}`, items }
      }
    }
    if (room() && request.inventory) {
      const { transport, sink } = request.inventory
      work++
      const inventory = await external(async signal => recoverListWatch({
        list: () => external(() => transport.list(signal)),
        watch: version => external(() => transport.watch(version, signal)),
        get: (namespace, name) => external(() => transport.get(namespace, name, signal))
      }, async (event, source) => {
        await gate()
        // Caller supplies P113's actual guarded observation persistence. A
        // read inventory, absent object or Ready string is never stop proof.
        await sink(event, source, Object.freeze({ controller: request.controller, signal }))
        await gate()
      }))
      if (inventory.status === 'UNVERIFIABLE' && inventory.reason === 'PERSISTENCE_FAILED') {
        throw new DurableDatabaseError(`CONTROLLER_INVENTORY_${inventory.reason}`)
      }
      items.push({ kind: 'INVENTORY', identity: startingLease.scope, disposition: inventory.status })
    }
    await gate()
    return { status: 'FINISHED', reason: work >= request.maximumWork ? 'WORK_BUDGET' :
      performance.now() >= end ? 'EXTERNAL_BUDGET' : 'PASS_COMPLETE', items: Object.freeze(items) }
  } catch (error) {
    session.stop()
    return { status: 'STOPPED', reason: safeDatabaseError(error).code, items: Object.freeze(items) }
  } finally {
    local.abort()
    sessionSignal.removeEventListener('abort', abort)
    request.signal?.removeEventListener('abort', abort)
  }
}
