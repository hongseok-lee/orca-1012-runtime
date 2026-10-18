import { randomUUID } from 'node:crypto'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { RuntimeTerminalNativeChatSession } from '../../../shared/runtime-mobile-session-tab-contracts.ts'
import type { DurableTransaction } from '../db/connection.ts'
import type { ReadyProviderBinding } from '../providers/shared/contracts.ts'
import type { CatalogTab } from './read.ts'
import { CatalogError } from './errors.ts'
import { advanceCatalogProjection } from './heads.ts'
import { enqueueOutbox } from '../journal/store.ts'

const invalid = (): never => { throw new CatalogError('CATALOG_NATIVE_SESSION_REFERENCE') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return invalid() }
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) { return invalid() }
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 31 || code === 127) { return invalid() }
  }
  return value
}
function decimal(value: unknown): string {
  const result = text(value)
  if (!/^(0|[1-9][0-9]*)$/.test(result)) { return invalid() }
  return result
}
type ReadyRow = {
  tab_id: string; workspace_id: string; session_id: string; terminal_handle: string;
  tab_lifecycle: string; session_lifecycle: string; deleted_at: Date | null;
  provider: string; binding_revision: string; workspace_dataset: string; agent_dataset: string; unit_dataset: string;
  unit_id: string; audit_id: string; audit_unit: string; audit_operation: string;
  audit_attempt: string | null; audit_pod: string | null; next_state: unknown;
  attempt_id: string | null; attempt_unit: string | null; attempt_pod: string | null;
  attempt_epoch: string | null; ready_at: Date | null;
  operation_unit: string | null; operation_epoch: string | null; operation_result: unknown;
  outbox_matches: boolean | null; outbox_kind: string | null; outbox_unit: string | null;
}
async function readyRows(tx: DurableTransaction, ids: readonly string[]): Promise<ReadyRow[]> {
  if (!ids.length) { return [] }
  return (await tx.query<ReadyRow>(`SELECT t.id AS tab_id,t.workspace_id,t.session_id,t.terminal_handle,
    t.lifecycle AS tab_lifecycle,s.lifecycle AS session_lifecycle,w.deleted_at,g.provider,
    s.provider_binding_revision::text AS binding_revision,w.dataset_name AS workspace_dataset,
    g.dataset_name AS agent_dataset,u.dataset_name AS unit_dataset,u.id AS unit_id,
    a.id AS audit_id,a.runtime_unit_id AS audit_unit,a.operation_id AS audit_operation,
    a.attempt_id AS audit_attempt,a.pod_uid AS audit_pod,a.next_state,
    p.id AS attempt_id,p.runtime_unit_id AS attempt_unit,p.pod_uid AS attempt_pod,
    p.execution_epoch::text AS attempt_epoch,p.ready_at,
    op.runtime_unit_id AS operation_unit,op.execution_epoch::text AS operation_epoch,op.result AS operation_result,
    b.event=a.next_state AS outbox_matches,b.aggregate_kind AS outbox_kind,b.aggregate_id AS outbox_unit
    FROM durable_runtime.tabs t JOIN durable_runtime.catalog_tab_metadata meta ON meta.tab_id=t.id
    JOIN durable_runtime.sessions s ON s.id=t.session_id AND s.workspace_id=t.workspace_id
    JOIN durable_runtime.agents g ON g.id=s.agent_id
    JOIN durable_runtime.workspaces w ON w.id=t.workspace_id
    JOIN durable_runtime.runtime_members m ON m.session_id=s.id
    JOIN durable_runtime.runtime_units u ON u.id=m.runtime_unit_id
    JOIN durable_runtime.runtime_audit_events a ON a.session_id=s.id AND a.kind='INITIAL_PROVIDER_READY'
    LEFT JOIN durable_runtime.attempts p ON p.id::text=a.next_state->>'attemptId' AND p.runtime_unit_id=a.runtime_unit_id
    LEFT JOIN durable_runtime.operations op ON op.id=a.operation_id
    LEFT JOIN durable_runtime.outbox_events b ON b.id=a.id
    WHERE t.id=ANY($1::uuid[]) AND t.kind='terminal' ORDER BY t.id,a.id`, [ids])).rows
}
function originalReady(row: ReadyRow): RuntimeTerminalNativeChatSession | undefined {
  const provider = row.provider
  if ((provider !== 'codex' && provider !== 'claude') || row.tab_lifecycle !== 'OPEN' || row.session_lifecycle !== 'OPEN' || row.deleted_at !== null) { return undefined }
  const event = object(row.next_state)
  if (decimal(event.providerBindingRevision) !== row.binding_revision) { return undefined }
  const ref = object(event.providerRef), operation = object(row.operation_result)
  const connection = text(event.connectionInstanceId), attempt = text(event.attemptId), epoch = decimal(event.executionEpoch)
  const pod = text(event.podUid), native = text(ref.nativeSessionRef)
  if (event.kind !== 'INITIAL_PROVIDER_READY' || ref.provider !== provider || !connection ||
      row.workspace_dataset !== row.agent_dataset || row.workspace_dataset !== row.unit_dataset ||
      row.audit_unit !== row.unit_id || row.attempt_unit !== row.unit_id || row.operation_unit !== row.unit_id ||
      row.attempt_id !== attempt || row.attempt_pod !== pod || row.attempt_epoch !== epoch || row.operation_epoch !== epoch ||
      row.ready_at === null || (row.audit_attempt !== null && row.audit_attempt !== attempt) ||
      (row.audit_pod !== null && row.audit_pod !== pod) || !row.outbox_matches ||
      row.outbox_kind !== 'runtime-unit' || row.outbox_unit !== row.unit_id ||
      operation.state !== 'SUCCEEDED' || operation.ready !== true || !Array.isArray(operation.providerBindings) ||
      operation.providerBindings.length !== 1) { return invalid() }
  const settled = object(operation.providerBindings[0])
  if (settled.provider !== provider || settled.nativeSessionRef !== native) { return invalid() }
  // The original audit/outbox pair carries the connection lineage. No current
  // activity, live attempt/grant or provider process is inferred from this ID.
  return Object.freeze({ agent: provider, sessionId: native })
}
function uniqueReady(rows: readonly ReadyRow[]): Map<string, { row: ReadyRow; identity: RuntimeTerminalNativeChatSession }> {
  const selected = new Map<string, { row: ReadyRow; identity: RuntimeTerminalNativeChatSession }>()
  for (const row of rows) {
    const identity = originalReady(row)
    if (!identity) { continue }
    if (selected.has(row.tab_id)) { throw new CatalogError('CATALOG_NATIVE_SESSION_AMBIGUOUS') }
    selected.set(row.tab_id, { row, identity })
  }
  return selected
}

