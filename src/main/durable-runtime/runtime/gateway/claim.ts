import { randomUUID } from 'node:crypto';
import { logicalId } from '../../../../shared/durable-runtime/identity.ts';
import { DurableDatabaseError } from '../../db/connection.ts';
import { LockedGatewayAuthority, currentAuthoritySql } from './authority.ts';
import { canonicalInput } from './input.ts';
import { appendHistory, assertOriginal, commandById, originalIdentity } from './store.ts';
import type { ExternalCommandIdentity } from '../command-types.ts';
import type {
  ClaimResult, CommandClaim, CommandRow, ExecutorId, TerminalOutcome, VerifiedCommandReconciliation,
} from './types.ts';

export async function claimCommand(
  authority: LockedGatewayAuthority, original: ExternalCommandIdentity, executorId: ExecutorId,
): Promise<ClaimResult> {
  const { controller } = authority.context;
  const rows = await authority.tx.query<CommandRow>(
    `SELECT * FROM durable_runtime.runtime_commands
     WHERE operation_id=$1 AND runtime_unit_id=$2 AND step_revision=$3 AND command_name=$4`,
    [authority.context.operationId, authority.context.runtimeUnitId, original.originalEnvelope.stepRevision, original.command],
  );
  const row = rows.rows[0];
  if (!row) throw new DurableDatabaseError('COMMAND_NOT_FOUND');
  assertOriginal(row, original);
  await authority.assertCurrent();
  if (row.owner_controller_term !== controller.term) throw new DurableDatabaseError('COMMAND_ADOPTION_REQUIRED');
  if (row.state !== 'ACCEPTED') return { disposition: 'NOT_CLAIMABLE', command: row };
  await authority.assertExecutionTarget(original.originalEnvelope, false);
  if (!executorId) throw new DurableDatabaseError('COMMAND_EXECUTOR_INVALID');
  const executionToken = logicalId('runtime-command-execution', randomUUID());
  const updated = await authority.tx.query<CommandRow>(
    `UPDATE durable_runtime.runtime_commands SET state='EXECUTING',executor_id=$7,execution_token=$8,
     claimed_at=clock_timestamp(),revision=revision+1
     WHERE id=$4 AND runtime_unit_id=$5 AND revision=$6 AND owner_controller_term=$3
     AND state='ACCEPTED' AND execution_token IS NULL AND ${currentAuthoritySql} RETURNING *`,
    [controller.scope, controller.owner, controller.term, row.id, authority.context.runtimeUnitId,
      row.revision, executorId, executionToken],
  );
  const claimed = updated.rows[0];
  if (!claimed) throw new DurableDatabaseError('COMMAND_CLAIM_CONFLICT');
  await appendHistory(authority, claimed, 'EXECUTING');
  // This is provisional SQL state, not proof that COMMIT succeeded. P1-03 must
  // confirm durable claim commit before a future executor can attempt any I/O.
  return { disposition: 'CLAIMED', command: claimed, claim: {
    visibility: 'TRANSACTION_LOCAL', commandId: claimed.id, identity: originalIdentity(claimed),
    executorId, executionToken, controllerTerm: controller.term,
  } };
}

function assertClaim(row: CommandRow, claim: CommandClaim): void {
  assertOriginal(row, claim.identity);
  if (row.id !== claim.commandId || row.execution_token !== claim.executionToken || row.executor_id !== claim.executorId) {
    throw new DurableDatabaseError('COMMAND_EXECUTION_IDENTITY');
  }
}

