import type { RuntimeCapability } from '../../../shared/protocol-version.ts'
import type { CatalogAuthority } from '../catalog/authority.ts'
import type { CatalogCallContext } from '../catalog/request.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { CatalogReadError } from './config.ts'

/** This internal context is created by the authenticated transport. Params and
 * raw clientId/token never participate in this server-owned namespace scope. */
export function captureCatalogReadContext(config: CapturedCatalogReadConfig, input: RpcContext): CatalogCallContext {
  const fingerprint = input.authenticatedCallerFingerprint
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new CatalogReadError('CATALOG_AUTHENTICATED_CALLER_REQUIRED')
  }
  config.assertCurrentHost()
  const authority = Object.freeze({
    principalId: JSON.stringify(['catalog-host-fingerprint-v1', config.datasetName, config.hostId, fingerprint]),
    repositoryIds: config.repositoryIds, projectGroupIds: config.projectGroupIds, workspacePublicIds: config.workspacePublicIds
  }) as CatalogAuthority
  const capabilities = input.clientCapabilities === undefined ? [] : [...input.clientCapabilities]
  if (capabilities.some(value => typeof value !== 'string' || !value)) { throw new CatalogReadError('CATALOG_CLIENT_CAPABILITIES') }
  return Object.freeze({ authority, capabilities: Object.freeze(capabilities) as readonly RuntimeCapability[] })
}
