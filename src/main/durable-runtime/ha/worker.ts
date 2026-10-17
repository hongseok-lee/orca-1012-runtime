import { performance } from 'node:perf_hooks'
import type { Pool } from 'pg'
import { DurableDatabaseError, safeDatabaseError } from '../db/connection.ts'
import type { VerifiedControllerIdentity } from '../runtime/gateway/types.ts'
import { CONTROLLER_SCOPE, ControllerInstance, positiveInteger, snapshotPolicy } from './instance.ts'
import type { LeasePolicy, LeaseRecord } from './instance.ts'
import { releaseControllerLease } from './lease.ts'
import type { AcquireLeaseResult, RenewLeaseResult, ReleaseLeaseResult } from './lease.ts'
import { ControllerLeaseSession } from './session.ts'
import { runControllerPass } from './pass.ts'
import type { ControllerPassRequest, ControllerPassResult } from './pass.ts'

export type ControllerWorkerPolicy = Readonly<{
  lease: LeasePolicy
  renewIntervalMs: number
  standbyPollIntervalMs: number
  passPollIntervalMs: number
  maximumWork: number
  externalBudgetMs: number
}>
export type ControllerWorkerCallbacks = Pick<ControllerPassRequest,
  'planStep' | 'eventWork' | 'executeCommitted' | 'lookupOriginal' | 'recoverInput' | 'inventory'>
type Stage = 'ACQUIRE' | 'RENEW' | 'PASS' | 'RELEASE' | 'START'
export type ControllerWorkerFailure = Readonly<{ stage: Stage; code: string }>
export type ControllerWorkerSnapshot = Readonly<{
  phase: 'NEW' | 'STARTING' | 'STANDBY' | 'ACTIVE' | 'STOPPING' | 'STOPPED'
  confirmedLease: LeaseRecord | null
  lastAcquire: AcquireLeaseResult | null
  lastRenew: RenewLeaseResult | null
  lastPass: ControllerPassResult | null
  lastRelease: ReleaseLeaseResult | null
  lastFailure: ControllerWorkerFailure | null
  stoppedBy: ControllerWorkerFailure | Readonly<{ stage: 'STOP'; code: 'REQUESTED' }> | null
  inFlight: Readonly<{ acquire: boolean; renew: boolean; pass: boolean; callbacks: number; cleanup: boolean }>
}>
export type ControllerWorker = Readonly<{
  start(): boolean
  stop(): Promise<ReleaseLeaseResult | null>
  snapshot(): ControllerWorkerSnapshot
}>

// Only excludes another process worker using this exact Pool object in this process.
// It supplies no PG authority, leader election, writer fencing or Pool ownership.
const owners = new WeakSet<Pool>()
const callbackNames = ['planStep', 'eventWork', 'executeCommitted', 'lookupOriginal', 'recoverInput', 'inventory']
function safeCode(code: string): string { return /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'DB_FAILURE' }
function failureCode(error: unknown): string { return safeCode(safeDatabaseError(error).code) }