export async function markCommandUnknown(authority: LockedGatewayAuthority, claim: CommandClaim): Promise<CommandRow> {
  const row = await commandById(authority, claim.commandId);
  assertClaim(row, claim);
  const { controller } = authority.context;
  if (row.owner_controller_term !== controller.term) throw new DurableDatabaseError('COMMAND_ADOPTION_REQUIRED');
  if (row.state === 'UNKNOWN') return row;
  if (row.state !== 'EXECUTING') throw new DurableDatabaseError('COMMAND_STATE_CONFLICT');
  const changed = await authority.tx.query<CommandRow>(
    `UPDATE durable_runtime.runtime_commands SET state='UNKNOWN',revision=revision+1
     WHERE id=$4 AND runtime_unit_id=$5 AND revision=$6 AND owner_controller_term=$3
     AND execution_token=$7 AND state='EXECUTING' AND ${currentAuthoritySql} RETURNING *`,
    [controller.scope, controller.owner, controller.term, row.id, authority.context.runtimeUnitId, row.revision, claim.executionToken],
  );
  const unknown = changed.rows[0];
  if (!unknown) throw new DurableDatabaseError('COMMAND_STATE_CONFLICT');
  await appendHistory(authority, unknown, 'UNKNOWN');
  return unknown;
}

async function storeTerminal(
  authority: LockedGatewayAuthority, row: CommandRow, outcome: TerminalOutcome,
): Promise<CommandRow> {
  const { controller } = authority.context;
  if (row.owner_controller_term !== controller.term) throw new DurableDatabaseError('COMMAND_ADOPTION_REQUIRED');
  const result = outcome.state === 'RESOLVED' ? canonicalInput(outcome.result) : null;
  const refusal = outcome.state === 'REFUSED' ? outcome.refusalCode : null;
  if (refusal !== null && !/^[A-Z][A-Z0-9_]*$/.test(refusal)) throw new DurableDatabaseError('COMMAND_REFUSAL_INVALID');
  const updated = await authority.tx.query<CommandRow>(
    `UPDATE durable_runtime.runtime_commands SET state=$8,result=$9::jsonb,refusal_code=$10,
     evidence_refs=$11::jsonb,settled_at=clock_timestamp(),revision=revision+1
     WHERE id=$4 AND runtime_unit_id=$5 AND revision=$6 AND execution_token=$7
     AND owner_controller_term=$3 AND state IN ('EXECUTING','UNKNOWN')
     AND ${currentAuthoritySql} RETURNING *`,
    [controller.scope, controller.owner, controller.term, row.id, authority.context.runtimeUnitId,
      row.revision, row.execution_token, outcome.state, result, refusal, JSON.stringify(outcome.evidenceRefs)],
  );
  const terminal = updated.rows[0];
  if (!terminal) throw new DurableDatabaseError('COMMAND_SETTLEMENT_CONFLICT');
  await appendHistory(authority, terminal, outcome.state);
  return terminal;
}

export async function settleOwnedExecution(
  authority: LockedGatewayAuthority, claim: CommandClaim, outcome: TerminalOutcome,
): Promise<CommandRow> {
  const row = await commandById(authority, claim.commandId);
  assertClaim(row, claim);
  if (claim.controllerTerm !== authority.context.controller.term || row.state !== 'EXECUTING') {
    throw new DurableDatabaseError('COMMAND_RECONCILIATION_REQUIRED');
  }
  return storeTerminal(authority, row, outcome);
}

export async function reconcileCommand(
  authority: LockedGatewayAuthority, verified: VerifiedCommandReconciliation,
): Promise<CommandRow> {
  const row = await commandById(authority, verified.commandId);
  assertOriginal(row, verified.original);
  if (row.execution_token !== verified.executionToken || !verified.executionEndedEvidenceRef ||
    (row.state !== 'EXECUTING' && row.state !== 'UNKNOWN')) {
    throw new DurableDatabaseError('COMMAND_RECONCILIATION_REQUIRED');
  }
  // A verified original-execution boundary is mandatory. No timeout, lease
  // expiry or arbitrary stored reference is converted into this verification.
  return storeTerminal(authority, row, {
    ...verified.outcome,
    evidenceRefs: [...verified.outcome.evidenceRefs, verified.executionEndedEvidenceRef],
  });
}
