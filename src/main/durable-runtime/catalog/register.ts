import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Repo } from '../../../shared/repo-types.ts'
import type { ProjectGroup } from '../../../shared/project-group-types.ts'
import type { PairedUiState } from '../../../shared/pairing-local-ui-fields.ts'
import { runDurableMutation, type MutationOutcome } from '../db/atomic.ts'
import { inputPayloadHash } from '../input/canonical.ts'
import { captureCatalogAuthority, type CatalogAuthority } from './authority.ts'
import { captureCatalogParsed, captureCatalogJson } from './immutable.ts'
import { parseCatalogRepo, parseCatalogGroup } from './payload.ts'
import { parseCatalogUi } from './ui.ts'
import { lockCatalogMetadata } from './heads.ts'
import { publishCatalogMutation } from './mutation.ts'
import { CatalogError } from './errors.ts'

export type CatalogRegistration = {
  readonly repo: Repo
  readonly group: ProjectGroup | null
  readonly ui: PairedUiState
  readonly mutationId: string
}

/** Explicit new-dataset registration, not a legacy JSON migration or public RPC. */
export async function registerCatalogProject(pool: Pool, authorityInput: CatalogAuthority, input: CatalogRegistration): Promise<MutationOutcome> {
  const authority = captureCatalogAuthority(authorityInput), registration = captureCatalogParsed(input) as CatalogRegistration
  const repo = parseCatalogRepo({ id: registration.repo.id, payload: registration.repo as unknown as Record<string, unknown> })
  const group = registration.group ? parseCatalogGroup({ id: registration.group.id, payload: registration.group as unknown as Record<string, unknown> }) : null
  const ui = parseCatalogUi(registration.ui)
  if (!authority.repositoryIds.includes(repo.id) || (group && !authority.projectGroupIds.includes(group.id)) ||
    (repo.projectGroupId ?? null) !== (group?.id ?? null) || !registration.mutationId) {throw new CatalogError('CATALOG_REGISTRATION_AUTHORITY')}
  const original = captureCatalogJson({ repo, group, ui })
  return runDurableMutation(pool, { key: { principalId: authority.principalId, sessionScope: `repo:${repo.id}`,
    method: 'catalog.register-project', operationKey: registration.mutationId }, payloadHash: inputPayloadHash(original), locks: {} }, async tx => {
    await lockCatalogMetadata(tx, ['dataset', `namespace:${repo.id}`, ...(group ? [`namespace:${group.id}`] : []), 'ui:host'])
    for (const scope of ['catalog', 'ui:host']) {await tx.query(`INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch)
      VALUES($1,$2) ON CONFLICT(scope) DO NOTHING`, [scope, randomUUID()])}
    if (group) {
      const existing = (await tx.query('SELECT id FROM durable_runtime.catalog_project_groups WHERE id=$1 AND deleted_at IS NULL', [group.id])).rows[0]
      if (!existing) {await tx.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [group.id, JSON.stringify(group)])}
    }
    await tx.query('INSERT INTO durable_runtime.catalog_repositories(id,project_group_id,payload) VALUES($1,$2,$3)', [repo.id, group?.id ?? null, JSON.stringify(repo)])
    await tx.query("INSERT INTO durable_runtime.catalog_ui_state(scope,payload) VALUES('host',$1) ON CONFLICT(scope) DO NOTHING", [JSON.stringify(ui)])
    await publishCatalogMutation(tx, { context: { authority, capabilities: [] } }, null, 'CATALOG_PROJECT_REGISTERED', original, ['ui:host'])
    const storedUi = (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM durable_runtime.catalog_ui_state WHERE scope='host'")).rows[0]
    const storedGroup = group ? (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM durable_runtime.catalog_project_groups WHERE id=$1', [group.id])).rows[0] : null
    return captureCatalogJson({ repo, group: storedGroup ? parseCatalogGroup({ id: group!.id, payload: storedGroup.payload }) : null,
      ui: parseCatalogUi(storedUi.payload) })
  })
}
