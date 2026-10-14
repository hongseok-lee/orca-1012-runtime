import type { OpsHttpConfig } from './types.ts'
import type { OpsServerScope } from './auth.ts'
import { bindOpsServices } from './routes.ts'
import { opsId } from './validation.ts'
/** Optional startup input. The runtime supplies its actual DeviceRegistry verifier. */
export type RuntimeOpsHttpConfig = Omit<OpsHttpConfig, 'authenticateBearer'> & Readonly<{ scope: OpsServerScope }>
export function snapshotRuntimeOpsHttpConfig(config: RuntimeOpsHttpConfig): RuntimeOpsHttpConfig {
  return Object.freeze({ origin: config.origin, streamId: config.streamId, pollIntervalMs: config.pollIntervalMs,
    scope: Object.freeze({ datasetName: config.scope.datasetName, namespaceId: config.scope.namespaceId,
      workspaceIds: Object.freeze([...new Set(config.scope.workspaceIds.map(opsId))].sort()) }),
    services: bindOpsServices(config.services), ui: config.ui?.bind(config) })
}
