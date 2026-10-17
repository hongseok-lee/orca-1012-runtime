import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import { NativeChatSession } from '../../../shared/rpc-contract/native-chat-params.ts'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../../../shared/execution-host.ts'
import type { CatalogRepositoryRow } from '../db/rows.ts'
import { withCatalogReadSnapshot, resolveCatalogWorkspace, type CatalogTab } from '../catalog/read.ts'
import { parseCatalogRepo, parseCatalogWorkspace, parseCatalogTab } from '../catalog/payload.ts'
import { projectCatalogWorktree } from '../catalog/projection.ts'
import { captureCatalogReadContext } from '../rpc/context.ts'
import type { CapturedCatalogReadConfig } from '../rpc/config.ts'
import { CatalogError } from '../catalog/errors.ts'
import { freezeJournalJson, journalSafeCounter, JournalReadError, type CommittedJournalEvent } from './model.ts'
import { readOriginalInputs } from './input-read.ts'
import { projectTerminalNativeHistory } from './terminal-native-projector.ts'
import { codexTurnUserItemId } from '../../codex/codex-structured-journal-translation-turns.ts'

/** Existing authenticated Catalog access; no structured scope brand, provider
 * call, filesystem fallback for a managed target, or wake is introduced. */
export async function readManagedTerminalNativeChat(config: CapturedCatalogReadConfig, original: unknown,
  context: RpcContext, knownHead?: string) {
  const params = NativeChatSession.parse(original), signal = context.signal
  const call = captureCatalogReadContext(config, context)
  function active() { config.assertCurrentHost(); if (signal?.aborted) { throw new CatalogError('TERMINAL_HISTORY_ABORTED') } }
  active()
  return withCatalogReadSnapshot(config.pool, async tx => {
    const selected = await tx.query<{id: string}>(
      `SELECT DISTINCT s.id FROM durable_runtime.sessions s
       LEFT JOIN durable_runtime.tabs t ON t.session_id=s.id
       WHERE s.id::text=$1 OR t.terminal_handle=$1 OR EXISTS(
         SELECT 1 FROM durable_runtime.runtime_audit_events l WHERE l.session_id=s.id
         AND l.kind='INITIAL_PROVIDER_READY' AND l.next_state->'providerRef'->>'nativeSessionRef'=$1)`, [params.sessionId])
    if (selected.rows.length === 0) { return null }
    if (selected.rows.length !== 1) { throw new CatalogError('TERMINAL_HISTORY_AMBIGUOUS') }
    const sessionId = logicalId('session', selected.rows[0].id)
    const result = await tx.query<CatalogTab & {public_id: string; agent_dataset: string; dataset_name: string;
      provider: string; journal_epoch: string; head: string; session_lifecycle: string}>(
      `SELECT m.*,t.workspace_id,t.session_id,t.kind,t.terminal_handle,t.lifecycle,t.revision AS tab_revision,
       w.public_id,w.dataset_name,a.provider,a.dataset_name AS agent_dataset,s.lifecycle AS session_lifecycle,
       s.journal_epoch::text,(s.next_event_seq-1)::text AS head
       FROM durable_runtime.tabs t JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id
       JOIN durable_runtime.sessions s ON s.id=t.session_id JOIN durable_runtime.agents a ON a.id=s.agent_id
       JOIN durable_runtime.workspaces w ON w.id=t.workspace_id AND w.id=s.workspace_id WHERE s.id=$1 AND t.kind='terminal'`, [sessionId])
    const row = result.rows[0]
    if (result.rows.length !== 1 || row.provider !== 'codex' || params.agent !== 'codex' || !row.terminal_handle ||
        row.lifecycle !== 'OPEN' || row.session_lifecycle !== 'OPEN') { throw new CatalogError('TERMINAL_HISTORY_TARGET_UNAVAILABLE') }
    const dataset = await tx.query<{dataset_name: string}>('SELECT dataset_name FROM durable_runtime.dataset_metadata')
    if (dataset.rows.length !== 1 || dataset.rows[0].dataset_name !== config.datasetName ||
        row.dataset_name !== config.datasetName || row.agent_dataset !== config.datasetName) { throw new CatalogError('CATALOG_DATASET_MISMATCH') }
    const workspace = await resolveCatalogWorkspace(tx, `id:${row.public_id}`, call.authority)
    if (workspace.workspace_id !== row.workspace_id || workspace.deleted_at !== null) { throw new CatalogError('TERMINAL_HISTORY_WORKSPACE') }
    parseCatalogWorkspace(workspace)
    let repo: ReturnType<typeof parseCatalogRepo> | undefined
    if (workspace.repo_id !== null) {
      const found = (await tx.query<CatalogRepositoryRow>('SELECT * FROM durable_runtime.catalog_repositories WHERE id=$1', [workspace.repo_id])).rows[0]
      if (!found) { throw new CatalogError('CATALOG_REPOSITORY_UNAVAILABLE') }
      repo = parseCatalogRepo(found)
      if (getRepoExecutionHostId(repo) !== config.hostId) { throw new CatalogError('CATALOG_REGISTRATION_HOST_MISMATCH') }
    }
    if (getWorktreeExecutionHostId(projectCatalogWorktree(workspace), repo) !== config.hostId) { throw new CatalogError('CATALOG_REGISTRATION_HOST_MISMATCH') }
    const tab = parseCatalogTab(row)
    if (tab.type !== 'terminal') { throw new CatalogError('TERMINAL_HISTORY_TARGET_UNAVAILABLE') }
    const epoch = counter('journal-epoch', row.journal_epoch), head = journalSafeCounter(row.head)
    const headKey = JSON.stringify([sessionId, epoch, head])
    active()
    if (knownHead === headKey) { return {kind: 'UNCHANGED' as const, headKey} }
    const rows = await tx.query<{event_id: string; source_key: string; seq: string; body: unknown; committed_at: string}>(
      `SELECT event_id,source_key,seq::text,body,committed_at::text FROM durable_runtime.session_events
       WHERE session_id=$1 AND journal_epoch=$2 AND seq<=$3 ORDER BY seq`, [sessionId, epoch, head])
    let last = 0
    const events: CommittedJournalEvent[] = rows.rows.map(event => {
      const seq = journalSafeCounter(event.seq, true)
      if (seq !== last + 1) { throw new JournalReadError('TERMINAL_HISTORY_JOURNAL_GAP') }
      last = seq
      return Object.freeze({eventId: event.event_id, sourceKey: event.source_key, sequence: seq,
        body: freezeJournalJson(event.body), committedAt: event.committed_at})
    })
    if (last !== head) { throw new JournalReadError('TERMINAL_HISTORY_JOURNAL_GAP') }
    const inputs = await readOriginalInputs(tx, {sessionId, publicSessionId: sessionId}, epoch, events)
    const echoes = await tx.query<{thread_id: string; turn_id: string}>(
      `SELECT DISTINCT l.next_state->'providerRef'->>'nativeSessionRef' AS thread_id,d.provider_ref AS turn_id
       FROM durable_runtime.delivery_attempts d JOIN durable_runtime.runtime_audit_events l
         ON l.session_id=d.session_id AND l.runtime_unit_id=d.runtime_unit_id AND l.kind='INITIAL_PROVIDER_READY'
         AND l.next_state->>'attemptId'=d.attempt_id::text AND l.next_state->>'executionEpoch'=d.execution_epoch::text
       WHERE d.session_id=$1 AND d.message_id=ANY($2::uuid[]) AND d.provider_ref IS NOT NULL
         AND d.state IN ('ADMITTED','SETTLED','INTERRUPTED') AND l.next_state->'providerRef'->>'provider'='codex'`,
      [sessionId, [...new Set(inputs.map(input => input.messageId))]])
    const projected = projectTerminalNativeHistory(sessionId, events, inputs,
      new Set(echoes.rows.map(row => codexTurnUserItemId(row.thread_id, row.turn_id))))
    const before = params.beforeOffset ?? Number.MAX_SAFE_INTEGER
    const eligible = projected.messages.filter(item => item.offset < before), limit = params.limit ?? 40
    let start = Math.max(0, eligible.length - limit)
    // Preserve every message from the boundary record: a numeric beforeOffset
    // always advances past a whole original committed record, never half of it.
    while (start > 0 && eligible[start - 1].offset === eligible[start].offset) { start-- }
    const page = eligible.slice(start)
    active()
    return {kind: 'PAGE' as const, headKey, epoch, messages: page.map(item => item.message),
      hasMore: eligible.length > page.length, beforeOffset: page[0]?.offset ?? 0,
      ...(params.beforeOffset === undefined && projected.lifecycle ? {lifecycle: projected.lifecycle} : {})}
  })
}
