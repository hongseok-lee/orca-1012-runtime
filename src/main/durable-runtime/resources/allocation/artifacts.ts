import { randomUUID } from 'node:crypto'
import { counter, logicalId } from '../../../../shared/durable-runtime/identity.ts'
import type { RuntimeUnitId, OperationId } from '../../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../../db/connection.ts'
import { DurableDatabaseError } from '../../db/connection.ts'
import type { JsonValue } from '../../db/atomic.ts'
import { appendAudit, enqueueOutbox } from '../../journal/store.ts'

export async function writeArtifacts(tx: DurableTransaction, input: {
  readonly actor: string; readonly unitId: RuntimeUnitId; readonly operationId: OperationId | null
  readonly revision: string; readonly kind: string; readonly body: JsonValue
}): Promise<void> {
  if (!tx.isLockHeld(2, input.unitId)) { throw new DurableDatabaseError('RESOURCE_UNIT_LOCK_REQUIRED') }
  const eventId = logicalId('event', randomUUID())
  const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now
  await appendAudit(tx, { actorId: input.actor, runtimeUnitId: input.unitId, operationId: input.operationId,
    kind: input.kind, previousState: null, nextState: input.body, occurredAt: now, receivedAt: now,
    producerId: eventId, producerSeq: counter('sequence:producer', '1'), evidenceRefs: [] })
  await enqueueOutbox(tx, { eventId, aggregateId: input.unitId, aggregateKind: 'runtime-unit',
    revision: counter('row:runtime-unit', input.revision), event: { kind: input.kind, data: input.body, authority: 'DATA_ONLY' } })
}
