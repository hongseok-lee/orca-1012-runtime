import type { JsonValue } from '../db/atomic.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { requireInputSessionLock } from '../input/composition.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { TerminalDraftStoreError } from './durable-contracts.ts'
import type { TerminalDraftBinding } from './types.ts'

/** Snapshot fence only; this data does not issue input or provider authority. */
export type ManagedCatalogTargetPin = Readonly<{
  tabId: string; tabRevision: string; bindingRevision: string
  provider: string | null; payload: JsonValue
}>

/** Hold the exact server mode/target through the intake COMMIT. */
export async function assertManagedCatalogTarget(
  tx: DurableTransaction, pin: ManagedCatalogTargetPin, binding: TerminalDraftBinding
): Promise<void> {
  requireInputSessionLock(tx, logicalId('session', binding.sessionId))
  const found = await tx.query(`SELECT t.id FROM durable_runtime.tabs t
    JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id
    JOIN durable_runtime.sessions s ON s.id=t.session_id
    JOIN durable_runtime.agents g ON g.id=s.agent_id
    WHERE t.id=$1 AND t.session_id=$2 AND t.terminal_handle=$3
      AND t.revision=$4 AND m.binding_revision=$5 AND m.payload=$6::jsonb
      AND g.provider=$7 AND g.provider IN ('claude','codex')
      AND m.payload->>'viewMode'='chat' AND t.lifecycle='OPEN'
    FOR SHARE OF t,m,g`, [pin.tabId, binding.sessionId, binding.logicalHandle,
    pin.tabRevision, pin.bindingRevision, pin.payload, pin.provider])
  if (found.rows.length !== 1) { throw new TerminalDraftStoreError('TERMINAL_CATALOG_TARGET_CHANGED') }
}
