import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, DurableTransaction, safeDatabaseError } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { snapshotExpected, snapshotInstance, snapshotPolicy } from './instance.ts'
import type { ControllerInstance, ExpectedLease, LeaseIdentity, LeasePolicy, LeaseRecord } from './instance.ts'

export type LeaseFailure =
  | { readonly status: 'UNCERTAIN'; readonly code: string }
  | { readonly status: 'UNAVAILABLE'; readonly code: string }
export type LostLeaseReason = 'MISSING' | 'OWNER_CHANGED' | 'TERM_CHANGED' | 'REVISION_CHANGED' | 'EXPIRED'
export type LostLease = { readonly status: 'LOST'; readonly reason: LostLeaseReason }
export type ActiveLease = { readonly status: 'ACTIVE'; readonly lease: LeaseRecord;
  readonly transition: 'ACQUIRED' | 'ALREADY_OWNED' | 'RENEWED' }
export type AcquireLeaseResult = ActiveLease | { readonly status: 'STANDBY' } | LeaseFailure
export type RenewLeaseResult = ActiveLease | LostLease | LeaseFailure
export type ReleaseLeaseResult = { readonly status: 'RELEASED'; readonly lease: LeaseRecord } | LostLease | LeaseFailure

type LeaseRow = { scope: string; owner: string; term: string; revision: string; expires_at: Date }
function record(row: LeaseRow): LeaseRecord {
  return Object.freeze({ scope: row.scope, owner: row.owner, term: counter('controller-term', row.term),
    revision: counter('row:controller', row.revision), expiresAt: row.expires_at.toISOString() })
}

