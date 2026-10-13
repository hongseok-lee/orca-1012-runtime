import { logicalId } from '../../../../shared/durable-runtime/identity.ts'
import type { EventId, SessionId } from '../../../../shared/durable-runtime/identity.ts'
import type { ReceiptKey } from '../../db/atomic.ts'
import { DurableDatabaseError, type DurableTransaction } from '../../db/connection.ts'
import { evidenceDigest, prepareFailureObservation, text } from '../evidence/normalize.ts'
import type { FailureObservationInput, PreparedFailureObservation } from '../evidence/types.ts'

// The evidence owner alone defines observations and their normalization. This
// input boundary copies data; it neither authenticates a collector nor grants
// execution, recovery, or storage authority.
export interface IncidentCollectionPolicy {
  readonly revision: string
  readonly budgetMs: number
}
export interface IncidentIngressInput {
  readonly observation: FailureObservationInput
  readonly runtimeEventId: EventId | null
  readonly sessionIds: readonly SessionId[]
  readonly collectionPolicy: IncidentCollectionPolicy
  readonly receiptKey: ReceiptKey
}
export interface PreparedIncidentInput {
  readonly observation: PreparedFailureObservation
  readonly runtimeEventId: EventId | null
  readonly sessionIds: readonly SessionId[]
  readonly collectionPolicy: IncidentCollectionPolicy
  readonly receiptKey: Readonly<ReceiptKey>
  readonly payloadHash: string
}

/** Synchronous, validated snapshot to be made before the first SQL/lock await.
 * Computed identities come from the pinned normalization API, never a caller's
 * supplied digest, alias list, or canonical key. */
export function prepareIncidentInput(request: IncidentIngressInput): PreparedIncidentInput {
  const observation = prepareFailureObservation(request.observation)
  logicalId('failure-observation', observation.input.observationId)
  const runtimeEventId = request.runtimeEventId === null
    ? null : logicalId('event', request.runtimeEventId)
  if (!Array.isArray(request.sessionIds)) throw new DurableDatabaseError('INCIDENT_INPUT')
  const sessionIds = Object.freeze([...new Set(request.sessionIds.map(id => logicalId('session', id)))].sort())
  const policy = request.collectionPolicy
  if (typeof policy.budgetMs !== 'number' || !Number.isFinite(policy.budgetMs) || policy.budgetMs <= 0) {
    throw new DurableDatabaseError('INCIDENT_COLLECTION_POLICY')
  }
  const collectionPolicy = Object.freeze({
    revision: text(policy.revision, 'collection policy revision'), budgetMs: policy.budgetMs
  })
  const key = request.receiptKey
  const receiptKey = Object.freeze({
    principalId: text(key.principalId, 'receipt principal'),
    sessionScope: text(key.sessionScope, 'receipt scope'),
    method: text(key.method, 'receipt method'),
    operationKey: text(key.operationKey, 'receipt operation key')
  })
  const payloadHash = evidenceDigest({
    observationDigest: observation.payloadDigest, runtimeEventId, sessionIds, collectionPolicy
  })
  return Object.freeze({ observation, runtimeEventId, sessionIds, collectionPolicy, receiptKey, payloadHash })
}

/** The queue has advanced through lease/producer/queue locks already. The
 * incident store must reuse its actual Unit lock instead of acquiring a lower
 * rank lock here. Ingress acquires the same Unit through P1-03 up front. */
export function requireIncidentUnitLock(tx: DurableTransaction, input: PreparedIncidentInput): void {
  const unitId = input.observation.input.target.runtimeUnitId
  if (!tx.isLockHeld(2, unitId)) throw new DurableDatabaseError('INCIDENT_UNIT_LOCK_REQUIRED')
  for (const sessionId of input.sessionIds) {
    if (!tx.isLockHeld(1, sessionId)) throw new DurableDatabaseError('INCIDENT_SESSION_LOCK_REQUIRED')
  }
}
