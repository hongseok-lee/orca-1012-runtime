import type { Pool } from 'pg'
import { DurableTransaction } from '../db/connection.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { captureCatalogJson } from '../catalog/immutable.ts'
import { resolveCatalogWorkspace } from '../catalog/read.ts'
import { parseCatalogRepo, parseCatalogWorkspace } from '../catalog/payload.ts'
import type { CatalogAuthority } from '../catalog/authority.ts'
import type { CatalogRepositoryRow } from '../db/rows.ts'
import { readCommittedAttachment } from '../attachments/store.ts'
import type { AttachmentPrincipal } from '../attachments/types.ts'
import type { PreparedStructuredWire } from '../structured/wire.ts'
import type { StructuredWorkspaceExpectation, VerifiedStructuredAttachmentResolution } from '../structured/durable-types.ts'
import { checkStructuredCapabilities } from '../structured/capabilities.ts'
import { jsonObject } from '../output/model.ts'
import { CatalogReadError, type CapturedCatalogReadConfig } from './config.ts'

/** RR with writes permitted: readCommittedAttachment takes FOR KEY SHARE. Borrowed Pool only. */
export async function resolveCatalogStructuredSend(
  config: CapturedCatalogReadConfig, pool: Pool, wire: PreparedStructuredWire,
  authority: CatalogAuthority, principal: AttachmentPrincipal
): Promise<Readonly<{ workspace: StructuredWorkspaceExpectation; attachments: VerifiedStructuredAttachmentResolution }>> {
  if (wire.target.kind !== 'SESSION') { throw new CatalogReadError('STRUCTURED_SESSION_SCOPE_REQUIRED') }
  const publicSessionId = wire.target.publicSessionId
  const client = await pool.connect(), tx = new DurableTransaction(client)
  let destroy = false
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const dataset = await tx.query<{ dataset_name: string }>('SELECT dataset_name FROM durable_runtime.dataset_metadata')
    if (dataset.rows.length !== 1 || dataset.rows[0].dataset_name !== config.datasetName) {
      throw new CatalogReadError('CATALOG_DATASET_MISMATCH')
    }
    const found = await tx.query<{
      public_session_id: string; session_id: string; workspace_id: string; actual_workspace_id: string;
      public_id: string; provider: string; actual_provider: string; execution_host_id: string;
      agent_dataset: string; workspace_dataset: string
    }>(`SELECT a.public_session_id,a.session_id,a.workspace_id,a.provider,a.execution_host_id,
      s.workspace_id AS actual_workspace_id,w.public_id,g.provider AS actual_provider,
      g.dataset_name AS agent_dataset,w.dataset_name AS workspace_dataset
      FROM durable_runtime.structured_session_aliases a JOIN durable_runtime.sessions s ON s.id=a.session_id
      JOIN durable_runtime.workspaces w ON w.id=s.workspace_id JOIN durable_runtime.agents g ON g.id=s.agent_id
      WHERE a.public_session_id=$1`, [publicSessionId])
    const row = found.rows[0]
    if (found.rows.length !== 1 || row.public_session_id !== publicSessionId ||
        row.workspace_id !== row.actual_workspace_id || row.agent_dataset !== config.datasetName ||
        row.workspace_dataset !== config.datasetName || row.actual_provider !== row.provider ||
        (row.provider !== 'claude' && row.provider !== 'codex') || row.execution_host_id !== config.hostId) {
      throw new CatalogReadError('STRUCTURED_SEND_TARGET_SCOPE')
    }
    logicalId('session', row.session_id)
    // Resolver includes tombstones; lifecycle, fence and deleted state are not authentication.
    const workspace = await resolveCatalogWorkspace(tx, `id:${row.public_id}`, authority)
    if (workspace.workspace_id !== row.workspace_id || workspace.public_id !== row.public_id) {
      throw new CatalogReadError('STRUCTURED_SEND_TARGET_SCOPE')
    }
    const payload = parseCatalogWorkspace(workspace)
    if (payload.id !== workspace.public_id || ('repoId' in payload && payload.repoId !== workspace.repo_id) ||
        ('projectGroupId' in payload && payload.projectGroupId !== workspace.project_group_id)) {
      throw new CatalogReadError('STRUCTURED_SEND_TARGET_SCOPE')
    }
    let repositoryHost: string | undefined
    if (workspace.repo_id !== null) {
      const repository = (await tx.query<CatalogRepositoryRow>(
        'SELECT * FROM durable_runtime.catalog_repositories WHERE id=$1', [workspace.repo_id])).rows[0]
      if (!repository) { throw new CatalogReadError('CATALOG_REPOSITORY_UNAVAILABLE') }
      repositoryHost = parseCatalogRepo(repository).executionHostId ?? 'local'
      if (repositoryHost !== config.hostId) { throw new CatalogReadError('CATALOG_REGISTRATION_HOST_MISMATCH') }
    }
    const raw = captureCatalogJson(workspace.payload), fields = jsonObject(raw)
    const effectiveHost = fields.hostId ?? fields.executionHostId ?? repositoryHost ?? 'local'
    if (effectiveHost !== config.hostId) { throw new CatalogReadError('CATALOG_REGISTRATION_HOST_MISMATCH') }
    const eligibility = checkStructuredCapabilities(wire, { provider: row.provider,
      methods: { 'agentSession.send': { implemented: true, ready: true } } })
    if (!eligibility.eligible) { throw new CatalogReadError(eligibility.reason) }
    if (!eligibility.pendingResultsNegotiated) { throw new CatalogReadError('STRUCTURED_PENDING_SEND_CAPABILITY_REQUIRED') }
    const body = jsonObject(wire.params.body)
    if (!Array.isArray(body.blocks)) { throw new CatalogReadError('STRUCTURED_SEND_BODY') }
    const images = body.blocks.map((block, blockIndex) => ({ block: jsonObject(block), blockIndex }))
      .filter(({ block }) => block.type === 'image-ref')
    if (images.some(({ block }) => Object.hasOwn(block, 'url'))) {
      throw new CatalogReadError('STRUCTURED_IMAGE_URL_NOT_CONNECTED')
    }
    const paths = images.map(({ block }) => {
      if (typeof block.path !== 'string') { throw new CatalogReadError('STRUCTURED_ATTACHMENT_BINDING') }
      return block.path
    })
    const aliases = new Map<string, Awaited<ReturnType<typeof readCommittedAttachment>>>()
    for (const aliasPath of [...new Set(paths)].sort()) {
      aliases.set(aliasPath, await readCommittedAttachment(tx, principal, aliasPath))
    }
    const entries = Object.freeze(images.map(({ blockIndex }, index) => {
      const aliasPath = paths[index], alias = aliases.get(aliasPath)
      if (!alias || alias.principal !== principal || alias.aliasPath !== aliasPath) {
        throw new CatalogReadError('STRUCTURED_ATTACHMENT_SCOPE')
      }
      return Object.freeze({ blockIndex, referenceKind: 'path' as const, originalReference: aliasPath,
        aliasPath, contentHash: alias.contentHash })
    }))
    // This upper issuer follows actual owner-scoped alias/blob bytes/hash verification.
    const attachments = Object.freeze({ principal, entries }) as VerifiedStructuredAttachmentResolution
    const expected: StructuredWorkspaceExpectation = Object.freeze({ workspaceId: logicalId('workspace', row.workspace_id),
      workspacePublicId: row.public_id, provider: row.provider, executionHostId: row.execution_host_id })
    config.assertCurrentHost()
    await tx.query('COMMIT')
    return Object.freeze({ workspace: expected, attachments })
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { destroy = true }
    throw error
  } finally { tx.close(); client.release(destroy) }
}
