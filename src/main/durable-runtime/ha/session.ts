import type { Pool } from 'pg'
import { DurableDatabaseError } from '../db/connection.ts'
import { snapshotPolicy, type ControllerInstance, type LeasePolicy, type LeaseRecord } from './instance.ts'
import { tryAcquireControllerLease, renewControllerLease, releaseControllerLease } from './lease.ts'
import type { AcquireLeaseResult, RenewLeaseResult, ReleaseLeaseResult } from './lease.ts'

/** Process-local cancellation, not durable authority. Every pass and every
 * original mutation must still validate the actual PG lease. No timer/loop. */
export class ControllerLeaseSession {
  readonly instance: ControllerInstance
  readonly policy: LeasePolicy
  private active: LeaseRecord | null = null
  private changing = false
  private generation = 0
  private cancellation = new AbortController()

  constructor(private readonly pool: Pool, instance: ControllerInstance, policy: LeasePolicy) {
    this.instance = instance
    this.policy = snapshotPolicy(policy)
  }

  get lease(): LeaseRecord | null { return this.changing ? null : this.active }
  get signal(): AbortSignal { return this.cancellation.signal }

  stop(): void {
    this.generation++
    this.active = null
    this.cancellation.abort()
  }

  private begin(): number {
    if (this.changing) throw new DurableDatabaseError('CONTROLLER_LEASE_BUSY')
    this.changing = true
    return this.generation
  }

  private accept(result: AcquireLeaseResult | RenewLeaseResult | ReleaseLeaseResult, generation: number): void {
    // A concurrent pass failure/manual stop cannot be undone by a late reply.
    if (generation !== this.generation) return
    if (result.status !== 'ACTIVE') { this.stop(); return }
    // Only the current API invocation's confirmed transaction may reach here.
    if (this.cancellation.signal.aborted) this.cancellation = new AbortController()
    this.active = result.lease
  }

  async acquire(): Promise<AcquireLeaseResult> {
    const generation = this.begin()
    try {
      const result = await tryAcquireControllerLease(this.pool, this.instance, this.policy)
      this.accept(result, generation)
      return result
    } catch (error) { this.stop(); throw error }
    finally { this.changing = false }
  }

  async renew(): Promise<RenewLeaseResult> {
    const expected = this.lease
    if (!expected) { this.stop(); return { status: 'LOST', reason: 'MISSING' } }
    const generation = this.begin()
    try {
      const result = await renewControllerLease(this.pool, this.instance, expected, this.policy)
      this.accept(result, generation)
      return result
    } catch (error) { this.stop(); throw error }
    finally { this.changing = false }
  }

  async release(): Promise<ReleaseLeaseResult> {
    const expected = this.lease
    if (!expected) { this.stop(); return { status: 'LOST', reason: 'MISSING' } }
    this.begin()
    this.stop()
    try { return await releaseControllerLease(this.pool, this.instance, expected) }
    finally { this.changing = false }
  }
}
