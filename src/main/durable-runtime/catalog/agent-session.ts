import { posix } from 'node:path'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection.ts'
import { isAgentSessionId } from '../../../shared/agent-session-record.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { CatalogWorkspace } from './read.ts'
import type { DurableTransaction } from '../db/connection.ts'
import type { CatalogOwnerEntries } from './owners.ts'
import { captureCatalogParsed } from './immutable.ts'
import { captureCatalogAuthority } from './authority.ts'
import { inspectCatalogMembership, type CatalogMembership } from './membership.ts'
import { insertUnpublishedLaunchRows, insertMembershipAndIntent, withUnpublishedIds } from './runtime-launch.ts'
import { lockCatalogMetadata } from './heads.ts'
import { loadCatalogTabs } from './metadata.ts'
import { parseCatalogTab } from './payload.ts'
import { publishCatalogMutation } from './mutation.ts'
import { readWorkspaceTabsInTransaction } from './projection.ts'
import { CatalogError } from './errors.ts'
import type { PreparedCatalogAgentSession, CatalogAgentSessionReservation } from './agent-session-types.ts'

export type { PreparedCatalogAgentSession, CatalogAgentSessionReservation } from './agent-session-types.ts'

function normalizedReservationPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.startsWith('/') &&
    !value.includes('\\') && posix.normalize(value) === value && (value === '/' || !value.endsWith('/')) &&
    !Array.from(value).some(character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f) &&
    !value.split('/').some(part => part === '.' || part === '..')
}

function captureAgentSession(input: PreparedCatalogAgentSession): PreparedCatalogAgentSession {
  const originalDescriptor = Object.getOwnPropertyDescriptor(input, 'originalRequest')
  if (originalDescriptor && 'value' in originalDescriptor && originalDescriptor.value !== null &&
      typeof originalDescriptor.value === 'object' && Object.hasOwn(originalDescriptor.value, 'server')) {
    throw new CatalogError('CATALOG_AGENT_SESSION_SERVER_CONFLICT')
  }
  // SAFETY: a detached copy of the supplied typed configuration, not an authority issuer.
  const prepared = captureCatalogParsed(input) as PreparedCatalogAgentSession
  const { workspace, runtime, tab } = prepared
  if (Object.hasOwn(prepared.originalRequest, 'server')) {throw new CatalogError('CATALOG_AGENT_SESSION_SERVER_CONFLICT')}
  const server = prepared.serverLaunch
  if (server !== undefined) {
    const mapping = server?.storagePathMapping
    if (!server || typeof server !== 'object' || Array.isArray(server) ||
      Object.keys(server).some(key => !['agentHomePath', 'storagePathMapping'].includes(key)) ||
      !mapping || typeof mapping !== 'object' || Array.isArray(mapping) ||
      Object.keys(mapping).some(key => !['localDirectory', 'canonicalDirectory'].includes(key)) ||
      !normalizedReservationPath(server.agentHomePath) || !normalizedReservationPath(mapping.localDirectory) ||
      !normalizedReservationPath(mapping.canonicalDirectory) ||
      mapping.canonicalDirectory !== runtime.storage.canonicalDirectory ||
      !(mapping.localDirectory === '/' || server.agentHomePath === mapping.localDirectory ||
        server.agentHomePath.startsWith(`${mapping.localDirectory}/`)) ||
      posix.basename(server.agentHomePath) !== runtime.agent.id) {
      throw new CatalogError('CATALOG_AGENT_SESSION_SERVER_CONFIGURATION')
    }
  }
  logicalId('workspace', workspace.workspace_id); logicalId('session', runtime.sessionId)
  logicalId('agent', runtime.agent.id); logicalId('runtime-unit', runtime.unit.id)
  logicalId('storage-binding', runtime.storage.id); logicalId('tab', tab.id)
  for (const member of prepared.unitPeers) {logicalId('session', member)}
  const expectedPublicTab = structuredAgentSessionTabId(prepared.publicSessionId)
  if (!isAgentSessionId(prepared.publicSessionId) || !prepared.operationKey || !workspace.public_id ||
    prepared.membership.workspaceId !== workspace.workspace_id || runtime.workspace.id !== workspace.workspace_id ||
    prepared.membership.workspaceSessions.includes(runtime.sessionId) ||
    tab.payload.type !== 'agent-session' || tab.payload.id !== expectedPublicTab ||
    tab.payload.sessionId !== prepared.publicSessionId || tab.payload.agent !== runtime.agent.provider ||
    !['claude', 'codex'].includes(runtime.agent.provider) ||
    !Number.isSafeInteger(tab.uiOrder) || tab.uiOrder < 0 ||
    runtime.unit.authority.runtimeUnitId !== runtime.unit.id ||
    runtime.unit.authority.principalId !== prepared.authority.principalId ||
    !runtime.storage.backendId || !runtime.storage.exportId ||
    !/^\/(?!.*(?:\/\/|(?:^|\/)\.{1,2}(?:\/|$)))/.test(runtime.storage.canonicalDirectory) ||
    (runtime.storage.canonicalDirectory !== '/' && runtime.storage.canonicalDirectory.endsWith('/')) ||
    JSON.stringify(prepared.unitPeers) !== JSON.stringify([...new Set(prepared.unitPeers)].sort())) {
    throw new CatalogError('CATALOG_AGENT_SESSION_CONFIGURATION')
  }
  for (const key of ['providerHandle', 'nativeSessionId', 'ptyId', 'incarnationId', 'terminal', 'terminalHandle', 'leafId', 'paneKey']) {
    if (key in tab.payload) {throw new CatalogError('CATALOG_AGENT_SESSION_PHYSICAL_BINDING_FORBIDDEN')}
  }
  return prepared
}

