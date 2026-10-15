import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { AgentSessionHistoryRequest, AgentSessionHistoryResult } from '../../../shared/agent-session-wire'
import type { CatalogHeadRow, CatalogRepositoryRow, CatalogProjectGroupRow, CatalogUiStateRow } from '../db/rows.ts'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { DurableTransaction, safeDatabaseError } from '../db/connection.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { captureCatalogParsed } from '../catalog/immutable.ts'
import { catalogWorkspaceAllowed, loadCatalogWorkspaces, type CatalogSnapshot, type CatalogTab } from '../catalog/read.ts'
import { catalogSnapshotVersion } from '../catalog/revision.ts'
import { parseCatalogRepo, parseCatalogGroup, parseCatalogWorkspace, parseCatalogTab } from '../catalog/payload.ts'
import { jsonValue } from '../structured/durable-common.ts'
import { prepareStructuredWire } from '../structured/wire.ts'
import { checkStructuredCapabilities } from '../structured/capabilities.ts'
import { journalSafeCounter, type VerifiedJournalReadScope } from '../output/model.ts'
import { readStructuredHistoryInTransaction } from '../output/structured-history.ts'
import { supportsStructuredAgentSessions, isStructuredNativeChatEnabled } from '../../runtime/rpc/methods/structured-agent-session-policy'
import { projectBackgroundTaskHistory } from '../../runtime/rpc/methods/structured-agent-session-background-task-capability'
import { projectTurnItemHistory } from '../../runtime/rpc/methods/structured-agent-session-turn-item-capability'
import { captureCatalogReadContext } from './context.ts'
import { validateCatalogSnapshot } from './read.ts'
import { CatalogReadError, type CapturedCatalogReadConfig } from './config.ts'

