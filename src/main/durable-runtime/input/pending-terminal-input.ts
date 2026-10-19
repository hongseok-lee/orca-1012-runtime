import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { JsonValue } from '../db/atomic.ts'
import type { CommittedTerminalInput } from './runtime-input-types.ts'

type Row = {
  input_id: string; authenticated_sender: string; terminal_handle: string; tab_id: string; tab_revision: string
  binding_revision: string; provider: string | null; payload: JsonValue; session_fence: string
  principal_id: string; session_scope: string; method: string; operation_key: string; payload_hash: string
  response: JsonValue; committed_at: Date; intake_at: Date | null
  floor_device: string; floor_principal: string; floor_connection: string; floor_generation: string; floor_mode: 'AGENT_CHAT_COMPAT' | 'RAW_TERMINAL'
}

/** Committed chat input of a session that no live owner dispatched yet: the
 * owner that accepted it was lost (backend restart). An adopted owner hands
 * these to its input runtime, which stages them exactly as at intake: the
 * origin fence re-checks this receipt, component, tab and session fence in
 * PG, and the current floor must still belong to the same principal. A
 * message already EFFECT_POSSIBLE/UNKNOWN is never selected, so nothing that
 * may have reached the provider is resent. */
export async function readPendingTerminalInputs(pool: Pool, sessionId: string): Promise<readonly CommittedTerminalInput[]> {
  const found = await pool.query<Row>(`SELECT DISTINCT ON (m.id) i.id AS input_id,i.authenticated_sender,t.terminal_handle,
      t.id AS tab_id,t.revision::text AS tab_revision,c.binding_revision::text,g.provider,c.payload,s.session_fence::text,
      r.principal_id,r.session_scope,r.method,r.operation_key,r.payload_hash,r.response,r.committed_at,r.intake_at,
      f.paired_device_id AS floor_device,f.principal_id AS floor_principal,f.connection_id AS floor_connection,
      f.floor_generation::text,f.mode AS floor_mode
    FROM durable_runtime.messages m
    JOIN durable_runtime.input_components i ON i.message_id=m.id AND i.session_id=m.session_id
    JOIN durable_runtime.sessions s ON s.id=m.session_id AND s.lifecycle='OPEN'
    JOIN durable_runtime.agents g ON g.id=s.agent_id
    JOIN durable_runtime.tabs t ON t.session_id=s.id AND t.kind='terminal' AND t.lifecycle='OPEN'
    JOIN durable_runtime.catalog_tab_metadata c ON c.tab_id=t.id
    JOIN durable_runtime.terminal_input_floors f ON f.terminal_handle=t.terminal_handle AND f.session_id=s.id
    JOIN durable_runtime.rpc_receipts r ON r.method='terminal.send' AND r.operation_key=i.client_operation_id
      AND r.principal_id=i.authenticated_sender AND r.response->>'kind'='SUBMITTED'
      AND r.response->'input'->>'inputId'=i.id::text AND r.response->'input'->>'messageId'=m.id::text
    WHERE m.session_id=$1 AND m.intake_status='DURABLE' AND m.cancel_revision=0
    ORDER BY m.id,i.input_seq DESC`, [sessionId])
  const inputs: CommittedTerminalInput[] = []
  for (const row of found.rows) {
    if (row.floor_principal !== row.authenticated_sender) { continue }
    inputs.push(Object.freeze({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the authenticated sender recorded with this exact receipt; the origin fence re-checks it in PG.
      authority: Object.freeze({ principal: row.authenticated_sender as never, sessionId: logicalId('session', sessionId),
        scope: Object.freeze({ kind: 'TERMINAL' as const, terminalHandle: row.terminal_handle }) }),
      binding: Object.freeze({ pairedDeviceId: row.floor_device, principalId: row.floor_principal, logicalHandle: row.terminal_handle,
        sessionId, connectionId: row.floor_connection, floorGeneration: row.floor_generation, mode: row.floor_mode }),
      targetPin: Object.freeze({ tabId: row.tab_id, tabRevision: row.tab_revision, bindingRevision: row.binding_revision,
        provider: row.provider, payload: row.payload }),
      sessionFence: counter('session-fence', row.session_fence),
      receipt: Object.freeze({ key: Object.freeze({ principalId: row.principal_id, sessionScope: row.session_scope, method: row.method,
        operationKey: row.operation_key }), payloadHash: row.payload_hash, response: row.response,
        recordedAt: row.committed_at, intakeAt: row.intake_at }),
    }))
  }
  return Object.freeze(inputs)
}