function capturePolicy(input: ControllerWorkerPolicy): ControllerWorkerPolicy {
  const fixed = Object.freeze({ lease: snapshotPolicy(input.lease),
    renewIntervalMs: positiveInteger(input.renewIntervalMs),
    standbyPollIntervalMs: positiveInteger(input.standbyPollIntervalMs),
    passPollIntervalMs: positiveInteger(input.passPollIntervalMs),
    maximumWork: positiveInteger(input.maximumWork), externalBudgetMs: positiveInteger(input.externalBudgetMs) })
  if (fixed.renewIntervalMs >= fixed.lease.durationMs) { throw new DurableDatabaseError('CONTROLLER_WORKER_POLICY') }
  return fixed
}
function captureCallbacks(input: ControllerWorkerCallbacks): ControllerWorkerCallbacks {
  if (Object.keys(input).some(key => !callbackNames.includes(key)) ||
      callbackNames.slice(0, 5).some(key => {
        const value = Reflect.get(input, key)
        return value !== undefined && typeof value !== 'function'
      })) { throw new DurableDatabaseError('CONTROLLER_WORKER_CALLBACKS') }
  const inventory = input.inventory
  if (inventory && (typeof inventory.sink !== 'function' || !inventory.transport ||
      ['list', 'watch', 'get'].some(key => typeof Reflect.get(inventory.transport, key) !== 'function'))) {
    throw new DurableDatabaseError('CONTROLLER_WORKER_CALLBACKS')
  }
  const transport = inventory?.transport
  return Object.freeze({ planStep: input.planStep?.bind(input), eventWork: input.eventWork?.bind(input),
    executeCommitted: input.executeCommitted?.bind(input), lookupOriginal: input.lookupOriginal?.bind(input),
    recoverInput: input.recoverInput?.bind(input),
    inventory: inventory && transport ? Object.freeze({ sink: inventory.sink.bind(inventory),
      transport: Object.freeze({ list: transport.list.bind(transport), watch: transport.watch.bind(transport),
        get: transport.get.bind(transport) }) }) : undefined })
}

/** Captures policy/callback references now. Only start creates an instance/session and performs PG I/O.
 * No entry wiring, physical transport, controllerConnected flag or Pool.end lives here. */
