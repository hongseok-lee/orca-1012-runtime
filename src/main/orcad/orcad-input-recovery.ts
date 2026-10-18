import type { Pool } from 'pg'
import { logicalId } from '../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError } from '../durable-runtime/db/connection.ts'
import { reconcileInputAfterOwnerLoss } from '../durable-runtime/input/owner-loss.ts'
import type { ControllerPassRequest } from '../durable-runtime/ha/pass.ts'
import { captureOrcadInputRecoveryTarget, type OrcadInputRecoveryTarget } from './orcad-controller-config.ts'

export type OrcadInputRecoverySnapshot = Readonly<{
  attempts: number
  last: Readonly<{ settlement: string; commitOutcome: string; cleanupFailed: boolean; disposition: string | null }> | null
}>

/** Trusted selector only. The existing live controller supplies authority and
 * the DB owner revalidates every original mapping under aggregate/lease locks. */
export function prepareOrcadInputRecovery(poolOwner: Pool, originalTarget: OrcadInputRecoveryTarget | null,
  owner: Readonly<{ isClosing(): boolean; assertCurrentHost(): void }>) {
  // null: every dispatch whose executing term was lost (the owner-loss check itself refuses a live term).
  const target = originalTarget ? captureOrcadInputRecoveryTarget(originalTarget) : null
  const connect = poolOwner.connect.bind(poolOwner), query = poolOwner.query.bind(poolOwner)
  const pool = new Proxy(poolOwner, { get(original, key) {
    if (key === 'connect') { return connect }
    if (key === 'query') { return query }
    return Reflect.get(original, key, original)
  } })
  const isClosing = owner.isClosing.bind(owner), assertCurrentHost = owner.assertCurrentHost.bind(owner)
  let attempts = 0, last: OrcadInputRecoverySnapshot['last'] = null
  const recoverInput: NonNullable<ControllerPassRequest['recoverInput']> = async (originalCommand, originalOperation, signal, originalContext) => {
    // Capture only internal selectors; a stored principal/token is never a new
    // InputAuthority, provider proof, claim or dispatch permission.
    const selected = Object.freeze({ id: originalCommand.id, token: originalCommand.execution_token,
      operationId: originalCommand.operation_id, runtimeUnitId: originalCommand.runtime_unit_id,
      command: originalCommand.command_name, kind: originalOperation.kind,
      snapshotOperationId: originalOperation.id, snapshotUnitId: originalOperation.runtime_unit_id })
    const context = Object.freeze({ ...originalContext, controller: Object.freeze({ ...originalContext.controller }) })
    const guard = (): void => {
      if (isClosing() || signal.aborted) { throw new DurableDatabaseError('CONTROLLER_INPUT_RECOVERY_CLOSED') }
      assertCurrentHost()
    }
    guard()
    const scope = target ?? { commandId: selected.id, operationId: selected.operationId, runtimeUnitId: selected.runtimeUnitId, sessionId: null }
    if (selected.id !== scope.commandId || selected.operationId !== scope.operationId ||
        selected.runtimeUnitId !== scope.runtimeUnitId || selected.command !== 'dispatchInput' ||
        selected.kind !== 'INPUT_DELIVERY' || selected.snapshotOperationId !== scope.operationId ||
        selected.snapshotUnitId !== scope.runtimeUnitId) { return { status: 'NOT_APPLICABLE' } }
    if (!selected.token || context.operationId !== scope.operationId || context.runtimeUnitId !== scope.runtimeUnitId) {
      throw new DurableDatabaseError('CONTROLLER_INPUT_RECOVERY_TARGET')
    }
    // Session is a strict activation selector, not authority. Message/delivery
    // come from the original dispatch command, never the latest native turn.
    const found = await query<{ input: unknown }>(`SELECT c.input FROM durable_runtime.runtime_commands c
      JOIN durable_runtime.messages m ON m.id::text=c.input->>'messageId'
      JOIN durable_runtime.delivery_attempts d ON d.id::text=c.input->>'deliveryAttemptId'
        AND d.message_id=m.id AND d.session_id=m.session_id
      WHERE c.id=$1 AND c.operation_id=$2 AND c.runtime_unit_id=$3 AND c.command_name='dispatchInput'
        AND ($4::uuid IS NULL OR m.session_id=$4) AND d.runtime_unit_id=$3`,
    [scope.commandId, scope.operationId, scope.runtimeUnitId, scope.sessionId])
    guard()
    if (found.rowCount !== 1) { throw new DurableDatabaseError('CONTROLLER_INPUT_RECOVERY_TARGET') }
    const input = found.rows[0].input
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype ||
        Reflect.ownKeys(input).length !== 2) { throw new DurableDatabaseError('CONTROLLER_INPUT_RECOVERY_TARGET') }
    const messageId: unknown = Object.getOwnPropertyDescriptor(input, 'messageId')?.value
    const deliveryId: unknown = Object.getOwnPropertyDescriptor(input, 'deliveryAttemptId')?.value
    if (typeof messageId !== 'string' || typeof deliveryId !== 'string') {
      throw new DurableDatabaseError('CONTROLLER_INPUT_RECOVERY_TARGET')
    }
    const request = Object.freeze({ context, commandId: logicalId('runtime-command', selected.id),
      executionToken: logicalId('runtime-command-execution', selected.token), messageId: logicalId('message', messageId),
      deliveryAttemptId: logicalId('delivery-attempt', deliveryId) })
    attempts++
    const result = await reconcileInputAfterOwnerLoss(pool, request)
    last = Object.freeze({ settlement: result.settlement, commitOutcome: result.commitOutcome,
      cleanupFailed: result.cleanupFailed, disposition: result.ok ? result.value.disposition : null })
    if (!result.ok) {
      // In LOST_OWNERS mode a refused candidate (e.g. a command this live term
      // executes) is not this recovery's; only an uncertain COMMIT stops the pass.
      if (!target && result.commitOutcome !== 'UNKNOWN' && result.settlement !== 'UNCONFIRMED') { return { status: 'NOT_APPLICABLE' } }
      if (result.commitOutcome === 'UNKNOWN' || result.settlement === 'UNCONFIRMED') {
        return { status: 'UNCERTAIN', settlement: result.settlement,
          commitOutcome: result.commitOutcome, cleanupFailed: result.cleanupFailed }
      }
      throw result.error
    }
    if (result.cleanupFailed) { throw new DurableDatabaseError('TX_CLEANUP_FAILED') }
    guard()
    return result.value.disposition === 'NOT_APPLICABLE' ? { status: 'NOT_APPLICABLE' }
      : { status: 'HANDLED', disposition: result.value.disposition }
  }
  return Object.freeze({ recoverInput, snapshot: (): OrcadInputRecoverySnapshot => Object.freeze({ attempts, last }) })
}
