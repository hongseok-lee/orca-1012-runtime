import type { Pool, PoolClient } from 'pg'
import type { OperationRow, RuntimeUnitRow, RuntimeCommandRow, RuntimeEventProducerRow, RuntimeEventQueueRow } from '../db/rows.ts'
import { DurableDatabaseError, DurableTransaction, safeDatabaseError } from '../db/connection.ts'
import { CONTROLLER_DATASET, snapshotIdentity, type LeaseIdentity } from './instance.ts'

export type TakeoverOperation = Readonly<OperationRow> & {
  readonly kind: string; readonly controller_scope: string; readonly expected_pod_uid: string | null
  readonly external_resource_name: string | null; readonly deadline_at: Date | null; readonly retry_at: Date | null
  readonly terminal: boolean; readonly retry_due: boolean; readonly deadline_expired: boolean
}
export type TakeoverUnit = Readonly<RuntimeUnitRow> & {
  readonly last_work_event_at: Date | null; readonly idle_due_at: Date | null
  readonly observation_lost_at: Date | null; readonly reconcile_due_at: Date | null
  readonly attempt_status: string | null; readonly pod_uid: string | null
}
export type TakeoverCommand = Readonly<Omit<RuntimeCommandRow, 'input' | 'result' | 'evidence_refs'>>
export type TakeoverProducer = Readonly<RuntimeEventProducerRow>
export type TakeoverQueueHead = Readonly<Omit<RuntimeEventQueueRow, 'payload' | 'last_error'>> & {
  readonly runtime_unit_id: string; readonly retry_due: boolean; readonly claim_live: boolean
}
export type ControllerTakeoverSnapshot = {
  readonly lease: LeaseIdentity; readonly readAt: string
  readonly operations: readonly TakeoverOperation[]; readonly units: readonly TakeoverUnit[]
  readonly commands: readonly TakeoverCommand[]; readonly producers: readonly TakeoverProducer[]
  readonly queueHeads: readonly TakeoverQueueHead[]
}

