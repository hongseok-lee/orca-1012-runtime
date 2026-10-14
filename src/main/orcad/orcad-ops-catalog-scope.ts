import type { CatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import { captureCatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import { catalogWorkspaceAllowed, loadCatalogWorkspaces, withCatalogReadSnapshot } from '../durable-runtime/catalog/read.ts'
import type { CapturedCatalogReadConfig } from '../durable-runtime/rpc/config.ts'
import { snapshotOpsActor } from '../durable-runtime/ops/auth.ts'
import { OpsHttpError } from '../durable-runtime/ops/errors.ts'
import { requireOpsActor, snapshotOpsPgConfig, type OpsPgConfig } from '../durable-runtime/ops/pg-config.ts'
import { createPgOpsServices } from '../durable-runtime/ops/pg-services.ts'
import type { OpsActor, OpsHttpServices } from '../durable-runtime/ops/types.ts'

/** Private catalog opt-in only. Auth remains the static server verifier's responsibility. */
export function createOrcadOpsCatalogScopeServices(
  catalog: CapturedCatalogReadConfig, input: OpsPgConfig
): OpsHttpServices {
  const config = snapshotOpsPgConfig({ ...input, controllerConnected: false })
  const pool = catalog.pool
  const datasetName = catalog.datasetName
  const assertCurrentHost = catalog.assertCurrentHost.bind(catalog)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the captured server Catalog registration supplies these arrays; never a request actor.
  const authority = captureCatalogAuthority({ principalId: 'orcad-ops-startup-registration',
    repositoryIds: catalog.repositoryIds, projectGroupIds: catalog.projectGroupIds,
    workspacePublicIds: catalog.workspacePublicIds } as CatalogAuthority)
  if (pool !== config.pool || datasetName !== config.scope.datasetName) {
    throw new OpsHttpError(503, 'invalid_configuration', 'The server operations configuration is unavailable.')
  }
  assertCurrentHost()

  async function scoped<T>(value: OpsActor, call: (services: OpsHttpServices, actor: OpsActor) => Promise<T>): Promise<T> {
    // The original identity and static base scope are owned before the first await.
    const original = requireOpsActor(config, value)
    assertCurrentHost()
    let selected: { workspaceIds: readonly string[]; failure: string | null }
    try {
      selected = await withCatalogReadSnapshot(pool, async tx => {
        const datasets = (await tx.query<{ dataset_name: string }>(
          'SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows
        if (datasets.length !== 1 || datasets[0].dataset_name !== datasetName) {
          return { workspaceIds: [], failure: 'OPS_CATALOG_DATASET_MISMATCH' }
        }
        // This resolver retains immutable anchors, including tombstones and removed members.
        const allowed = (await loadCatalogWorkspaces(tx)).filter(row => catalogWorkspaceAllowed(authority, row))
        const workspaces = (await tx.query<{ id: string; dataset_name: string }>(
          'SELECT id,dataset_name FROM durable_runtime.workspaces WHERE id=ANY($1::uuid[])',
          [allowed.map(row => row.workspace_id)])).rows
        for (const row of allowed) {
          const workspace = workspaces.find(item => item.id === row.workspace_id)
          if (!workspace || workspace.dataset_name !== datasetName) {
            return { workspaceIds: [], failure: 'OPS_CATALOG_WORKSPACE_DATASET_MISMATCH' }
          }
        }
        return { workspaceIds: Object.freeze([...new Set([
          ...config.scope.workspaceIds, ...allowed.map(row => row.workspace_id)
        ])].sort()), failure: null }
      })
    } finally { assertCurrentHost() }
    // Preserve the transaction sanitizer: domain status mapping happens outside SQL callbacks.
    if (selected.failure) {
      throw new OpsHttpError(503, 'unavailable', 'The server Catalog scope could not be confirmed.')
    }
    const scope = Object.freeze({ datasetName, namespaceId: config.scope.namespaceId,
      workspaceIds: selected.workspaceIds })
    const actor = snapshotOpsActor({ ...original, workspaceIds: scope.workspaceIds })
    const services = createPgOpsServices({ ...config, scope, controllerConnected: false })
    try { return await call(services, actor) }
    finally { assertCurrentHost() }
  }

  // Each delegate captures request data before the scope read; no mutable list/cache/timer is retained.
  return Object.freeze({
    units(actor) { return scoped(actor, (services, owned) => services.units(owned)) },
    unit(actor, id) { return scoped(actor, (services, owned) => services.unit(owned, id)) },
    operation(actor, id) { return scoped(actor, (services, owned) => services.operation(owned, id)) },
    events(actor, query) {
      const selected = Object.freeze({ ...query, after: query.after ? Object.freeze({ ...query.after }) : null })
      return scoped(actor, (services, owned) => services.events(owned, selected))
    },
    notifications(actor, query) {
      const selected = Object.freeze({ ...query })
      return scoped(actor, (services, owned) => services.notifications(owned, selected))
    },
    readNotification(actor, id, request) {
      const selected = Object.freeze({ ...request })
      return scoped(actor, (services, owned) => services.readNotification(owned, id, selected))
    },
    command(actor, id, request) {
      const selected = Object.freeze({ ...request, params: Object.freeze({ ...request.params }) })
      return scoped(actor, (services, owned) => services.command(owned, id, selected))
    }
  } satisfies OpsHttpServices)
}
