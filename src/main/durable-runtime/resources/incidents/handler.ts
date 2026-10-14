import { logicalId, counter } from '../../../../shared/durable-runtime/identity.ts'
import type { JsonValue } from '../../db/atomic.ts'
import { DurableDatabaseError, type DurableTransaction } from '../../db/connection.ts'
import type { EventRecord } from '../../events/types.ts'
import type { VerifiedEvidence } from '../../runtime/runtime-evidence.ts'
import type { FailureObservationInput } from '../evidence/types.ts'
import { snapshotJson, text, evidenceDigest } from '../evidence/normalize.ts'
import { prepareIncidentInput } from './prepare.ts'
import type { IncidentCollectionPolicy } from './prepare.ts'
import { recordFailureEvidence } from './store.ts'
import type { RecordFailureResult } from './types.ts'

export type FailureEventDecoder = (original: EventRecord) => {
  readonly observation: FailureObservationInput
  readonly verifiedSource: VerifiedEvidence | null
}

function snapshotEvent(event: EventRecord): EventRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The evidence owner validates and deeply copies JSON; P112's mutable JsonValue type is used only for this frozen read-only callback.
  const payload = snapshotJson(event.payload) as unknown as JsonValue
  return Object.freeze({ eventId: logicalId('event', event.eventId), producerId: logicalId('producer', event.producerId),
    incarnation: event.incarnation, sequence: counter('sequence:producer', event.sequence),
    agentId: logicalId('agent', event.agentId), runtimeUnitId: logicalId('runtime-unit', event.runtimeUnitId),
    attemptId: logicalId('attempt', event.attemptId), podUid: event.podUid,
    executionEpoch: counter('execution-epoch', event.executionEpoch), payload,
    targetSessionIds: Object.freeze(event.targetSessionIds.map(id => logicalId('session', id))),
    // P112's original record converts the BIGINT driver string to Number.
    // Use that same representation for the immutable PG re-read comparison.
    attemptCount: Number(event.attemptCount) })
}

/** Adapter for P112's original PG EventRecord, not a caller's EventClaim.
 * Decode/verification is an injected synchronous boundary. It must perform no
 * K8s/cgroup/network I/O here and must not create authority from payload flags.
 * Actual authenticated collector wiring remains an explicit integration gate. */
export async function handleFailureEvidenceEvent(tx: DurableTransaction, event: EventRecord, options: {
  readonly collectionPolicy: IncidentCollectionPolicy
  readonly decode: FailureEventDecoder
}): Promise<RecordFailureResult> {
  const supplied = snapshotEvent(event)
  const policy = Object.freeze({ revision: text(options.collectionPolicy.revision, 'collection policy revision'),
    budgetMs: options.collectionPolicy.budgetMs })
  const decode = options.decode
  if (!Number.isFinite(policy.budgetMs) || policy.budgetMs <= 0 || typeof decode !== 'function') {
    throw new DurableDatabaseError('INCIDENT_INPUT')
  }
  if (!tx.isLockHeld(7, supplied.eventId) || !tx.isLockHeld(2, supplied.runtimeUnitId)) {
    throw new DurableDatabaseError('INCIDENT_QUEUE_LOCK_REQUIRED')
  }
  const found = await tx.query<EventRecord>(
    `SELECT q.event_id AS "eventId",q.producer_id AS "producerId",q.incarnation,q.producer_seq AS sequence,
     q.agent_id AS "agentId",p.runtime_unit_id AS "runtimeUnitId",p.attempt_id AS "attemptId",
     p.pod_uid AS "podUid",p.execution_epoch AS "executionEpoch",q.payload,q.attempt_count AS "attemptCount",
     COALESCE((SELECT array_agg(t.session_id ORDER BY t.session_id) FROM durable_runtime.runtime_event_targets t
       WHERE t.event_id=q.event_id),'{}'::uuid[]) AS "targetSessionIds"
     FROM durable_runtime.runtime_event_queue q JOIN durable_runtime.runtime_event_producers p
       ON p.producer_id=q.producer_id AND p.incarnation=q.incarnation WHERE q.event_id=$1`, [supplied.eventId])
  if (!found.rows[0]) { throw new DurableDatabaseError('INCIDENT_EVENT_MISSING') }
  const original = snapshotEvent(found.rows[0])
  if (evidenceDigest(original) !== evidenceDigest(supplied)) { throw new DurableDatabaseError('INCIDENT_EVENT_RECORD_CONFLICT') }
  text(original.incarnation, 'original event incarnation')
  text(original.podUid, 'original event pod uid')
  if (!tx.isLockHeld(7, original.eventId) || !tx.isLockHeld(2, original.runtimeUnitId)) {
    throw new DurableDatabaseError('INCIDENT_QUEUE_LOCK_REQUIRED')
  }
  const decoded = decode(original)
  const input = prepareIncidentInput({ observation: decoded.observation, verifiedSource: decoded.verifiedSource,
    runtimeEventId: original.eventId, sessionIds: original.targetSessionIds,
    collectionPolicy: policy,
    receiptKey: { principalId: original.producerId, sessionScope: `runtime-event:${original.eventId}`,
      method: 'runtime-event.failure-evidence', operationKey: original.eventId } })
  const t = input.observation.input.target
  if (t.runtimeUnitId !== original.runtimeUnitId || t.attemptId !== original.attemptId ||
      t.podUid !== original.podUid || t.executionEpoch !== original.executionEpoch ||
      (t.incarnation !== null && t.incarnation !== original.incarnation)) {
    throw new DurableDatabaseError('INCIDENT_EVENT_BINDING_CONFLICT')
  }
  // P112 owns its receipt and final DONE/FAILED decision. This same-TX function
  // never begins/commits another transaction or acquires a lower rank lock.
  return recordFailureEvidence(tx, input)
}