/** Caller supplies only authorization-filtered rows, inside its original RR. */
export async function enrichCatalogTerminalNativeSessions(tx: DurableTransaction, tabs: readonly CatalogTab[]): Promise<CatalogTab[]> {
  const ids = tabs.filter(tab => tab.kind === 'terminal' && tab.lifecycle === 'OPEN' && tab.session_id !== null).map(tab => tab.tab_id)
  const ready = uniqueReady(await readyRows(tx, ids))
  return tabs.map(tab => {
    const found = ready.get(tab.tab_id)
    if (!found) { return tab }
    if (found.row.session_id !== tab.session_id || found.row.workspace_id !== tab.workspace_id ||
        found.row.terminal_handle !== tab.terminal_handle) { return invalid() }
    return { ...tab, terminal_native_chat_session: found.identity }
  })
}

/** Backend calls after its original READY audit/outbox and lower-rank locks.
 * This publishes the committed read identity, never issues a principal/permit. */
export async function publishCatalogTerminalNativeSessionReady(
  tx: DurableTransaction, readyAuditId: string, binding: ReadyProviderBinding
): Promise<void> {
  if (!tx.isLockHeld(1, binding.sessionId) || !tx.isLockHeld(2, binding.runtimeUnitId)) {
    throw new CatalogError('CATALOG_NATIVE_SESSION_LOCK_REQUIRED')
  }
  const found = uniqueReady(await readyRows(tx, [binding.tabId])).get(binding.tabId)
  if (!found || found.row.audit_id !== readyAuditId || found.row.session_id !== binding.sessionId ||
      found.row.unit_id !== binding.runtimeUnitId || found.row.terminal_handle !== binding.terminalHandle ||
      found.identity.sessionId !== binding.providerRef.nativeSessionRef || binding.providerRef.provider !== found.identity.agent) { return invalid() }
  const original = object(found.row.next_state)
  if (original.attemptId !== binding.attemptId || original.podUid !== binding.podUid ||
      original.executionEpoch !== binding.executionEpoch || original.providerBindingRevision !== binding.providerBindingRevision ||
      original.connectionInstanceId !== binding.connectionInstanceId) { return invalid() }
  const workspace = logicalId('workspace', found.row.workspace_id)
  const heads = await advanceCatalogProjection(tx, ['catalog', `workspace:${workspace}`])
  const global = heads.find(head => head.scope === 'catalog')!
  await enqueueOutbox(tx, { eventId: logicalId('event', randomUUID()), aggregateId: workspace, aggregateKind: 'catalog',
    revision: counter('row:catalog-head', global.revision), event: { kind: 'CATALOG_TERMINAL_NATIVE_SESSION_READY',
      detail: { readyAuditId, sessionId: binding.sessionId, tabId: binding.tabId,
        providerBindingRevision: binding.providerBindingRevision } } })
}