export function createControllerWorker(pool: Pool, input: ControllerWorkerPolicy,
  caller: ControllerWorkerCallbacks = {}): ControllerWorker {
  const policy = capturePolicy(input), callbacks = captureCallbacks(caller)
  const cancellation = new AbortController()
  const timers = new Map<'ACQUIRE' | 'RENEW' | 'PASS', ReturnType<typeof setTimeout>>()
  const calls = new Set<Promise<unknown>>()
  let phase: ControllerWorkerSnapshot['phase'] = 'NEW', closing = false, ownsPool = false
  let instance: ControllerInstance | null = null, session: ControllerLeaseSession | null = null
  let confirmedLease: LeaseRecord | null = null
  let lastAcquire: AcquireLeaseResult | null = null, lastRenew: RenewLeaseResult | null = null
  let lastPass: ControllerPassResult | null = null, lastRelease: ReleaseLeaseResult | null = null
  let lastFailure: ControllerWorkerFailure | null = null, stoppedBy: ControllerWorkerSnapshot['stoppedBy'] = null
  let acquiring: Promise<void> | null = null, renewing: Promise<void> | null = null, passing: Promise<void> | null = null
  let completion: Promise<ReleaseLeaseResult | null> | null = null, cleanup = false

  function ensureRunning(): void {
    if (closing || cancellation.signal.aborted) { throw new DurableDatabaseError('CONTROLLER_PASS_CANCELLED') }
  }
  // Pass cancellation can win a Promise.race while the actual transport/sink still runs.
  // Retain that original promise too; its settlement is not physical writer-stop proof.
  function invoke<T>(action: () => Promise<T>): Promise<T> {
    ensureRunning()
    const task = Promise.resolve().then(() => { ensureRunning(); return action() })
    calls.add(task)
    void task.then(() => { calls.delete(task) }, () => { calls.delete(task) })
    return task
  }
  const forwarded: ControllerWorkerCallbacks = Object.freeze({
    planStep: callbacks.planStep ? (...args: Parameters<NonNullable<ControllerPassRequest['planStep']>>) => {
      ensureRunning(); return callbacks.planStep!(...args)
    } : undefined,
    eventWork: callbacks.eventWork ? (...args: Parameters<NonNullable<ControllerPassRequest['eventWork']>>) => {
      ensureRunning()
      const selected = callbacks.eventWork!(...args)
      if (!selected) { return null }
      const handler = selected.handler.bind(selected)
      return Object.freeze({ options: selected.options, handler: (...values: Parameters<typeof handler>) =>
        invoke(() => handler(...values)) })
    } : undefined,
    executeCommitted: callbacks.executeCommitted ? (...args: Parameters<NonNullable<ControllerPassRequest['executeCommitted']>>) =>
      invoke(() => callbacks.executeCommitted!(...args)) : undefined,
    lookupOriginal: callbacks.lookupOriginal ? (...args: Parameters<NonNullable<ControllerPassRequest['lookupOriginal']>>) =>
      invoke(() => callbacks.lookupOriginal!(...args)) : undefined,
    recoverInput: callbacks.recoverInput ? (...args: Parameters<NonNullable<ControllerPassRequest['recoverInput']>>) =>
      invoke(() => callbacks.recoverInput!(...args)) : undefined,
    inventory: callbacks.inventory ? Object.freeze({
      transport: Object.freeze({ list: (signal: AbortSignal) => invoke(() => callbacks.inventory!.transport.list(signal)),
        watch: (version: string, signal: AbortSignal) => invoke(() => callbacks.inventory!.transport.watch(version, signal)),
        get: (namespace: string, name: string, signal: AbortSignal) => invoke(() => callbacks.inventory!.transport.get(namespace, name, signal)) }),
      sink: (...args: Parameters<NonNullable<ControllerPassRequest['inventory']>['sink']>) =>
        invoke(() => callbacks.inventory!.sink(...args))
    }) : undefined
  })

  function schedule(kind: 'ACQUIRE' | 'RENEW' | 'PASS', delayMs: number, action: () => void): void {
    if (closing) { return }
    const due = performance.now() + delayMs
    const tick = () => {
      timers.delete(kind)
      if (closing) { return }
      const remaining = due - performance.now()
      if (remaining > 0) { timers.set(kind, setTimeout(tick, Math.min(remaining, 2_147_483_647))) }
      else { action() }
    }
    timers.set(kind, setTimeout(tick, Math.min(delayMs, 2_147_483_647)))
  }

  function beginStop(cause: NonNullable<ControllerWorkerSnapshot['stoppedBy']>): Promise<ReleaseLeaseResult | null> {
    if (completion) { return completion }
    closing = true; stoppedBy = cause; cleanup = true
    phase = cause.stage === 'STOP' ? 'STOPPING' : 'STOPPED'
    for (const timer of timers.values()) { clearTimeout(timer) }
    timers.clear(); cancellation.abort(); session?.stop()
    completion = Promise.resolve().then(async () => {
      try {
        await Promise.all([acquiring, renewing, passing])
        // No new callback can enter after closing. Late pass/transport replies stay in this old owner.
        await Promise.allSettled(calls)
        if (confirmedLease && instance) {
          lastRelease = Object.freeze(await releaseControllerLease(pool, instance, confirmedLease))
          if (lastRelease.status !== 'RELEASED') {
            lastFailure = Object.freeze({ stage: 'RELEASE', code: lastRelease.status === 'LOST'
              ? `CONTROLLER_RELEASE_${lastRelease.reason}` : safeCode(lastRelease.code) })
          }
        }
        return lastRelease
      } catch (error) {
        const code = failureCode(error)
        lastFailure = Object.freeze({ stage: 'RELEASE', code })
        throw new DurableDatabaseError(code)
      } finally {
        cleanup = false; phase = 'STOPPED'
        if (ownsPool) { owners.delete(pool); ownsPool = false }
      }
    })
    // Automatic fail-closed cleanup has no caller awaiting it yet. Preserve its rejection for stop().
    void completion.catch(() => undefined)
    return completion
  }
  function fail(stage: Stage, code: string): void {
    lastFailure = Object.freeze({ stage, code: safeCode(code) })
    if (!closing) { void beginStop(lastFailure) }
  }

  // The only issuer is this closed-over live session. No raw/public identity/lease argument or export exists.
  async function controllerIdentity(): Promise<VerifiedControllerIdentity> {
    ensureRunning()
    if (!session || !instance || !confirmedLease) { throw new DurableDatabaseError('CONTROLLER_PASS_IDENTITY') }
    const current = await session.assertCurrent(pool, confirmedLease, cancellation.signal)
    ensureRunning()
    if (current.scope !== CONTROLLER_SCOPE || current.owner !== instance.owner || current.term !== confirmedLease.term) {
      throw new DurableDatabaseError('CONTROLLER_PASS_IDENTITY')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Private session.acquire/renew COMMIT confirmation plus actual PG assertCurrent above; never caller/row projection authority.
    return Object.freeze({ scope: current.scope, owner: current.owner, term: current.term }) as unknown as VerifiedControllerIdentity
  }
  function launchPass(): void {
    if (closing || passing) { return }
    passing = Promise.resolve().then(async () => {
      const controller = await controllerIdentity()
      ensureRunning()
      const result = await runControllerPass(pool, session!, { ...forwarded, controller,
        maximumWork: policy.maximumWork, externalBudgetMs: policy.externalBudgetMs, signal: cancellation.signal })
      lastPass = Object.freeze({ ...result, reason: safeCode(result.reason),
        items: Object.freeze(result.items.map(item => Object.freeze({ ...item }))) })
      if (result.status === 'STOPPED') { fail('PASS', result.reason) }
      else if (!closing) { schedule('PASS', policy.passPollIntervalMs, launchPass) }
    }).catch(error => { fail('PASS', failureCode(error)) }).finally(() => { passing = null })
  }
  function launchRenew(): void {
    if (closing || renewing || acquiring) { return }
    renewing = Promise.resolve().then(async () => {
      if (closing) { return }
      const result = await session!.renew()
      lastRenew = Object.freeze(result)
      // stop() clears session.lease; a late confirmed renewal still owns its exact new revision for cleanup.
      if (result.status === 'ACTIVE') { confirmedLease = result.lease }
      if (closing) { return }
      if (result.status !== 'ACTIVE') { fail('RENEW', result.status === 'LOST' ? `CONTROLLER_LEASE_${result.reason}` : result.code) }
      else { schedule('RENEW', policy.renewIntervalMs, launchRenew) }
    }).catch(error => { fail('RENEW', failureCode(error)) }).finally(() => { renewing = null })
  }
  function launchAcquire(): void {
    if (closing || acquiring || renewing) { return }
    acquiring = Promise.resolve().then(async () => {
      if (closing) { return }
      const result = await session!.acquire()
      lastAcquire = Object.freeze(result)
      if (result.status === 'ACTIVE') { confirmedLease = result.lease }
      if (closing) { return }
      if (result.status === 'ACTIVE') {
        phase = 'ACTIVE'
        schedule('RENEW', policy.renewIntervalMs, launchRenew); launchPass()
      } else if (result.status === 'STANDBY') {
        phase = 'STANDBY'; schedule('ACQUIRE', policy.standbyPollIntervalMs, launchAcquire)
      } else { fail('ACQUIRE', result.code) }
    }).catch(error => { fail('ACQUIRE', failureCode(error)) }).finally(() => { acquiring = null })
  }
  return Object.freeze({
    start(): boolean {
      if (phase !== 'NEW' || owners.has(pool)) { return false }
      owners.add(pool); ownsPool = true; phase = 'STARTING'
      try {
        instance = new ControllerInstance(CONTROLLER_SCOPE)
        session = new ControllerLeaseSession(pool, instance, policy.lease)
        launchAcquire()
      } catch (error) { fail('START', failureCode(error)) }
      return true
    },
    stop: () => beginStop(Object.freeze({ stage: 'STOP', code: 'REQUESTED' })),
    snapshot: () => Object.freeze({ phase, confirmedLease, lastAcquire, lastRenew, lastPass, lastRelease,
      lastFailure, stoppedBy, inFlight: Object.freeze({ acquire: acquiring !== null, renew: renewing !== null,
        pass: passing !== null, callbacks: calls.size, cleanup }) })
  })
}
