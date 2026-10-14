import type { CatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import type { RuntimeOpsHttpConfig } from '../durable-runtime/ops/runtime-config.ts'
import type { OrcaRuntimeRpcServerOptions } from '../runtime/runtime-rpc/runtime-rpc-pairing-types.ts'
import { captureDurableCatalogReadConfig, type DurableCatalogReadConfig } from '../durable-runtime/rpc/config.ts'
import { readOrcadDurableCatalogConfig, prepareOrcadDurableCatalog,
  type OrcadDurableCatalogConfig, type OrcadDurableCatalog } from './orcad-durable-catalog.ts'
import { captureOrcadOpsConfig, readOrcadOpsConfig, invalidOrcadOpsConfig, OrcadOpsConfigurationError,
  type OrcadOpsConfig } from './orcad-ops-config.ts'

// The entry consumes one composition surface; Catalog retains its existing Pool ownership and exit class.
export { OrcadDurableCatalogConfigurationError } from './orcad-durable-catalog.ts'
export type { OrcadDurableCatalog } from './orcad-durable-catalog.ts'
export type OrcadStartupConfig = Readonly<{ catalog: OrcadDurableCatalogConfig | null; ops: OrcadOpsConfig | null }>

export function readOrcadStartupConfig(): OrcadStartupConfig {
  const catalog = readOrcadDurableCatalogConfig()
  const ops = readOrcadOpsConfig()
  if (ops && !catalog) { invalidOrcadOpsConfig('OPS_STARTUP_CATALOG_REQUIRED') }
  return Object.freeze({ catalog, ops })
}

/** Publish ownership before Ops validation so the entry's existing failure cleanup can always close Catalog. */
export async function prepareOrcadStartup(
  input: OrcadStartupConfig, ownCatalog: (catalog: OrcadDurableCatalog | null) => void
): Promise<Pick<OrcaRuntimeRpcServerOptions, 'durableCatalogRead' | 'opsHttp'>> {
  const ops = input.ops === null ? null : captureOrcadOpsConfig(input.ops)
  if (ops && !input.catalog) { invalidOrcadOpsConfig('OPS_STARTUP_CATALOG_REQUIRED') }
  const catalog = await prepareOrcadDurableCatalog(input.catalog)
  ownCatalog(catalog)
  const opsHttp = await prepareOrcadOps(ops, catalog?.readConfig)
  return catalog ? Object.freeze({ durableCatalogRead: catalog.readConfig, ...(opsHttp ? { opsHttp } : {}) }) : Object.freeze({})
}

/** Borrow the validated Catalog owner; neither allocate nor close a Pool/listener here. */
export async function prepareOrcadOps(
  input: OrcadOpsConfig | null,
  readConfig: DurableCatalogReadConfig | undefined
): Promise<RuntimeOpsHttpConfig | undefined> {
  if (input === null) { return undefined }
  if (!readConfig) { invalidOrcadOpsConfig('OPS_STARTUP_CATALOG_REQUIRED') }
  try {
    const config = captureOrcadOpsConfig(input)
    const catalog = captureDurableCatalogReadConfig(readConfig)
    const authority = Object.freeze({ principalId: 'orcad-ops-startup-registration',
      repositoryIds: catalog.repositoryIds, projectGroupIds: catalog.projectGroupIds,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only validated server registration supplies these arrays, never Ops/client input.
      workspacePublicIds: catalog.workspacePublicIds }) as CatalogAuthority
    const scope = Object.freeze({ datasetName: catalog.datasetName, namespaceId: config.namespaceId,
      workspaceIds: config.workspaceIds })
    const [{ withCatalogReadSnapshot, loadCatalogWorkspaces, catalogWorkspaceAllowed },
      { createPgOpsServices }, { OPS_REPLAY_STREAM }, { getOpsUiAsset }] = await Promise.all([
      import('../durable-runtime/catalog/read.ts'), import('../durable-runtime/ops/pg-services.ts'),
      import('../durable-runtime/replay/types.ts'), import('../durable-runtime/ops-ui/index.ts')
    ])
    catalog.assertCurrentHost()
    const failure = await withCatalogReadSnapshot(catalog.pool, async tx => {
      const datasets = (await tx.query<{ dataset_name: string }>(
        'SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows
      if (datasets.length !== 1 || datasets[0].dataset_name !== scope.datasetName) {
        return 'OPS_STARTUP_DATASET_MISMATCH'
      }
      const metadata = await loadCatalogWorkspaces(tx)
      const workspaces = (await tx.query<{ id: string; dataset_name: string }>(
        'SELECT id,dataset_name FROM durable_runtime.workspaces WHERE id=ANY($1::uuid[])', [scope.workspaceIds])).rows
      for (const id of scope.workspaceIds) {
        const workspace = workspaces.find(row => row.id === id)
        if (workspace && workspace.dataset_name !== scope.datasetName) { return 'OPS_STARTUP_DATASET_MISMATCH' }
        const row = metadata.find(row => row.workspace_id === id)
        // Immutable metadata is retained for tombstones; OPEN inventory is not an authorization substitute.
        if (!workspace || !row || !catalogWorkspaceAllowed(authority, row)) { return 'OPS_STARTUP_WORKSPACE_FORBIDDEN' }
      }
      return null
    })
    catalog.assertCurrentHost()
    // Domain configuration failures stay outside the DB wrapper's error conversion.
    if (failure) { invalidOrcadOpsConfig(failure) }
    return Object.freeze({ origin: config.origin, scope, streamId: OPS_REPLAY_STREAM,
      pollIntervalMs: config.pollIntervalMs, ui: getOpsUiAsset,
      services: createPgOpsServices({ pool: catalog.pool, scope, streamId: OPS_REPLAY_STREAM,
        lifecyclePolicy: config.lifecyclePolicy, controllerConnected: false }) })
  } catch (error) {
    if (error instanceof OrcadOpsConfigurationError) { throw error }
    invalidOrcadOpsConfig('OPS_STARTUP_UNAVAILABLE')
  }
}