export const CATALOG_STRUCTURED_HISTORY_METHODS = Object.freeze(['agentSession.history'] as const)
export type StructuredHistoryReadInput = Readonly<Pick<RpcContext,
  'runtime' | 'authenticatedCallerFingerprint' | 'clientKind' | 'clientCapabilities'> & {
  structuredNativeChatEnabled: boolean
  sessionId?: string
}>
/** Same upper authority issuer and RR body as history; a stream captures policy once. */
export function createCatalogStructuredHistoryReaderOwner(config: CapturedCatalogReadConfig) {
  const connect = config.pool.connect.bind(config.pool)
  return { capture(input: StructuredHistoryReadInput) {
    const fingerprint = input.authenticatedCallerFingerprint, clientKind = input.clientKind
    const capabilities = Object.freeze([...(input.clientCapabilities ?? [])])
    const structuredEnabled = input.structuredNativeChatEnabled
    const selectedSession = input.sessionId
    const policy = Object.freeze({ clientKind, clientCapabilities: capabilities, structuredNativeChatEnabled: structuredEnabled })
    const call = captureCatalogReadContext(config, { runtime: input.runtime, authenticatedCallerFingerprint: fingerprint,
      clientKind, clientCapabilities: capabilities })
    if (!supportsStructuredAgentSessions(policy)) { throw new CatalogReadError('structured_agent_session_unsupported') }
    if (typeof fingerprint !== 'string') { throw new CatalogReadError('CATALOG_AUTHENTICATED_CALLER_REQUIRED') }
    const principal = fingerprintAttachmentPrincipal(fingerprint)
    return async (params: unknown): Promise<AgentSessionHistoryResult> => {
    const prepared = prepareStructuredWire('agentSession.history', params, capabilities)
    if (!prepared.ok || prepared.value.target.kind !== 'SESSION') { throw new CatalogReadError('STRUCTURED_HISTORY_UNREADABLE') }
    // Already strict-schema parsed; reconstruct only the real history request.
    const wire = prepared.value.params, direction = wire.direction
    if (direction !== 'tail' && direction !== 'before' && direction !== 'after') { throw new CatalogReadError('STRUCTURED_HISTORY_UNREADABLE') }
    const publicSessionId = prepared.value.target.publicSessionId
    if (selectedSession !== undefined && publicSessionId !== selectedSession) { throw new CatalogReadError('STRUCTURED_HISTORY_ALIAS_SCOPE') }
    let cursor: AgentSessionHistoryRequest['cursor']
    if (wire.cursor !== undefined) {
      const value = jsonValue(wire.cursor)
      if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        typeof value.epoch !== 'string' || typeof value.sequence !== 'number' ||
        !Number.isSafeInteger(value.sequence) || value.sequence < 0) { throw new CatalogReadError('STRUCTURED_HISTORY_UNREADABLE') }
      cursor = { epoch: value.epoch, sequence: value.sequence }
    }
    const request = captureCatalogParsed<AgentSessionHistoryRequest>({ sessionId: publicSessionId, direction,
      ...(cursor ? { cursor } : {}), ...(typeof wire.limit === 'number' ? { limit: wire.limit } : {}) })
    const client = await connect().catch(error => { throw safeDatabaseError(error) })
    const tx = new DurableTransaction(client)
    let destroy = false, committed = false
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      // Actual Catalog rows in this same snapshot; existing parsers/allowlist/host policy.
      const heads = (await tx.query<CatalogHeadRow>('SELECT * FROM durable_runtime.catalog_heads ORDER BY scope')).rows
      for (const head of heads) { catalogSnapshotVersion(head.revision) }
      const repositories = (await tx.query<CatalogRepositoryRow>('SELECT * FROM durable_runtime.catalog_repositories WHERE deleted_at IS NULL ORDER BY id'))
        .rows.filter(row => call.authority.repositoryIds.includes(row.id)).map(parseCatalogRepo)
      const projectGroups = (await tx.query<CatalogProjectGroupRow>('SELECT * FROM durable_runtime.catalog_project_groups WHERE deleted_at IS NULL ORDER BY id'))
        .rows.filter(row => call.authority.projectGroupIds.includes(row.id)).map(parseCatalogGroup)
      const workspaces = (await loadCatalogWorkspaces(tx)).filter(row => row.deleted_at === null && catalogWorkspaceAllowed(call.authority, row))
      for (const row of workspaces) { parseCatalogWorkspace(row) }
      const tabs = (await tx.query<CatalogTab>(`SELECT m.*,t.workspace_id,t.session_id,t.kind,t.terminal_handle,
        t.lifecycle,t.revision AS tab_revision FROM durable_runtime.catalog_tab_metadata m
        JOIN durable_runtime.tabs t ON t.id=m.tab_id ORDER BY t.ui_order,t.id`)).rows
        .filter(row => workspaces.some(ws => ws.workspace_id === row.workspace_id))
      for (const row of tabs) { parseCatalogTab(row) }
      const ui = (await tx.query<CatalogUiStateRow>("SELECT * FROM durable_runtime.catalog_ui_state WHERE scope='host'")).rows[0] ?? null
      const snapshot: CatalogSnapshot = { heads, repositories, projectGroups, workspaces, tabs, ui }
      validateCatalogSnapshot(config, snapshot)
      const aliases = await client.query<{ session_id: string; workspace_id: string; agent_id: string; provider: string;
        agent_provider: string; execution_host_id: string; session_fence: string; journal_epoch: string; head: string }>(
        `SELECT a.session_id,a.workspace_id,s.agent_id,a.provider,g.provider AS agent_provider,a.execution_host_id,
          s.session_fence::text,s.journal_epoch::text,(s.next_event_seq-1)::text AS head
         FROM durable_runtime.structured_session_aliases a
         JOIN durable_runtime.sessions s ON s.id=a.session_id AND s.workspace_id=a.workspace_id
         JOIN durable_runtime.workspaces w ON w.id=s.workspace_id
         JOIN durable_runtime.agents g ON g.id=s.agent_id
         WHERE a.public_session_id=$1 AND w.dataset_name=$2 AND g.dataset_name=$2`, [publicSessionId, config.datasetName])
      const alias = aliases.rows[0]
      if (aliases.rowCount !== 1 || !alias || !workspaces.some(ws => ws.workspace_id === alias.workspace_id) ||
        alias.execution_host_id !== config.hostId || alias.provider !== alias.agent_provider ||
        (alias.provider !== 'claude' && alias.provider !== 'codex')) { throw new CatalogReadError('STRUCTURED_HISTORY_ALIAS_SCOPE') }
      const eligibility = checkStructuredCapabilities(prepared.value, { provider: alias.provider,
        methods: { 'agentSession.history': { implemented: true, ready: true } } })
      if (!eligibility.eligible) { throw new CatalogReadError(eligibility.reason) }
      // SAFETY: only after transport validation, PG namespace/host/allowlist and exact alias join.
      // created_by and current Session/Tab lifecycle are not owner-only ACLs.
      const scope = Object.freeze({ principal, publicSessionId, sessionId: logicalId('session', alias.session_id),
        workspaceId: logicalId('workspace', alias.workspace_id) }) as VerifiedJournalReadScope
      const result = await readStructuredHistoryInTransaction(client, scope, { agentId: logicalId('agent', alias.agent_id),
        provider: alias.provider, epoch: counter('journal-epoch', alias.journal_epoch),
        headSequence: journalSafeCounter(alias.head), fence: journalSafeCounter(alias.session_fence) }, request)
      const projected = projectTurnItemHistory(projectBackgroundTaskHistory(result, policy), policy)
      config.assertCurrentHost()
      await client.query('COMMIT')
      committed = true
      config.assertCurrentHost()
      return projected
    } catch (error) {
      if (!committed) { try { await client.query('ROLLBACK') } catch { destroy = true } }
      throw error
    } finally { tx.close(); client.release(destroy) }
    }
  } }
}

/** Original unary surface: capture before await, identical decoder, scope and result. */
export function createCatalogStructuredHistoryRpc(config: CapturedCatalogReadConfig) {
  const owner = createCatalogStructuredHistoryReaderOwner(config)
  return async (params: unknown, context: RpcContext) => {
    const fingerprint = context.authenticatedCallerFingerprint, clientKind = context.clientKind
    const capabilities = Object.freeze([...(context.clientCapabilities ?? [])])
    const structuredNativeChatEnabled = isStructuredNativeChatEnabled(context.runtime)
    return owner.capture({ runtime: context.runtime, authenticatedCallerFingerprint: fingerprint,
      clientKind, clientCapabilities: capabilities, structuredNativeChatEnabled })(params)
  }
}
