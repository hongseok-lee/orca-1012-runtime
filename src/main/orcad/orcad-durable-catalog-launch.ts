import { captureCatalogLaunchConfig, type CatalogLaunchConfig } from '../durable-runtime/rpc/launch-config.ts'

/** Optional plain private data only; no environment or credential access. */
export function captureOrcadCatalogLaunchConfig(
  descriptor: PropertyDescriptor | undefined, repositoryIds: readonly string[]
): CatalogLaunchConfig | undefined {
  if (descriptor === undefined) { return undefined }
  if (!('value' in descriptor)) { throw Object.assign(new Error('CATALOG_LAUNCH_CONFIGURATION'), { code: 'CATALOG_LAUNCH_CONFIGURATION' }) }
  return captureCatalogLaunchConfig(descriptor.value, repositoryIds)
}
