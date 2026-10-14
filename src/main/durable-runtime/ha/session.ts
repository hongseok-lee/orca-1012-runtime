import type { Pool } from 'pg'
import { DurableDatabaseError, safeDatabaseError } from '../db/connection.ts'
import { snapshotPolicy, type ControllerInstance, type LeaseIdentity, type LeasePolicy, type LeaseRecord } from './instance.ts'
import { tryAcquireControllerLease, renewControllerLease, releaseControllerLease } from './lease.ts'
import type { AcquireLeaseResult, RenewLeaseResult, ReleaseLeaseResult } from './lease.ts'
import { assertLiveControllerLease, readControllerTakeoverSnapshot, type ControllerTakeoverSnapshot } from './takeover.ts'

/** Process-local cancellation, not durable authority. Every pass and every
 * original mutation must still validate the actual PG lease. No timer/loop. */
export class ControllerLeaseSession {
  readonly instance: ControllerInstance
  readonly policy: LeasePolicy
  private active: LeaseRecord | null = null
  private changing: 'ACQUIRE' | 'RENEW' | 'RELEASE' | null = null
  private renewal: Promise<RenewLeaseResult> | null = null
  private generation = 0
  private cancellation = new AbortController()

  constructor(private readonly pool: Pool, instance: ControllerInstance, policy: LeasePolicy) {
    this.instance = instance
    this.policy = snapshotPolicy(policy)
  }

  // During renewal this remains the last confirmed record, never the pending
  // row. Scheduling must use the coordinated PG checks below, not this getter.
  get lease(): LeaseRecord | null { return this.changing && this.changing !== 'RENEW' ? null : this.active }
  get signal(): AbortSignal { return this.cancellation.signal }

  stop(): void {
    this.generation++
    this.active = null
    this.cancellation.abort()
  }

  private begin(kind: 'ACQUIRE' | 'RENEW' | 'RELEASE'): number {
    if (this.changing) {throw new DurableDatabaseError('CONTROLLER_LEASE_BUSY')}
    this.changing = kind
    return this.generation
  }

  private accept(result: AcquireLeaseResult | RenewLeaseResult | ReleaseLeaseResult, generation: number): void {
    // A concurrent pass failure/manual stop cannot be undone by a late reply.
    if (generation !== this.generation) {return}
    if (result.status !== 'ACTIVE') { this.stop(); return }
    // Only the current API invocation's confirmed transaction may reach here.
    if (this.cancellation.signal.aborted) {this.cancellation = new AbortController()}
    this.active = result.lease
  }

  async acquire(): Promise<AcquireLeaseResult> {
    const generation = this.begin('ACQUIRE')
    try {
      const result = await tryAcquireControllerLease(this.pool, this.instance, this.policy)
      this.accept(result, generation)
      return result
    } catch (error) { this.stop(); throw error }
    finally { this.changing = null }
  }

  async renew(): Promise<RenewLeaseResult> {
    if (this.changing) {throw new DurableDatabaseError('CONTROLLER_LEASE_BUSY')}
    const expected = this.lease
    if (!expected) { this.stop(); return ({ status: 'LOST', reason: 'MISSING' }) }
    const generation = this.begin('RENEW')
    // Publish the completion barrier synchronously, before another pass gate
    // can run. It includes accepting the confirmed record and clearing state.
    const pending = (async () => {
      try {
        const result = await renewControllerLease(this.pool, this.instance, expected, this.policy)
        this.accept(result, generation)
        return result
      } catch (error) { this.stop(); throw error }
      finally { this.changing = null; this.renewal = null }
    })()
    this.renewal = pending
    return pending
  }

  async release(): Promise<ReleaseLeaseResult> {
    const expected = this.lease
    if (!expected) { this.stop(); return { status: 'LOST', reason: 'MISSING' } }
    this.begin('RELEASE')
    this.stop()
    try { return await releaseControllerLease(this.pool, this.instance, expected) }
    finally { this.changing = null }
  }

  private async waitForRenewal(signal: AbortSignal, cancellation: AbortSignal): Promise<void> {
    const pending = this.renewal
    if (!pending) {return}
    let aborted: (() => void) | undefined
    const stopped = new Promise<never>((_, reject) => {
      aborted = () => reject(new DurableDatabaseError('CONTROLLER_PASS_CANCELLED'))
      signal.addEventListener('abort', aborted, { once: true })
      cancellation.addEventListener('abort', aborted, { once: true })
      if (signal.aborted || cancellation.aborted) {aborted()}
    })
    try { await Promise.race([pending, stopped]) }
    finally {
      if (aborted) {
        signal.removeEventListener('abort', aborted)
        cancellation.removeEventListener('abort', aborted)
      }
    }
  }

  private async coordinatedRead<T>(expected: Pick<LeaseIdentity, 'scope' | 'owner' | 'term'>,
    signal: AbortSignal, read: (lease: LeaseRecord) => Promise<T>): Promise<T> {
    const cancellation = this.signal
    const current = (): LeaseRecord => {
      if (signal.aborted || cancellation.aborted) {throw new DurableDatabaseError('CONTROLLER_PASS_CANCELLED')}
      const lease = this.lease
      if (!lease || lease.scope !== expected.scope || lease.owner !== expected.owner || lease.term !== expected.term) {
        throw new DurableDatabaseError('CONTROLLER_LEASE_STALE')
      }
      return lease
    }
    for (;;) {
      current()
      await this.waitForRenewal(signal, cancellation)
      const lease = current()
      let result: { value: T } | null = null
      let stale: DurableDatabaseError | null = null
      try { result = { value: await read(lease) } }
      catch (error) {
        const safe = safeDatabaseError(error)
        // A concurrent healthy renewal must not hide a real database failure.
        if (safe.code !== 'CONTROLLER_LEASE_STALE') {throw safe}
        stale = safe
      }
      current()
      // Covers COMMIT visible in PG before the renewal's driver reply arrives.
      // UNCERTAIN/LOST stops the session; only a confirmed revision can retry.
      await this.waitForRenewal(signal, cancellation)
      const refreshed = current()
      if (refreshed.revision !== lease.revision) {
        if (BigInt(refreshed.revision) <= BigInt(lease.revision)) {throw new DurableDatabaseError('CONTROLLER_LEASE_STALE')}
        continue // Read-only revalidation, never replay a mutation or effect.
      }
      if (stale) {throw stale}
      return result!.value
    }
  }

  /** Coordinates only same-process renewal; actual PG owner/term/revision and
   * expiry still decide authority. No permission is reconstructed on readback. */
  assertCurrent(pool: Pool, expected: Pick<LeaseIdentity, 'scope' | 'owner' | 'term'>,
    signal: AbortSignal): Promise<LeaseRecord> {
    const identity = Object.freeze({ scope: expected.scope, owner: expected.owner, term: expected.term })
    return this.coordinatedRead(identity, signal, async lease => {
      await assertLiveControllerLease(pool, lease)
      return lease
    })
  }

  readTakeoverSnapshot(pool: Pool, expected: Pick<LeaseIdentity, 'scope' | 'owner' | 'term'>,
    signal: AbortSignal): Promise<ControllerTakeoverSnapshot> {
    const identity = Object.freeze({ scope: expected.scope, owner: expected.owner, term: expected.term })
    return this.coordinatedRead(identity, signal, lease => readControllerTakeoverSnapshot(pool, lease))
  }
}
