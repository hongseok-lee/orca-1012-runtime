import { posix } from 'node:path'
import type { DurableTransaction } from '../db/connection.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { immutableSnapshot } from '../providers/shared/immutable-snapshot.ts'

export type InitialProviderPaths = Readonly<{
  workspaceId: string
  agentId: string
  home: string
  checkout: '/agent/checkout'
  checkoutPreparation: 'FRESH_EMPTY_FOLDER'
  canonicalDirectory: string
  sourceHome: string
  sourceCheckout: string
}>
/** Private, create-only provisioning record written for the deliberately new
 * blank workspace returned by normal Catalog creation. Never a public param. */
export type InitialEmptyFolderDeclaration = Readonly<{
  kind: 'FRESH_EMPTY_FOLDER'; workspaceId: string; canonicalDirectory: string; checkout: '/agent/checkout'; sourceCheckout: string
}>

const deny = (): never => { throw new DurableDatabaseError('INITIAL_PROVIDER_CATALOG_PATHS') }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return deny() }
  return value as Record<string, unknown>
}

/** Only the persisted server launch mapping supplies HOME/checkout. This
 * describes preparation, never authenticates a writer or opens its gate. */
export function captureInitialProviderPaths(original: Readonly<{
  workspaceId: string; agentId: string; kind: string; repositoryKind: string; reservedPath: string
  canonicalDirectory: string; launchRequest: unknown
}>, originalDeclaration: InitialEmptyFolderDeclaration): InitialProviderPaths {
  const input = immutableSnapshot(original), server = object(object(input.launchRequest).server)
  const declaration = originalDeclaration ? immutableSnapshot(originalDeclaration) : null
  const mapping = object(server.storagePathMapping), home = server.agentHomePath
  function mapped(value: unknown): string {
    const root = mapping.localDirectory
    if (typeof root !== 'string' || typeof value !== 'string' || !root.startsWith('/') || !value.startsWith('/') ||
        root.includes('\\') || value.includes('\\') || posix.normalize(root) !== root || posix.normalize(value) !== value ||
        root.endsWith('/') || value.endsWith('/') || !value.startsWith(`${root}/`) ||
        Array.from(root + value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) { return deny() }
    return posix.join('/agent', posix.relative(root, value))
  }
  const agentHome = mapped(home), checkout = mapped(input.reservedPath)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.agentId) ||
      agentHome !== `/agent/home/${input.agentId}` || checkout !== '/agent/checkout' ||
      typeof home !== 'string' || typeof mapping.canonicalDirectory !== 'string' ||
      mapping.canonicalDirectory !== input.canonicalDirectory ||
      !mapping.canonicalDirectory.startsWith('/') || posix.normalize(mapping.canonicalDirectory) !== mapping.canonicalDirectory ||
      mapping.canonicalDirectory === '/' || mapping.canonicalDirectory.endsWith('/') ||
      Array.from(mapping.canonicalDirectory).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) { return deny() }
  if (input.kind !== 'REPO_FOLDER' || input.repositoryKind !== 'folder' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.workspaceId) ||
      !declaration || declaration.kind !== 'FRESH_EMPTY_FOLDER' || declaration.workspaceId !== input.workspaceId ||
      declaration.canonicalDirectory !== mapping.canonicalDirectory || declaration.checkout !== checkout ||
      declaration.sourceCheckout !== input.reservedPath) { return deny() }
  return Object.freeze({ workspaceId: input.workspaceId, agentId: input.agentId, home: agentHome, checkout,
    sourceHome: home, sourceCheckout: input.reservedPath,
    canonicalDirectory: mapping.canonicalDirectory,
    checkoutPreparation: 'FRESH_EMPTY_FOLDER' })
}

/** The original executor calls this after its Session/Unit locks. The single
 * member and stored launch mapping must still describe the selected target. */
export async function readInitialProviderPaths(tx: DurableTransaction, unitId: string, sessionId: string,
  declaration: InitialEmptyFolderDeclaration): Promise<InitialProviderPaths> {
  const rows = await tx.query<{ workspace_id: string; agent_id: string; kind: string; repository_kind: string; reserved_path: string;
    canonical_directory: string; launch_request: unknown }>(
    `SELECT s.workspace_id,s.agent_id,w.kind,COALESCE(r.payload->>'kind','git') AS repository_kind,w.reserved_path,t.launch_request,b.canonical_directory
     FROM durable_runtime.runtime_members m JOIN durable_runtime.sessions s ON s.id=m.session_id
     JOIN durable_runtime.runtime_member_storage_bindings mb ON mb.runtime_unit_id=m.runtime_unit_id AND mb.session_id=s.id
     JOIN durable_runtime.storage_bindings b ON b.id=mb.storage_binding_id
     JOIN durable_runtime.agents a ON a.id=s.agent_id JOIN durable_runtime.workspaces ws ON ws.id=s.workspace_id
     JOIN durable_runtime.catalog_workspace_metadata w ON w.workspace_id=ws.id
     JOIN durable_runtime.catalog_repositories r ON r.id=w.repo_id
     JOIN durable_runtime.tabs tab ON tab.session_id=s.id AND tab.kind='terminal' AND tab.lifecycle='OPEN'
     JOIN durable_runtime.catalog_tab_metadata t ON t.tab_id=tab.id
     WHERE m.runtime_unit_id=$1 AND s.id=$2 AND s.lifecycle='OPEN' AND a.provider IN ('codex','claude')
     AND ws.deleted_at IS NULL AND r.deleted_at IS NULL AND w.runtime_unit_id=m.runtime_unit_id`, [unitId, sessionId])
  const members = await tx.query('SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1', [unitId])
  if (members.rowCount !== 1 || rows.rowCount !== 1) { return deny() }
  const row = rows.rows[0]
  return captureInitialProviderPaths({ workspaceId: row.workspace_id, agentId: row.agent_id, kind: row.kind, repositoryKind: row.repository_kind,
    reservedPath: row.reserved_path, canonicalDirectory: row.canonical_directory, launchRequest: row.launch_request }, declaration)
}
