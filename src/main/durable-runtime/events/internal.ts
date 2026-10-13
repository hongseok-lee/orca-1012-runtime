import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { SessionId } from '../../../shared/durable-runtime/identity.ts'

import type { JsonValue } from '../db/atomic.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { DurableTransaction } from '../db/connection.ts'

import type { ConsumerAuthority, ProducerStream } from './types.ts'

import { d, type ProducerRow } from './model.ts'

export function reject(code: string): never {
  throw new DurableDatabaseError(code)
}

export function json(value: JsonValue): string {
  function normalize(item: JsonValue): JsonValue {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      return item
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      return item
    }
    if (Array.isArray(item)) {
      return item.map(normalize)
    }
    if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      const result: Record<string, JsonValue> = Object.create(null)
      for (const key of Object.keys(item).sort()) {
        result[key] = normalize(item[key])
      }
      return result
    }
    return reject('EVENT_JSON')
  }
  return JSON.stringify(normalize(value))
}

export function streamValues(stream: ProducerStream): string[] {
  logicalId('producer', stream.producerId)
  if (typeof stream.incarnation !== 'string' || !stream.incarnation) {
    reject('EVENT_STREAM')
  }
  return [stream.producerId, stream.incarnation]
}

export function targetIds(ids: readonly SessionId[]): SessionId[] {
  for (const id of ids) {
    logicalId('session', id)
  }
  const result = [...new Set(ids)].sort()
  if (result.length !== ids.length) {
    reject('EVENT_TARGET_DUPLICATE')
  }
  return result
}

export function milliseconds(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    reject('EVENT_DEADLINE')
  }
  return value
}

export function validateAuthority(authority: ConsumerAuthority): void {
  counter('controller-term', authority.term)
  if (!authority.scope || !authority.owner) {
    reject('EVENT_AUTHORITY')
  }
}

export async function producer(
  tx: DurableTransaction,
  stream: ProducerStream,
  locked: boolean
): Promise<ProducerRow> {
  const key = JSON.stringify(streamValues(stream))
  if (locked) {
    tx.advanceLock(6, key)
  }
  const result = await tx.query<ProducerRow>(
    `SELECT * FROM ${d}runtime_event_producers WHERE producer_id=$1 AND incarnation=$2${locked ? ' FOR UPDATE' : ''}`,
    streamValues(stream)
  )
  if (!result.rows[0]) {
    reject('EVENT_PRODUCER_MISSING')
  }
  if (locked) {
    tx.markLockAcquired(6, key)
  }
  return result.rows[0]
}

export async function targets(tx: DurableTransaction, eventId: string): Promise<SessionId[]> {
  const rows = await tx.query<{ session_id: string }>(
    `SELECT session_id FROM ${d}runtime_event_targets WHERE event_id=$1 ORDER BY session_id`,
    [eventId]
  )
  return rows.rows.map((row) => logicalId('session', row.session_id))
}

export function sameTargets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export async function lease(tx: DurableTransaction, authority: ConsumerAuthority): Promise<void> {
  validateAuthority(authority)
  tx.advanceLock(5, authority.scope)
  const row = await tx.query(
    `SELECT owner,term,expires_at>clock_timestamp() AS live FROM ${d}controller_leases WHERE scope=$1 FOR UPDATE`,
    [authority.scope]
  )
  if (
    !row.rows[0] ||
    row.rows[0].owner !== authority.owner ||
    row.rows[0].term !== authority.term ||
    !row.rows[0].live
  ) {
    reject('EVENT_STALE_AUTHORITY')
  }
  tx.markLockAcquired(5, authority.scope)
}

export async function liveLease(
  tx: DurableTransaction,
  authority: ConsumerAuthority
): Promise<void> {
  const valid = await tx.query(
    `SELECT scope FROM ${d}controller_leases WHERE scope=$1 AND owner=$2 AND term=$3 AND expires_at>clock_timestamp()`,
    [authority.scope, authority.owner, authority.term]
  )
  if (valid.rowCount !== 1) {
    reject('EVENT_STALE_AUTHORITY')
  }
}

/** Register only a binding already verified by the upstream workload boundary.
 * Attempts may be historical; old-epoch events are not current-state proofs. */
