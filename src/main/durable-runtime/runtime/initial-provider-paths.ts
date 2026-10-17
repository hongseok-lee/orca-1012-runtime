import { posix } from 'node:path'
import type { DurableTransaction } from '../db/connection.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { immutableSnapshot } from '../providers/shared/immutable-snapshot.ts'

export type InitialProviderPaths = Readonly<{
  agentId: string
  home: string
  checkout: '/agent/checkout'
  checkoutPreparation: 'EMPTY_FOLDER' | 'EXISTING_GIT'
  canonicalDirectory: string
}>

const deny = (): never => { throw new DurableDatabaseError('INITIAL_PROVIDER_CATALOG_PATHS') }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return deny() }
  return value as Record<string, unknown>
}

/** Only the persisted server launch mapping supplies HOME/checkout. This
 * describes preparation, never authenticates a writer or opens its gate. */
export function captureInitialProviderPaths(original: Readonly<{
  agentId: string; kind: string; repositoryKind: string; reservedPath: string
  canonicalDirectory: string; launchRequest: unknown
}>): InitialProviderPaths {
  const input = immutableSnapshot(original), server = object(object(input.launchRequest).server)
  const mapping = object(server.storagePathMapping), home = server.agentHomePath
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.agentId) ||
      home !== `/agent/home/${input.agentId}` || input.reservedPath !== '/agent/checkout' ||
      mapping.localDirectory !== '/agent' || typeof mapping.canonicalDirectory !== 'string' ||
      mapping.canonicalDirectory !== input.canonicalDirectory ||
      !mapping.canonicalDirectory.startsWith('/') || posix.normalize(mapping.canonicalDirectory) !== mapping.canonicalDirectory ||
      mapping.canonicalDirectory === '/' || mapping.canonicalDirectory.endsWith('/') ||
      Array.from(mapping.canonicalDirectory).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) { return deny() }
  if (!((input.kind === 'REPO_FOLDER' && input.repositoryKind === 'folder') ||
        (input.kind === 'GIT' && input.repositoryKind === 'git'))) { return deny() }
  return Object.freeze({ agentId: input.agentId, home, checkout: input.reservedPath,
    canonicalDirectory: mapping.canonicalDirectory,
    checkoutPreparation: input.kind === 'REPO_FOLDER' ? 'EMPTY_FOLDER' : 'EXISTING_GIT' })
}

/** The original executor calls this after its Session/Unit locks. The single
 * member and stored launch mapping must still describe the selected target. */
export async function readInitialProviderPaths(tx: DurableTransaction, unitId: string, sessionId: string): Promise<InitialProviderPaths> {
  const rows = await tx.query<{ agent_id: string; kind: string; repository_kind: string; reserved_path: string;
    canonical_directory: string; launch_request: unknown }>(
    `SELECT s.agent_id,w.kind,COALESCE(r.payload->>'kind','git') AS repository_kind,w.reserved_path,t.launch_request,b.canonical_directory
     FROM durable_runtime.runtime_members m JOIN durable_runtime.sessions s ON s.id=m.session_id
     JOIN durable_runtime.runtime_member_storage_bindings mb ON mb.runtime_unit_id=m.runtime_unit_id AND mb.session_id=s.id
     JOIN durable_runtime.storage_bindings b ON b.id=mb.storage_binding_id
     JOIN durable_runtime.agents a ON a.id=s.agent_id JOIN durable_runtime.workspaces ws ON ws.id=s.workspace_id
     JOIN durable_runtime.catalog_workspace_metadata w ON w.workspace_id=ws.id
     JOIN durable_runtime.catalog_repositories r ON r.id=w.repo_id
     JOIN durable_runtime.tabs tab ON tab.session_id=s.id AND tab.kind='terminal' AND tab.lifecycle='OPEN'
     JOIN durable_runtime.catalog_tab_metadata t ON t.tab_id=tab.id
     WHERE m.runtime_unit_id=$1 AND s.id=$2 AND s.lifecycle='OPEN' AND a.provider='codex'
     AND ws.deleted_at IS NULL AND r.deleted_at IS NULL AND w.runtime_unit_id=m.runtime_unit_id`, [unitId, sessionId])
  const members = await tx.query('SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1', [unitId])
  if (members.rowCount !== 1 || rows.rowCount !== 1) { return deny() }
  const row = rows.rows[0]
  return captureInitialProviderPaths({ agentId: row.agent_id, kind: row.kind, repositoryKind: row.repository_kind,
    reservedPath: row.reserved_path, canonicalDirectory: row.canonical_directory, launchRequest: row.launch_request })
}
