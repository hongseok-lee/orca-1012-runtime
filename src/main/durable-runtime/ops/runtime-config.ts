import type { OpsHttpConfig } from './types.ts'
import type { OpsServerScope } from './auth.ts'
import { bindOpsServices } from './routes.ts'
import { opsId } from './validation.ts'
import { OpsHttpError } from './errors.ts'
/** Optional startup input. The runtime supplies its actual DeviceRegistry verifier. */
export type RuntimeOpsHttpConfig = Omit<OpsHttpConfig, 'authenticateBearer'> & Readonly<{
  scope: OpsServerScope
  authenticateBrowserBearer?: OpsHttpConfig['authenticateBearer']
}>
export function snapshotRuntimeOpsHttpConfig(config: RuntimeOpsHttpConfig): RuntimeOpsHttpConfig {
  const descriptor = Object.getOwnPropertyDescriptor(config, 'authenticateBrowserBearer')
  if (descriptor && (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'function'))) {
    throw new OpsHttpError(503, 'invalid_configuration', 'The operations authentication owner is unavailable.')
  }
  const authenticateBrowserBearer = descriptor?.value?.bind(config)
  return Object.freeze({ origin: config.origin, streamId: config.streamId, pollIntervalMs: config.pollIntervalMs,
    ...(authenticateBrowserBearer ? { authenticateBrowserBearer } : {}),
    scope: Object.freeze({ datasetName: config.scope.datasetName, namespaceId: config.scope.namespaceId,
      workspaceIds: Object.freeze([...new Set(config.scope.workspaceIds.map(opsId))].sort()) }),
    services: bindOpsServices(config.services), ui: config.ui?.bind(config) })
}
/** Both verifiers see the same explicit Bearer value; no missing/invalid key gets an implicit page identity. */
export function createRuntimeOpsBearerVerifier(config: RuntimeOpsHttpConfig, pairing: OpsHttpConfig['authenticateBearer']): OpsHttpConfig['authenticateBearer'] {
  const captured = snapshotRuntimeOpsHttpConfig(config)
  const verifyPage = captured.authenticateBrowserBearer
  return async token => (await pairing(token)) ?? (await verifyPage?.(token)) ?? null
}