function finalMembership(prepared: PreparedCatalogAgentSession): CatalogMembership {
  const before = prepared.membership, runtime = prepared.runtime
  const pairs = new Map(before.pairs.map(pair => [JSON.stringify([pair.sessionId, pair.unitId]), pair]))
  for (const sessionId of [...prepared.unitPeers, runtime.sessionId]) {
    pairs.set(JSON.stringify([sessionId, runtime.unit.id]), { sessionId, unitId: runtime.unit.id })
  }
  return { workspaceId: before.workspaceId,
    workspaceSessions: [...before.workspaceSessions, runtime.sessionId].sort(),
    sessions: [...new Set([...before.sessions, ...prepared.unitPeers, runtime.sessionId])].sort(),
    units: [...new Set([...before.units, runtime.unit.id])].sort(),
    pairs: [...pairs.values()].sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 :
      a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0) }
}

/** Caller owns the outer receipt transaction; no pool, nested receipt, COMMIT or provider I/O. */
export async function reserveCatalogAgentSessionInTransaction(
  tx: DurableTransaction, input: PreparedCatalogAgentSession, entries: CatalogOwnerEntries
): Promise<CatalogAgentSessionReservation> {
  const prepared = captureAgentSession(input)
  const authority = captureCatalogAuthority(prepared.authority)
  const intentMethod = entries.recordUnitIntent
  const receiver = entries
  const owners = Object.freeze({ ...entries, recordUnitIntent: intentMethod.bind(receiver) })
  const runtime = prepared.runtime
  const identity = prepared.workspace
  const authorized = authority.workspacePublicIds.includes(identity.public_id) ||
    (identity.repo_id !== null && authority.repositoryIds.includes(identity.repo_id)) ||
    (identity.project_group_id !== null && authority.projectGroupIds.includes(identity.project_group_id))
  if (!authorized) {throw new CatalogError('CATALOG_AGENT_SESSION_SCOPE')}
  const before = (await tx.query<CatalogWorkspace>(`SELECT m.*,w.public_id,w.name,w.deleted_at,
    w.revision AS workspace_revision,w.provisioning_state FROM durable_runtime.catalog_workspace_metadata m
    JOIN durable_runtime.workspaces w ON w.id=m.workspace_id WHERE w.id=$1`, [identity.workspace_id])).rows[0]
  if (!before || before.deleted_at !== null) {throw new CatalogError('CATALOG_WORKSPACE_DELETED')}
  if (before.public_id !== identity.public_id || before.repo_id !== identity.repo_id || before.project_group_id !== identity.project_group_id) {
    throw new CatalogError('CATALOG_LAUNCH_WORKSPACE')
  }
  await insertUnpublishedLaunchRows(tx, runtime, 1)
  const caller = { context: { authority, capabilities: [] }, operationKey: prepared.operationKey }
  const intent = await insertMembershipAndIntent(tx, runtime, caller,
    withUnpublishedIds(prepared.membership, runtime), prepared.unitPeers, owners)
  await lockCatalogMetadata(tx, [`workspace:${identity.workspace_id}`])
  if (JSON.stringify(await inspectCatalogMembership(tx, identity.workspace_id)) !== JSON.stringify(finalMembership(prepared))) {
    throw new CatalogError('CATALOG_MEMBERSHIP_CHANGED_RETRYABLE')
  }
  const current = (await tx.query<CatalogWorkspace>(`SELECT m.*,w.public_id,w.name,w.deleted_at,
    w.revision AS workspace_revision,w.provisioning_state FROM durable_runtime.catalog_workspace_metadata m
    JOIN durable_runtime.workspaces w ON w.id=m.workspace_id WHERE w.id=$1 FOR UPDATE OF w`, [identity.workspace_id])).rows[0]
  if (!current || current.deleted_at !== null) {throw new CatalogError('CATALOG_WORKSPACE_DELETED')}
  if (current.public_id !== identity.public_id || current.repo_id !== identity.repo_id || current.project_group_id !== identity.project_group_id) {
    throw new CatalogError('CATALOG_LAUNCH_WORKSPACE')
  }
  if (prepared.tab.payload.isActive) {
    for (const tab of await loadCatalogTabs(tx, identity.workspace_id)) {
      if (tab.lifecycle === 'OPEN' && tab.payload.isActive) {
        await tx.query('UPDATE durable_runtime.catalog_tab_metadata SET payload=$2,updated_at=clock_timestamp() WHERE tab_id=$1',
          [tab.tab_id, JSON.stringify({ ...tab.payload, isActive: false })])
      }
    }
  }
  await tx.query(`INSERT INTO durable_runtime.tabs
    (id,workspace_id,session_id,kind,terminal_handle,leaf_id,pane_key,ui_order,lifecycle)
    VALUES($1,$2,$3,'agent-session',NULL,NULL,NULL,$4,'OPEN')`,
    [prepared.tab.id, identity.workspace_id, runtime.sessionId, prepared.tab.uiOrder])
  await tx.query(`INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request,launch_token)
    VALUES($1,$2,$3,$4,NULL)`, [prepared.tab.id, structuredAgentSessionTabId(prepared.publicSessionId),
    JSON.stringify(prepared.tab.payload), JSON.stringify(prepared.serverLaunch === undefined ? prepared.originalRequest
      : { ...prepared.originalRequest, server: prepared.serverLaunch })])
  const created = (await loadCatalogTabs(tx, identity.workspace_id)).find(tab => tab.tab_id === prepared.tab.id)
  if (!created) {throw new CatalogError('CATALOG_TAB_NOT_FOUND')}
  const tab = parseCatalogTab(created)
  if (tab.type !== 'agent-session') {throw new CatalogError('CATALOG_AGENT_SESSION_CONFIGURATION')}
  await publishCatalogMutation(tx, caller, identity.workspace_id, 'CATALOG_AGENT_SESSION_RESERVED',
    { publicSessionId: prepared.publicSessionId, publicTabId: tab.id, operationId: intent.operationId })
  const snapshot = await readWorkspaceTabsInTransaction(tx, current)
  // Transaction-local reservation: the caller still owns alias/event and observed COMMIT.
  return Object.freeze({ sessionId: runtime.sessionId, tabId: prepared.tab.id, tab,
    publicationEpoch: snapshot.publicationEpoch, snapshotVersion: snapshot.snapshotVersion,
    operationId: intent.operationId })
}
