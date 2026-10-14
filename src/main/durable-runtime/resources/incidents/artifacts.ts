import { randomUUID } from 'node:crypto'
import { logicalId, counter } from '../../../../shared/durable-runtime/identity.ts'
import type { RuntimeUnitId } from '../../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, type DurableTransaction } from '../../db/connection.ts'
import type { JsonValue } from '../../db/atomic.ts'
import { appendAudit, enqueueOutbox } from '../../journal/store.ts'

export async function writeIncidentArtifacts(tx: DurableTransaction, input: {
  actorId: string; unitId: RuntimeUnitId; attemptId: string; podUid: string;
  kind: string; reason: string | null; revision: string;
  evidenceIds: readonly string[]; previous: JsonValue; next: JsonValue
}): Promise<void> {
  if (!tx.isLockHeld(2, input.unitId)) { throw new DurableDatabaseError('INCIDENT_UNIT_LOCK_REQUIRED') }
  const time = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now
  const eventId = logicalId('event', randomUUID())
  await appendAudit(tx, { actorId: input.actorId, runtimeUnitId: input.unitId,
    attemptId: input.attemptId, podUid: input.podUid, kind: input.kind,
    reasonCode: input.reason ?? undefined, previousState: input.previous, nextState: input.next,
    occurredAt: time, receivedAt: time, producerId: randomUUID(),
    producerSeq: counter('sequence:producer', '1'), evidenceRefs: input.evidenceIds })
  await enqueueOutbox(tx, { eventId, aggregateId: input.unitId, aggregateKind: 'runtime-unit',
    revision: counter('row:failure-incident-state', input.revision),
    event: { kind: input.kind, runtimeUnitId: input.unitId, attemptId: input.attemptId,
      reasonCode: input.reason, decision: input.next, occurredAt: time.toISOString() } })
}
