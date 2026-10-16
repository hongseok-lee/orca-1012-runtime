import { counter, type ControllerTerm } from '../../../shared/durable-runtime/identity.ts';
import { DurableDatabaseError } from '../db/connection.ts';
import type { ExternalCommandIdentity } from './command-types.ts';
import type { LockedGatewayAuthority } from './gateway/authority.ts';
import { assertOriginal, originalIdentity } from './gateway/store.ts';
import type { CommandId, CommandRow, ExecutionToken, ExecutorId } from './gateway/types.ts';

/** Internal historical projection only. Not a CommandClaim or a permission to
 * execute/re-claim. Secret fields stay inside the locked assignment validator. */
export type InitialAgentOriginalExecution = Readonly<{
  commandId: CommandId;
  identity: ExternalCommandIdentity;
  executorId: ExecutorId;
  executionToken: ExecutionToken;
  firstClaimControllerTerm: ControllerTerm;
}>;
type ExecutionHistory = { controller_term: string; executor_id: string | null; execution_token: string | null };
function deny(): never { throw new DurableDatabaseError('INITIAL_AGENT_POD_ORIGINAL_HISTORY'); }

/** Caller holds the original command row and aggregate locks. The current owner
 * is checked separately from the unique initial EXECUTING history's claim term. */
export async function readInitialAgentOriginalExecution(
  authority: LockedGatewayAuthority, command: CommandRow,
): Promise<InitialAgentOriginalExecution> {
  const context = authority.context, current = authority.assertCurrent.bind(authority);
  const query = authority.tx.query.bind(authority.tx);
  const original = originalIdentity(command);
  const identity: ExternalCommandIdentity = Object.freeze({ ...original,
    originalEnvelope: Object.freeze({ ...original.originalEnvelope }) });
  const commandId = command.id, executorId = command.executor_id, executionToken = command.execution_token;
  const originalTerm = command.original_controller_term, ownerTerm = command.owner_controller_term;
  if (command.operation_id !== context.operationId || command.runtime_unit_id !== context.runtimeUnitId ||
      command.state !== 'EXECUTING' || ownerTerm !== context.controller.term || !executorId || !executionToken) { deny(); }
  assertOriginal(command, identity);
  await current();
  const history = await query<ExecutionHistory>(`SELECT controller_term,executor_id,execution_token
    FROM durable_runtime.runtime_command_history WHERE command_id=$1 AND stage='EXECUTING'`, [commandId]);
  if (history.rowCount !== 1) { deny(); }
  const first = history.rows[0];
  let firstClaimControllerTerm: ControllerTerm;
  try { firstClaimControllerTerm = counter('controller-term', first.controller_term); }
  catch { return deny(); }
  if (first.executor_id !== executorId || first.execution_token !== executionToken ||
      BigInt(firstClaimControllerTerm) < BigInt(originalTerm) || BigInt(firstClaimControllerTerm) > BigInt(ownerTerm)) { deny(); }
  await current();
  return Object.freeze({ commandId, identity, executorId, executionToken, firstClaimControllerTerm });
}