// Scope is text in controller_leases, while the existing audit/outbox schemas
// require UUIDs. This stable, namespaced UUID only identifies that scope's
// journal; it neither creates a dataset nor authenticates a controller.
function journalId(scope: string): string {
  const h = createHash('sha256').update(`durable-runtime:controller-lease:v1:${scope}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

async function transition(tx: DurableTransaction, before: LeaseRow, after: LeaseRow,
  kind: 'ACQUIRED' | 'RENEWED' | 'RELEASED', policyRevision: string | null): Promise<void> {
  const time = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now
  const old = record(before), next = record(after)
  const event: JsonValue = { kind: `CONTROLLER_LEASE_${kind}`, scope: next.scope, owner: next.owner,
    term: next.term, revision: next.revision, expiresAt: next.expiresAt, policyRevision }
  await appendAudit(tx, { actorId: next.owner, kind: `CONTROLLER_LEASE_${kind}`, reasonCode: kind,
    previousState: { owner: old.owner, term: old.term, revision: old.revision, expiresAt: old.expiresAt },
    nextState: event, occurredAt: time, receivedAt: time, producerId: journalId(next.scope),
    producerSeq: counter('sequence:producer', next.revision), evidenceRefs: [] })
  await enqueueOutbox(tx, { eventId: logicalId('event', randomUUID()), aggregateId: journalId(next.scope),
    aggregateKind: 'controller-lease', revision: next.revision, event })
}

/** No public callback: lease transactions can never acquire lower-rank locks
 * or contain transport I/O. Provisional results leave only after COMMIT. */
async function leaseTransaction<T>(pool: Pool, body: (tx: DurableTransaction) => Promise<T>): Promise<T | LeaseFailure> {
  let client: PoolClient
  try { client = await pool.connect() } catch (error) {
    return { status: 'UNAVAILABLE', code: safeDatabaseError(error).code }
  }
  const tx = new DurableTransaction(client)
  let committing = false, destroy = false
  try {
    await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const result = await body(tx)
    committing = true
    const committed = await tx.query('COMMIT')
    if (committed.command !== 'COMMIT') throw new DurableDatabaseError('TX_NOT_COMMITTED')
    return result
  } catch (error) {
    const code = safeDatabaseError(error).code
    // These server errors confirm rejection. A lost COMMIT response never
    // authorizes scheduling and the suspect connection is discarded.
    const uncertain = committing && !/^(23|40|25)[A-Z0-9]{3}$/.test(code) && code !== 'TX_NOT_COMMITTED'
    destroy = uncertain
    try { await client.query('ROLLBACK') } catch { destroy = true }
    return { status: uncertain ? 'UNCERTAIN' : 'UNAVAILABLE', code }
  } finally {
    tx.close()
    client.release(destroy)
  }
}

async function lockedLease(tx: DurableTransaction, scope: string): Promise<LeaseRow | null> {
  tx.advanceLock(5, scope)
  const result = await tx.query<LeaseRow>(
    'SELECT scope,owner,term,revision,expires_at FROM durable_runtime.controller_leases WHERE scope=$1 FOR UPDATE', [scope])
  if (result.rows[0]) tx.markLockAcquired(5, scope)
  return result.rows[0] ?? null
}

async function liveAfterLock(tx: DurableTransaction, scope: string): Promise<boolean> {
  // Intentionally separate from SELECT FOR UPDATE: its expressions may have
  // been evaluated before waiting for a contended lock. No app clock is used.
  return (await tx.query<{ live: boolean }>(
    'SELECT expires_at>clock_timestamp() AS live FROM durable_runtime.controller_leases WHERE scope=$1', [scope])).rows[0].live
}

export async function tryAcquireControllerLease(pool: Pool, caller: ControllerInstance,
  callerPolicy: LeasePolicy): Promise<AcquireLeaseResult> {
  const instance = snapshotInstance(caller), policy = snapshotPolicy(callerPolicy)
  return leaseTransaction(pool, async tx => {
    tx.advanceLock(5, instance.scope)
    await tx.query(`INSERT INTO durable_runtime.controller_leases(scope,owner,term,revision,expires_at)
      VALUES($1,'',0,0,clock_timestamp()-interval '1 millisecond') ON CONFLICT(scope) DO NOTHING`, [instance.scope])
    const before = (await lockedLease(tx, instance.scope))!
    if (await liveAfterLock(tx, instance.scope)) {
      return before.owner === instance.owner
        ? { status: 'ACTIVE' as const, lease: record(before), transition: 'ALREADY_OWNED' as const }
        : { status: 'STANDBY' as const }
    }
    const changed = await tx.query<LeaseRow>(`UPDATE durable_runtime.controller_leases SET owner=$2,term=term+1,
      revision=revision+1,expires_at=clock_timestamp()+$3::bigint*interval '1 millisecond'
      WHERE scope=$1 AND term=$4 AND revision=$5 AND expires_at<=clock_timestamp() RETURNING *`,
      [instance.scope, instance.owner, policy.durationMs, before.term, before.revision])
    const after = changed.rows[0]
    if (!after) throw new DurableDatabaseError('CONTROLLER_ACQUIRE_CAS')
    await transition(tx, before, after, 'ACQUIRED', policy.revision)
    return { status: 'ACTIVE' as const, lease: record(after), transition: 'ACQUIRED' as const }
  })
}

function stale(row: LeaseRow | null, expected: LeaseIdentity): LostLeaseReason | null {
  if (!row) return 'MISSING'
  if (row.owner !== expected.owner) return 'OWNER_CHANGED'
  if (row.term !== expected.term) return 'TERM_CHANGED'
  if (row.revision !== expected.revision) return 'REVISION_CHANGED'
  return null
}

async function mutateOwnedLease(pool: Pool, expected: LeaseIdentity,
  policy: LeasePolicy | null): Promise<RenewLeaseResult | ReleaseLeaseResult> {
  return leaseTransaction(pool, async tx => {
    const before = await lockedLease(tx, expected.scope)
    const reason = stale(before, expected)
    if (reason) return { status: 'LOST' as const, reason }
    if (!await liveAfterLock(tx, expected.scope)) return { status: 'LOST' as const, reason: 'EXPIRED' as const }
    const changed = await tx.query<LeaseRow>(`UPDATE durable_runtime.controller_leases SET revision=revision+1,
      expires_at=clock_timestamp()+$5::bigint*interval '1 millisecond'
      WHERE scope=$1 AND owner=$2 AND term=$3 AND revision=$4 AND expires_at>clock_timestamp() RETURNING *`,
      [expected.scope, expected.owner, expected.term, expected.revision, policy?.durationMs ?? 0])
    const after = changed.rows[0]
    if (!after) return { status: 'LOST' as const, reason: 'EXPIRED' as const }
    await transition(tx, before!, after, policy ? 'RENEWED' : 'RELEASED', policy?.revision ?? null)
    return policy
      ? { status: 'ACTIVE' as const, lease: record(after), transition: 'RENEWED' as const }
      : { status: 'RELEASED' as const, lease: record(after) }
  })
}

export async function renewControllerLease(pool: Pool, caller: ControllerInstance, callerExpected: ExpectedLease,
  callerPolicy: LeasePolicy): Promise<RenewLeaseResult> {
  const expected = Object.freeze({ ...snapshotInstance(caller), ...snapshotExpected(callerExpected) })
  const policy = snapshotPolicy(callerPolicy)
  const result = await mutateOwnedLease(pool, expected, policy)
  if (result.status === 'RELEASED') throw new DurableDatabaseError('CONTROLLER_RESULT')
  return result
}

export async function releaseControllerLease(pool: Pool, caller: ControllerInstance,
  callerExpected: ExpectedLease): Promise<ReleaseLeaseResult> {
  const expected = Object.freeze({ ...snapshotInstance(caller), ...snapshotExpected(callerExpected) })
  const result = await mutateOwnedLease(pool, expected, null)
  if (result.status === 'ACTIVE') throw new DurableDatabaseError('CONTROLLER_RESULT')
  return result
}
