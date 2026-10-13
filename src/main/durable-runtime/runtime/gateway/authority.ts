import type { ControllerTerm, ExecutionEpoch, IntentRevision, StepRevision } from '../../../../shared/durable-runtime/identity.ts';
import { DurableDatabaseError, type DurableTransaction } from '../../db/connection.ts';
import { lockAggregates } from '../../db/locks.ts';
import type { CommandEnvelope } from '../command-types.ts';
import type { PodUid } from '../runtime-evidence.ts';
import type { GatewayContext } from './types.ts';

interface AuthorityRows {
  unit_intent_revision: IntentRevision;
  unit_execution_epoch: ExecutionEpoch;
  operation_intent_revision: IntentRevision;
  operation_execution_epoch: ExecutionEpoch;
  operation_step_revision: StepRevision;
  operation_controller_term: ControllerTerm;
  operation_expected_pod_uid: PodUid | null;
  active_pod_uid: PodUid | null;
}

export class LockedGatewayAuthority {
  private constructor(
    readonly tx: DurableTransaction,
    readonly context: GatewayContext,
  ) {}

  static async acquire(tx: DurableTransaction, context: GatewayContext): Promise<LockedGatewayAuthority> {
    // Same aggregate order as DB owner; lease-only renewal/takeover must never
    // wait for Unit/operation after locking the lease (reverse-order deadlock).
    await lockAggregates(tx, { runtimeUnitIds: [context.runtimeUnitId], operationIds: [context.operationId] });
    const operation = await tx.query<{ controller_scope: string }>(
      'SELECT controller_scope FROM durable_runtime.operations WHERE id=$1 AND runtime_unit_id=$2',
      [context.operationId, context.runtimeUnitId],
    );
    if (operation.rowCount !== 1 || operation.rows[0].controller_scope !== context.controller.scope) {
      throw new DurableDatabaseError('COMMAND_OPERATION_SCOPE');
    }
    tx.advanceLock(5, context.controller.scope);
    await tx.query('SELECT scope FROM durable_runtime.controller_leases WHERE scope=$1 FOR UPDATE', [context.controller.scope]);
    const locked = new LockedGatewayAuthority(tx, context);
    await locked.assertCurrent();
    return locked;
  }

  async assertCurrent(): Promise<void> {
    // A fresh query after row-lock acquisition uses DB clock, including time
    // spent waiting. Do not reuse a pre-lock snapshot or application timestamp.
    const { controller } = this.context;
    const lease = await this.tx.query(
      `SELECT scope FROM durable_runtime.controller_leases
       WHERE scope=$1 AND owner=$2 AND term=$3 AND expires_at>clock_timestamp()`,
      [controller.scope, controller.owner, controller.term],
    );
    if (lease.rowCount !== 1) throw new DurableDatabaseError('COMMAND_AUTHORITY_STALE');
  }

  async assertExecutionTarget(envelope: CommandEnvelope, checkOriginalTerm: boolean): Promise<void> {
    const { operationId, runtimeUnitId, controller } = this.context;
    if (envelope.operationId !== operationId || (checkOriginalTerm && envelope.controllerTerm !== controller.term)) {
      throw new DurableDatabaseError('COMMAND_AUTHORITY_STALE');
    }
    const result = await this.tx.query<AuthorityRows>(
      `SELECT u.intent_revision AS unit_intent_revision,u.execution_epoch AS unit_execution_epoch,
       o.intent_revision AS operation_intent_revision,o.execution_epoch AS operation_execution_epoch,
       o.step_revision AS operation_step_revision,o.controller_term AS operation_controller_term,
       o.expected_pod_uid AS operation_expected_pod_uid,a.pod_uid AS active_pod_uid
       FROM durable_runtime.runtime_units u JOIN durable_runtime.operations o ON o.runtime_unit_id=u.id
       LEFT JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id
       WHERE u.id=$1 AND o.id=$2`,
      [runtimeUnitId, operationId],
    );
    const row = result.rows[0];
    if (!row || row.unit_intent_revision !== envelope.intentRevision || row.operation_intent_revision !== envelope.intentRevision ||
      row.unit_execution_epoch !== envelope.executionEpoch || row.operation_execution_epoch !== envelope.executionEpoch ||
      row.operation_step_revision !== envelope.stepRevision || row.operation_controller_term !== controller.term ||
      row.operation_expected_pod_uid !== envelope.expectedPodUid ||
      (envelope.podTarget === 'EXISTING_POD' && row.active_pod_uid !== envelope.expectedPodUid) ||
      (envelope.podTarget === 'CREATE_WITHOUT_POD' && (envelope.expectedPodUid !== null || row.active_pod_uid !== null))) {
      throw new DurableDatabaseError('COMMAND_TARGET_STALE');
    }
    await this.assertCurrent();
  }
}

// Mutation SQL also evaluates this predicate at write time, avoiding a lease
// expiry between the final authority query and the actual write.
export const currentAuthoritySql = `EXISTS(SELECT 1 FROM durable_runtime.controller_leases c
  WHERE c.scope=$1 AND c.owner=$2 AND c.term=$3 AND c.expires_at>clock_timestamp())`;
