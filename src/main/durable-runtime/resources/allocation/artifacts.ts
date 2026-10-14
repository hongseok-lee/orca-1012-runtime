import { randomUUID } from 'node:crypto'
import { logicalId } from '../../../../shared/durable-runtime/identity.ts'
import type { RuntimeUnitId, OperationId } from '../../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../../db/connection.ts'
import { DurableDatabaseError } from '../../db/connection.ts'
import type { JsonValue } from '../../db/atomic.ts'
import type { ControllerAuthority } from '../../lifecycle/types.ts'
import { fencedQuery } from './repository.ts'

export async function writeArtifacts(tx: DurableTransaction, input: {
  readonly actor: string; readonly unitId: RuntimeUnitId; readonly operationId: OperationId | null
  readonly revision: string; readonly kind: string; readonly body: JsonValue; readonly controller: ControllerAuthority
}): Promise<void> {
  if (!tx.isLockHeld(2, input.unitId)) { throw new DurableDatabaseError('RESOURCE_UNIT_LOCK_REQUIRED') }
  const eventId = logicalId('event', randomUUID()), auditId = randomUUID()
  const audit = await fencedQuery(tx, input.controller, `WITH observed AS (SELECT clock_timestamp() AS now)
    INSERT INTO durable_runtime.runtime_audit_events
    (id,actor_id,runtime_unit_id,operation_id,kind,next_state,occurred_at,received_at,producer_id,producer_seq,evidence_refs,payload)
    SELECT $1,$2,$3,$4,$5,$6::jsonb,now,now,$7,1,'[]'::jsonb,'{}'::jsonb FROM observed WHERE @lease RETURNING id`,
    [auditId, input.actor, input.unitId, input.operationId, input.kind, JSON.stringify(input.body), eventId])
  if (audit.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_AUDIT_WRITE_REJECTED') }
  const outbox = await fencedQuery(tx, input.controller, `INSERT INTO durable_runtime.outbox_events
    (id,aggregate_id,aggregate_kind,revision,event,created_at)
    SELECT $1,$2,'runtime-unit',$3,$4::jsonb,clock_timestamp() WHERE @lease RETURNING id`,
    [eventId, input.unitId, input.revision, JSON.stringify({ kind: input.kind, data: input.body, authority: 'DATA_ONLY' })])
  if (outbox.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_OUTBOX_WRITE_REJECTED') }
}
