import type { LifecyclePolicy } from '../durable-runtime/lifecycle/types.ts'
import { readOrcadManagedWakePolicy } from './orcad-wake-policy.ts'
import type {ManagedCodexCredentialReader} from '../durable-runtime/providers/codex/managed-credential-owner.ts'
import type { CatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import type { RuntimeOpsHttpConfig } from '../durable-runtime/ops/runtime-config.ts'
import type { OrcaRuntimeRpcServerOptions } from '../runtime/runtime-rpc/runtime-rpc-pairing-types.ts'
import { captureDurableCatalogReadConfig, type DurableCatalogReadConfig } from '../durable-runtime/rpc/config.ts'
import { readOrcadDurableCatalogConfig, prepareOrcadDurableCatalog,
  type OrcadDurableCatalogConfig, type OrcadDurableCatalog } from './orcad-durable-catalog.ts'
import { captureOrcadOpsConfig, readOrcadOpsConfig, invalidOrcadOpsConfig, OrcadOpsConfigurationError,
  type OrcadOpsConfig } from './orcad-ops-config.ts'
import { ownOrcadOpsPublication } from './orcad-ops-publication.ts'
import { captureOrcadControllerConfig, readOrcadControllerConfig, invalidOrcadControllerConfig,
  type OrcadControllerConfig } from './orcad-controller-config.ts'
import { ownOrcadController, type OrcadControllerSnapshot } from './orcad-controller.ts'
import { createOrcadOpsBrowserSessionOwner } from './orcad-ops-browser-session-owner.ts'
import type { InitialCodexNativeSettings } from '../durable-runtime/runtime/initial-codex-native-policy.ts'

// The entry consumes one composition surface; Catalog retains its existing Pool ownership and exit class.
export { OrcadDurableCatalogConfigurationError } from './orcad-durable-catalog.ts'
export type { OrcadDurableCatalog } from './orcad-durable-catalog.ts'
export type OrcadStartupConfig = Readonly<{ catalog: OrcadDurableCatalogConfig | null; ops: OrcadOpsConfig | null; controller?: OrcadControllerConfig | null }>
export type OrcadStartupOwner = OrcadDurableCatalog & Readonly<{ controllerSnapshot?: () => OrcadControllerSnapshot }>

export function readOrcadStartupConfig(): OrcadStartupConfig {
  const catalog = readOrcadDurableCatalogConfig()
  const ops = readOrcadOpsConfig()
  const controller = readOrcadControllerConfig()
  if (ops && !catalog) { invalidOrcadOpsConfig('OPS_STARTUP_CATALOG_REQUIRED') }
  if (controller && !catalog) { invalidOrcadControllerConfig('CONTROLLER_STARTUP_CATALOG_REQUIRED') }
  return Object.freeze({ catalog, ops, ...(controller ? { controller } : {}) })
}

/** Publish ownership before Ops validation so the entry's existing failure cleanup can always close Catalog. */
export async function prepareOrcadStartup(
  input: OrcadStartupConfig, ownCatalog: (catalog: OrcadStartupOwner | null) => void,
  readProviderSettings?: () => InitialCodexNativeSettings, readCodexCredential?:ManagedCodexCredentialReader
): Promise<Pick<OrcaRuntimeRpcServerOptions, 'durableCatalogRead' | 'opsHttp' | 'durableTerminalInputCommitted' | 'durableTerminalOutputAvailable' | 'durableTerminalRuntime' | 'durableCancelRequested' | 'durableManagedProviders'>> {
  const ops = input.ops === null ? null : captureOrcadOpsConfig(input.ops)
  const controller = input.controller == null ? null : captureOrcadControllerConfig(input.controller)
  if (ops && !input.catalog) { invalidOrcadOpsConfig('OPS_STARTUP_CATALOG_REQUIRED') }
  if (controller && !input.catalog) { invalidOrcadControllerConfig('CONTROLLER_STARTUP_CATALOG_REQUIRED') }
  const wakePolicy = readOrcadManagedWakePolicy(controller)
  const catalog = await prepareOrcadDurableCatalog(input.catalog)
  const controllerOwner = catalog && controller ? ownOrcadController(catalog, readProviderSettings,readCodexCredential,wakePolicy) : null
  // Stop order after entry RPC/subscription cleanup: publication → controller → original Catalog Pool.
  const publication = catalog && ops ? ownOrcadOpsPublication(controllerOwner ?? catalog) : null
  const owner = publication ?? controllerOwner ?? catalog
  const browserSessions = createOrcadOpsBrowserSessionOwner(owner)
  // Register before Ops validation. This closure also owns an authority created later.
  ownCatalog(owner ? Object.freeze({ readConfig: owner.readConfig, stop: browserSessions.stop,
    ...(controllerOwner ? { controllerSnapshot: controllerOwner.controllerSnapshot.bind(controllerOwner) } : {}) }) : null)
  try {
    browserSessions.assertOpen()
    let opsHttp = await prepareOrcadOps(ops, catalog?.readConfig,wakePolicy)
    browserSessions.assertOpen()
    let readConfig = catalog?.readConfig
    if (opsHttp && readConfig) {
      const composition = browserSessions.connect(opsHttp)
      readConfig = Object.freeze({ ...readConfig, browserOpsAuth: composition.browserOpsAuth })
      opsHttp = composition.opsHttp
    }
    if (opsHttp && publication) { await publication.startPublication(opsHttp) }
    if (controller && controllerOwner) { await controllerOwner.startController(controller) }
    browserSessions.assertOpen()
    return readConfig ? Object.freeze({ durableCatalogRead: readConfig,
      ...(controllerOwner ? { durableTerminalInputCommitted: controllerOwner.onTerminalInputCommitted,
        durableTerminalOutputAvailable: controllerOwner.assertTerminalOutputAvailable,
        durableTerminalRuntime: controllerOwner.currentTerminalRuntime,
        durableManagedProviders: controllerOwner.managedProviders,
        durableCancelRequested: controllerOwner.onCancelRequested } : {}),
      ...(opsHttp ? { opsHttp } : {}) }) : Object.freeze({})
  } catch (error) {
    await browserSessions.stop().catch(() => {})
    throw error
  }
}

/** Borrow the validated Catalog owner; neither allocate nor close a Pool/listener here. */
export async function prepareOrcadOps(
  input: OrcadOpsConfig | null,
  readConfig: DurableCatalogReadConfig | undefined, wakePolicy?: LifecyclePolicy
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
      { createPgOpsServices }, { OPS_REPLAY_STREAM }, { getOpsUiAsset }, catalogScope] = await Promise.all([
      import('../durable-runtime/catalog/read.ts'), import('../durable-runtime/ops/pg-services.ts'),
      import('../durable-runtime/replay/types.ts'), import('../durable-runtime/ops-ui/index.ts'),
      config.workspaceScope === 'catalog' ? import('./orcad-ops-catalog-scope.ts') : undefined
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
    const servicesConfig = Object.freeze({ pool: catalog.pool, scope, streamId: OPS_REPLAY_STREAM,
      lifecyclePolicy: wakePolicy ?? config.lifecyclePolicy, controllerConnected: false })
    return Object.freeze({ origin: config.origin, scope, streamId: OPS_REPLAY_STREAM,
      pollIntervalMs: config.pollIntervalMs, ui: getOpsUiAsset,
      services: catalogScope ? catalogScope.createOrcadOpsCatalogScopeServices(catalog, servicesConfig)
        : createPgOpsServices(servicesConfig) })
  } catch (error) {
    if (error instanceof OrcadOpsConfigurationError) { throw error }
    invalidOrcadOpsConfig('OPS_STARTUP_UNAVAILABLE')
  }
}
