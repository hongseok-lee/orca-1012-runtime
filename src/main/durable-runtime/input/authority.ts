import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import { withDurableTransaction, type DurableTransaction } from '../db/connection.ts'
import { inputScopeKey } from './canonical.ts'
import { InputStoreError, type InputAuthority } from './types.ts'

/** The upper layer's verified scope remains required even for replay/resolve. */
export async function assertInputScope(tx: DurableTransaction, authority: InputAuthority): Promise<void> {
  inputScopeKey(authority)
  const result = authority.scope.kind === 'SESSION'
    ? await tx.query('SELECT id FROM durable_runtime.sessions WHERE id=$1', [authority.sessionId])
    : await tx.query('SELECT session_id FROM durable_runtime.tabs WHERE terminal_handle=$1 AND session_id=$2',
      [authority.scope.terminalHandle, authority.sessionId])
  // Do not test current Session/Tab lifecycle here: old receipts still belong to this scope.
  if (result.rowCount !== 1) throw new InputStoreError('INPUT_SCOPE_DENIED')
}
export async function discoverInputUnit(pool: Pool, authority: InputAuthority): Promise<RuntimeUnitId | null> {
  return withDurableTransaction(pool, async (tx) => {
    await assertInputScope(tx, authority)
    const member = await tx.query<{ runtime_unit_id: string }>(
      'SELECT runtime_unit_id FROM durable_runtime.runtime_members WHERE session_id=$1', [authority.sessionId])
    return member.rows[0] ? logicalId('runtime-unit', member.rows[0].runtime_unit_id) : null
  })
}
export async function assertNewInputState(
  tx: DurableTransaction, authority: InputAuthority, fence: string, discovered: RuntimeUnitId | null
): Promise<RuntimeUnitId> {
  await assertInputScope(tx, authority)
  const state = await tx.query<{ lifecycle: string; session_fence: string; runtime_unit_id: string | null; desired_mode: string | null }>(
    `SELECT s.lifecycle,s.session_fence,m.runtime_unit_id,u.desired_mode
     FROM durable_runtime.sessions s LEFT JOIN durable_runtime.runtime_members m ON m.session_id=s.id
     LEFT JOIN durable_runtime.runtime_units u ON u.id=m.runtime_unit_id WHERE s.id=$1`, [authority.sessionId])
  const row = state.rows[0]
  if (!row || row.runtime_unit_id !== discovered) throw new InputStoreError('INPUT_MEMBERSHIP_CHANGED')
  if (row.lifecycle !== 'OPEN') throw new InputStoreError('INPUT_SESSION_CLOSED')
  if (row.session_fence !== fence) throw new InputStoreError('INPUT_STALE_FENCE')
  if (!discovered || !tx.isLockHeld(2, discovered)) throw new InputStoreError('INPUT_UNIT_UNAVAILABLE')
  if (row.desired_mode === 'DELETED') throw new InputStoreError('INPUT_UNIT_DELETED')
  if (authority.scope.kind === 'TERMINAL') {
    const tab = await tx.query('SELECT id FROM durable_runtime.tabs WHERE terminal_handle=$1 AND session_id=$2 AND lifecycle=\'OPEN\'',
      [authority.scope.terminalHandle, authority.sessionId])
    if (tab.rowCount !== 1) throw new InputStoreError('INPUT_TERMINAL_CLOSED')
  }
  return discovered
}