// One repeatable, read-only snapshot. No locks/CAS/adoption/effects. Stored
// execution tokens are internal data, never execution grants or public logs.
export async function readControllerTakeoverSnapshot(pool: Pool,
  caller: LeaseIdentity): Promise<ControllerTakeoverSnapshot> {
  const identity = snapshotIdentity(caller)
  let client: PoolClient
  try { client = await pool.connect() } catch (error) { throw safeDatabaseError(error) }
  const tx = new DurableTransaction(client)
  let destroy = false
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const clock = await tx.query<{ now: Date }>(`SELECT clock_timestamp() AS now
      FROM durable_runtime.controller_leases WHERE scope=$1 AND owner=$2 AND term=$3 AND revision=$4
      AND expires_at>clock_timestamp()`, [identity.scope, identity.owner, identity.term, identity.revision])
    if (clock.rowCount !== 1) {throw new DurableDatabaseError('CONTROLLER_LEASE_STALE')}
    const operations = await tx.query<TakeoverOperation>(`SELECT o.id,o.runtime_unit_id,o.kind,o.intent_revision,
      o.controller_scope,o.controller_term,o.step,o.step_revision,o.expected_pod_uid,o.execution_epoch,
      o.external_resource_name,o.deadline_at,o.retry_at,o.revision,(o.result IS NOT NULL) AS terminal,
      (o.retry_at IS NULL OR o.retry_at<=clock_timestamp()) AS retry_due,
      (o.deadline_at IS NOT NULL AND o.deadline_at<=clock_timestamp()) AS deadline_expired
      FROM durable_runtime.operations o WHERE o.controller_scope=$1 AND (o.result IS NULL OR EXISTS(
        SELECT 1 FROM durable_runtime.runtime_commands c WHERE c.operation_id=o.id
        AND c.state IN ('ACCEPTED','EXECUTING','UNKNOWN')))
      ORDER BY coalesce(o.retry_at,o.deadline_at,'-infinity'::timestamptz),o.id`, [identity.scope])
    const units = await tx.query<TakeoverUnit>(`SELECT u.id,u.desired_mode,u.intent_revision,u.phase,u.execution_epoch,
      u.active_attempt_id,u.last_work_event_at,u.idle_due_at,u.observation_lost_at,u.reconcile_due_at,u.revision,
      a.status AS attempt_status,a.pod_uid FROM durable_runtime.runtime_units u LEFT JOIN durable_runtime.attempts a
        ON a.id=u.active_attempt_id AND a.runtime_unit_id=u.id
      WHERE u.dataset_name=$1 AND NOT EXISTS(SELECT 1 FROM durable_runtime.operations foreign_op
        WHERE foreign_op.runtime_unit_id=u.id AND foreign_op.result IS NULL AND foreign_op.controller_scope<>$2)
      ORDER BY u.id`, [CONTROLLER_DATASET, identity.scope])
    const commands = await tx.query<TakeoverCommand>(`SELECT c.id,c.operation_id,c.runtime_unit_id,c.command_name,
      c.original_controller_term,c.step_revision,c.pod_target,c.expected_pod_uid,c.execution_epoch,c.intent_revision,
      c.input_hash,c.state,c.owner_controller_term,c.executor_id,c.execution_token,c.revision,
      c.accepted_at,c.claimed_at,c.settled_at,c.refusal_code
      FROM durable_runtime.runtime_commands c JOIN durable_runtime.operations o ON o.id=c.operation_id
      WHERE o.controller_scope=$1 AND c.state IN ('ACCEPTED','EXECUTING','UNKNOWN') ORDER BY c.accepted_at,c.id`, [identity.scope])
    const unitIds = units.rows.map(row => row.id)
    const producers = await tx.query<TakeoverProducer>(`SELECT * FROM durable_runtime.runtime_event_producers
      WHERE runtime_unit_id=ANY($1::uuid[]) ORDER BY producer_id,incarnation`, [unitIds])
    const heads = await tx.query<TakeoverQueueHead>(`SELECT q.event_id,q.producer_id,q.incarnation,q.producer_seq,
      q.agent_id,q.committed_at,q.processed_at,q.state,q.attempt_count,q.retry_count,q.next_retry_at,q.terminal_at,
      q.claim_owner,q.claim_controller_term,q.claim_token,q.claim_expires_at,q.enqueue_transaction_id,p.runtime_unit_id,
      (q.next_retry_at IS NULL OR q.next_retry_at<=clock_timestamp()) AS retry_due,
      coalesce(q.claim_expires_at>clock_timestamp(),false) AS claim_live
      FROM durable_runtime.runtime_event_producers p JOIN durable_runtime.runtime_event_queue q
        ON q.producer_id=p.producer_id AND q.incarnation=p.incarnation AND q.producer_seq=p.processed_through+1
      WHERE p.runtime_unit_id=ANY($1::uuid[]) AND q.producer_seq<=p.committed_through
      AND q.state NOT IN ('DONE','FAILED') ORDER BY coalesce(q.next_retry_at,q.committed_at),q.event_id`, [unitIds])
    // Check DB time again after the read. Snapshot is still not permission for
    // a later mutation, which must use its original authority guard.
    if ((await tx.query(`SELECT scope FROM durable_runtime.controller_leases WHERE scope=$1 AND owner=$2
      AND term=$3 AND revision=$4 AND expires_at>clock_timestamp()`,
      [identity.scope, identity.owner, identity.term, identity.revision])).rowCount !== 1) {
      throw new DurableDatabaseError('CONTROLLER_LEASE_STALE')
    }
    const committed = await tx.query('COMMIT')
    if (committed.command !== 'COMMIT') {throw new DurableDatabaseError('TX_NOT_COMMITTED')}
    return { lease: identity, readAt: clock.rows[0].now.toISOString(),
      operations: Object.freeze(operations.rows.map(row => Object.freeze(row))),
      units: Object.freeze(units.rows.map(row => Object.freeze(row))),
      commands: Object.freeze(commands.rows.map(row => Object.freeze(row))),
      producers: Object.freeze(producers.rows.map(row => Object.freeze(row))),
      queueHeads: Object.freeze(heads.rows.map(row => Object.freeze(row))) }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { destroy = true }
    throw safeDatabaseError(error)
  } finally { tx.close(); client.release(destroy) }
}

/** Scheduling gate only; never reconstructs a command claim from a receipt. */
export async function assertLiveControllerLease(pool: Pool, caller: LeaseIdentity): Promise<void> {
  const identity = snapshotIdentity(caller)
  try {
    const result = await pool.query(`SELECT scope FROM durable_runtime.controller_leases
      WHERE scope=$1 AND owner=$2 AND term=$3 AND revision=$4 AND expires_at>clock_timestamp()`,
      [identity.scope, identity.owner, identity.term, identity.revision])
    if (result.rowCount !== 1) {throw new DurableDatabaseError('CONTROLLER_LEASE_STALE')}
  } catch (error) { throw safeDatabaseError(error) }
}
