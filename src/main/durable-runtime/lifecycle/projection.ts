import type { Pool } from 'pg'
import type { RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, withDurableTransaction, type DurableTransaction } from '../db/connection.ts'
import type { LifecycleOperation, MemberProjection, UnitProjection } from './types.ts'

/** One read-only SQL snapshot. No locks, receipts, activity/wake updates or UI
 * enum inputs; absent telemetry remains unverifiable rather than READY/idle. */
export async function readUnitProjection(pool: Pool, id: RuntimeUnitId): Promise<UnitProjection> {
  return withDurableTransaction(pool, tx => readUnitProjectionInTransaction(tx, id))
}

/** The caller owns isolation and lifetime; preserve the existing SQL and missing-row contract. */
export async function readUnitProjectionInTransaction(tx: DurableTransaction, id: RuntimeUnitId): Promise<UnitProjection> {
  const result = await tx.query<{ projection: UnitProjection }>(`SELECT jsonb_build_object(
      'unit', to_jsonb(u) || jsonb_build_object('intent_revision',u.intent_revision::text,
        'execution_epoch',u.execution_epoch::text,'revision',u.revision::text),
      'attempt', CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id',a.id,'podUid',a.pod_uid,'status',a.status) END,
      'observed',CASE WHEN u.observation_lost_at IS NOT NULL THEN 'unverifiable'
        WHEN a.id IS NULL THEN 'ABSENT' ELSE 'PRESENT_UNVERIFIED' END,
      'members',COALESCE((SELECT jsonb_agg(jsonb_build_object('sessionId',s.id,'lifecycle',s.lifecycle,
        'pendingCount',(SELECT count(*)::text FROM durable_runtime.messages x WHERE x.session_id=s.id
          AND x.intake_status IN ('DURABLE','DISPATCH_INTENT','STAGED') AND x.cancel_requested_at IS NULL),
        'inFlightCount',(SELECT count(*)::text FROM durable_runtime.delivery_attempts d WHERE d.session_id=s.id
          AND d.state IN ('DISPATCH_INTENT','STAGED','EFFECT_POSSIBLE','ADMITTED')),
        'historicalUnknownCount',(SELECT count(*)::text FROM durable_runtime.messages x
          WHERE x.session_id=s.id AND x.intake_status='UNKNOWN')) ORDER BY s.id)
        FROM durable_runtime.runtime_members m JOIN durable_runtime.sessions s ON s.id=m.session_id
        WHERE m.runtime_unit_id=u.id),'[]'::jsonb),
      'operations',COALESCE((SELECT jsonb_agg(to_jsonb(o)||jsonb_build_object('intent_revision',o.intent_revision::text,
        'execution_epoch',o.execution_epoch::text,'controller_term',o.controller_term::text,
        'step_revision',o.step_revision::text,'revision',o.revision::text) ORDER BY o.id)
        FROM durable_runtime.operations o WHERE o.runtime_unit_id=u.id AND o.result IS NULL),'[]'::jsonb)
      ) AS projection FROM durable_runtime.runtime_units u LEFT JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id WHERE u.id=$1`, [id])
  if (!result.rows[0]) {
    throw new DurableDatabaseError('LIFECYCLE_UNIT_MISSING')
  }
  // jsonb timestamps are ISO strings. Preserve exact stored values instead of
  // inventing freshness or current physical status from a query's success.
  return result.rows[0].projection
}

export type { LifecycleOperation, MemberProjection }
