import { createHash } from 'node:crypto'
import type { JsonValue, ReceiptIdentity } from '../db/atomic.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { withDurableTransaction } from '../db/connection.ts'
import type { Pool } from 'pg'
import type { AggregateLocks } from '../db/locks.ts'
import { decimal, uuid, target, reason, date, reject } from '../replay/validation.ts'
import type { NotificationTarget, NotificationRow, SourceAuthority } from './types.ts'

export function authority(value: SourceAuthority): void {
  if (!value.actorId || !value.verificationRef) { reject('NOTIFICATION_SOURCE_AUTHORITY') }
}
export function incident(key: string): string {
  if (typeof key !== 'string' || !key) { reject('NOTIFICATION_INCIDENT') }
  // Preserve canonical source identity verbatim; no compatibility key rewriting.
  return key
}
export function targetJson(value: NotificationTarget): JsonValue {
  return target({
    ...(value.runtimeUnitId ? { runtimeUnitId: value.runtimeUnitId } : {}),
    ...(value.sessionIds ? { sessionIds: [...value.sessionIds] } : {}),
    ...(value.operationId ? { operationId: value.operationId } : {}),
    ...(value.eventId ? { eventId: value.eventId } : {}),
    ...(value.agentId ? { agentId: value.agentId } : {})
  })
}
export async function locks(pool: Pool, value: NotificationTarget, actionRef?: string): Promise<AggregateLocks> {
  const units = new Set<string>(value.runtimeUnitId ? [value.runtimeUnitId] : [])
  const operations = [...new Set([...(value.operationId ? [value.operationId] : []), ...(actionRef ? [actionRef] : [])])]
  if (value.eventId || operations.length) {
    await withDurableTransaction(pool, async tx => {
      if (value.eventId) {
        const origin = await tx.query<{ runtime_unit_id: string }>(`SELECT p.runtime_unit_id FROM durable_runtime.runtime_event_queue q
          JOIN durable_runtime.runtime_event_producers p USING(producer_id,incarnation) WHERE q.event_id=$1`, [value.eventId])
        const unit = origin.rows[0]?.runtime_unit_id
        if (unit) {
          if (value.runtimeUnitId && value.runtimeUnitId !== unit) { reject('NOTIFICATION_TARGET_CONFLICT') }
          units.add(unit)
        }
      }
      for (const id of operations) {
        const found = await tx.query<{ runtime_unit_id: string }>('SELECT runtime_unit_id FROM durable_runtime.operations WHERE id=$1', [uuid(id)])
        const unit = found.rows[0]?.runtime_unit_id
        if (!unit) { reject('NOTIFICATION_TARGET_CONFLICT') }
        if (units.size && !units.has(unit)) { reject('NOTIFICATION_TARGET_CONFLICT') }
        units.add(unit)
      }
    })
  }
  return { sessionIds: value.sessionIds, runtimeUnitIds: [...units].map(id => logicalId('runtime-unit', id)),
    operationIds: operations.map(id => logicalId('operation', id)) }
}
export function payloadHash(value: JsonValue): string {
  function canonical(item: JsonValue): JsonValue {
    if (Array.isArray(item)) { return item.map(canonical) }
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map(k => [k, canonical(item[k])]))
    }
    return item
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
export async function lockIncident(tx: DurableTransaction, key: string): Promise<void> {
  const lockKey = `notification:${incident(key)}`
  if (!tx.isLockHeld(6, lockKey)) {
    tx.advanceLock(6, lockKey)
    // A per-incident key lock covers an absent row; UNIQUE still protects races
    // with other owners that do not use this advisory key.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey])
    tx.markLockAcquired(6, lockKey)
  }
}
export async function original(tx: DurableTransaction, key: string, expectedTarget: JsonValue, id?: string): Promise<NotificationRow | null> {
  const result = await tx.query<NotificationRow & { target_matches: boolean }>(
    'SELECT *,target_ref=$2::jsonb AS target_matches FROM durable_runtime.notifications WHERE incident_key=$1 FOR UPDATE',
    [key, JSON.stringify(expectedTarget)])
  const row = result.rows[0]
  if (!row) { return null }
  if ((id !== undefined && row.id !== id) || !row.target_matches) { reject('NOTIFICATION_TARGET_CONFLICT') }
  return row
}
export function expected(row: NotificationRow, revision: string): void {
  if (row.revision !== decimal(revision)) { reject('NOTIFICATION_REVISION_CONFLICT') }
}
export function response(row: NotificationRow, eventId: string): JsonValue {
  return { notificationId: row.id, incidentKey: row.incident_key, revision: row.revision, state: row.state,
    readAt: row.read_at?.toISOString() ?? null, resolvedAt: row.resolved_at?.toISOString() ?? null, sourceEventId: eventId }
}
export function validateObservation(reasonCode: string, at: Date, retries: string): void { reason(reasonCode); date(at); decimal(retries) }

// The rank6 incident lock is acquired after the common mutation's receipt
// recheck. Recheck here as well for Agent-only targets with no business lock.
// Returning this response causes the common receipt INSERT to hit the existing
// UNIQUE key; P103 rolls back and resolves the original receipt as REPLAYED.
export async function replayAfterIncidentLock(tx: DurableTransaction, identity: ReceiptIdentity): Promise<{ response: JsonValue } | null> {
  const { principalId, sessionScope, method, operationKey } = identity.key
  const prior = await tx.query<{ payload_hash: string; response: JsonValue }>(
    'SELECT payload_hash,response FROM durable_runtime.rpc_receipts WHERE principal_id=$1 AND session_scope=$2 AND method=$3 AND operation_key=$4',
    [principalId, sessionScope, method, operationKey])
  if (!prior.rows[0]) { return null }
  if (prior.rows[0].payload_hash !== identity.payloadHash) { reject('RECEIPT_PAYLOAD_CONFLICT') }
  return { response: prior.rows[0].response }
}
