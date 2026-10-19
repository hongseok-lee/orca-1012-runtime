import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { captureCatalogJson } from '../catalog/immutable.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { appendSessionEvent, enqueueOutbox } from '../journal/store.ts'
import type { JsonValue } from '../db/atomic.ts'
import type { EventHandler } from '../events/types.ts'
import type { CodexNativeNotification } from '../providers/codex/protocol.ts'
import type { ReadyProviderBinding } from '../providers/shared/contracts.ts'
import { immutableSnapshot } from '../providers/shared/recovery-renderer.ts'

export type TerminalCodexEvent = Readonly<{
  kind: 'TERMINAL_CODEX_NOTIFICATION'
  sessionId: string
  tabId: string
  terminalHandle: string
  providerBindingRevision: string
  nativeSessionRef: string
  notification: CodexNativeNotification
}>
export function terminalCodexPayload(binding: ReadyProviderBinding, notification: CodexNativeNotification): JsonValue {
  // A Claude provider's every frame is one claude/message notification.
  const provider = binding.providerRef.provider
  if ((provider !== 'codex' && provider !== 'claude') || (provider === 'claude') !== (notification.method === 'claude/message') ||
      binding.connectionInstanceId !== notification.connectionId) {
    throw new DurableDatabaseError('TERMINAL_OUTPUT_CONNECTION')
  }
  return immutableSnapshot(captureCatalogJson({ kind: 'TERMINAL_CODEX_NOTIFICATION', sessionId: binding.sessionId,
    tabId: binding.tabId, terminalHandle: binding.terminalHandle, providerBindingRevision: binding.providerBindingRevision,
    nativeSessionRef: binding.providerRef.nativeSessionRef, notification }))
}
export function parseTerminalCodexEvent(value: unknown): TerminalCodexEvent {
  const data = captureCatalogJson(value)
  if (data === null || typeof data !== 'object' || Array.isArray(data) || data.kind !== 'TERMINAL_CODEX_NOTIFICATION') {
    throw new DurableDatabaseError('TERMINAL_OUTPUT_FORMAT')
  }
  const text = (v: JsonValue | undefined): string => {
    if (typeof v !== 'string' || !v) { throw new DurableDatabaseError('TERMINAL_OUTPUT_FORMAT') }
    return v
  }
  const raw = data.notification
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { throw new DurableDatabaseError('TERMINAL_OUTPUT_FORMAT') }
  const sequence = counter('sequence:producer', text(raw.sequence))
  if (sequence === '0' || !Number.isFinite(Date.parse(text(raw.observedAt))) || raw.params === undefined) {
    throw new DurableDatabaseError('TERMINAL_OUTPUT_FORMAT')
  }
  return Object.freeze({ kind: 'TERMINAL_CODEX_NOTIFICATION', sessionId: logicalId('session', text(data.sessionId)),
    tabId: logicalId('tab', text(data.tabId)), terminalHandle: text(data.terminalHandle),
    providerBindingRevision: counter('row:provider-binding', text(data.providerBindingRevision)),
    nativeSessionRef: text(data.nativeSessionRef), notification: Object.freeze({connectionId: text(raw.connectionId),
      sequence, method: text(raw.method), params: raw.params, observedAt: text(raw.observedAt)}) })
}

/** Consumes the original P112 producer/claim. No alias, workload brand or execution permit is issued here. */
export const terminalCodexOutputEventHandler: EventHandler = async (tx, event) => {
  const payload = parseTerminalCodexEvent(event.payload)
  const sessionId = logicalId('session', payload.sessionId)
  if (event.targetSessionIds.length !== 1 || event.targetSessionIds[0] !== sessionId ||
      !tx.isLockHeld(1, sessionId) || !tx.isLockHeld(2, event.runtimeUnitId) || !tx.isLockHeld(7, event.eventId)) {
    throw new DurableDatabaseError('TERMINAL_OUTPUT_SCOPE_LOCK')
  }
  const found = await tx.query(
    `SELECT t.id FROM durable_runtime.tabs t
     JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id
     JOIN durable_runtime.sessions s ON s.id=t.session_id AND s.workspace_id=t.workspace_id
     JOIN durable_runtime.agents a ON a.id=s.agent_id
     JOIN durable_runtime.workspaces w ON w.id=t.workspace_id AND w.dataset_name=a.dataset_name
     WHERE t.id=$1 AND t.session_id=$2 AND s.agent_id=$3 AND t.kind='terminal'
       AND a.provider IN ('codex','claude') AND t.terminal_handle=$4 AND m.payload->>'id'=m.public_tab_id
       AND ((m.payload->>'status'='ready' AND m.payload->>'terminal'=t.terminal_handle)
         OR (m.payload->>'status'='pending-handle' AND m.payload->'terminal'='null'::jsonb))
       AND m.payload->>'type'='terminal'
       AND EXISTS(SELECT 1 FROM durable_runtime.runtime_audit_events l WHERE l.session_id=s.id
         AND l.runtime_unit_id=$5 AND l.kind='INITIAL_PROVIDER_READY'
         AND l.next_state->>'attemptId'=$6 AND l.next_state->>'podUid'=$7
         AND l.next_state->>'executionEpoch'=$8 AND l.next_state->>'providerBindingRevision'=$9
         AND l.next_state->>'connectionInstanceId'=$10
         AND l.next_state->'providerRef'->>'provider'=a.provider
         AND l.next_state->'providerRef'->>'nativeSessionRef'=$11)`,
    [payload.tabId, sessionId, event.agentId, payload.terminalHandle, event.runtimeUnitId, event.attemptId,
      event.podUid, event.executionEpoch, payload.providerBindingRevision, payload.notification.connectionId, payload.nativeSessionRef])
  // Historical output may be stored after close; neither this check nor append reopens a Tab/Session.
  if (found.rowCount !== 1) { throw new DurableDatabaseError('TERMINAL_OUTPUT_CATALOG_BINDING') }
  // A frame is (connection, host sequence). A replay after re-attach can carry
  // one already journaled (only observedAt differs): it is the same frame.
  const journaled = await tx.query(`SELECT 1 FROM durable_runtime.session_events WHERE session_id=$1
    AND body->>'kind'='TERMINAL_CODEX_NOTIFICATION' AND body->'notification'->>'connectionId'=$2
    AND body->'notification'->>'sequence'=$3 LIMIT 1`, [sessionId, payload.notification.connectionId, payload.notification.sequence])
  if (journaled.rowCount) { return }
  const body = captureCatalogJson(payload)
  const journal = await appendSessionEvent(tx, {sessionId,
    source: {kind: 'NATIVE', sourceKind: 'TERMINAL_CODEX_NOTIFICATION',
      provider: payload.notification.method === 'claude/message' ? 'claude' : 'codex',
      lineage: payload.notification.connectionId, nativeId: payload.notification.sequence}, body})
  await enqueueOutbox(tx, {eventId: journal.eventId, aggregateId: sessionId, aggregateKind: 'session',
    revision: counter('row:session', journal.sequence), event: body})
}
