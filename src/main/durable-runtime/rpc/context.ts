import type { RuntimeCapability } from '../../../shared/protocol-version.ts'
import type { CatalogAuthority } from '../catalog/authority.ts'
import type { CatalogCallContext } from '../catalog/request.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { CatalogReadError } from './config.ts'

/** This internal context is created by the authenticated transport. Params and
 * raw clientId/token never participate in this server-owned namespace scope. */
export function captureCatalogReadContext(config: CapturedCatalogReadConfig, input: RpcContext): CatalogCallContext {
  return captureCatalogAuthenticatedContext(config, input).context
}
/** The same single authenticated fingerprint read serves Catalog authority and the private Browser capability. */
export function captureCatalogAuthenticatedContext(config: CapturedCatalogReadConfig, input: RpcContext) {
  const fingerprint = input.authenticatedCallerFingerprint
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new CatalogReadError('CATALOG_AUTHENTICATED_CALLER_REQUIRED')
  }
  config.assertCurrentHost()
  const authority = Object.freeze({
    principalId: JSON.stringify(['catalog-host-fingerprint-v1', config.datasetName, config.hostId, fingerprint]),
    repositoryIds: config.repositoryIds, projectGroupIds: config.projectGroupIds, workspacePublicIds: config.workspacePublicIds
  }) as CatalogAuthority
  const inputCapabilities = input.clientCapabilities
  const capabilities = inputCapabilities === undefined ? [] : [...inputCapabilities]
  if (capabilities.some(value => typeof value !== 'string' || !value)) { throw new CatalogReadError('CATALOG_CLIENT_CAPABILITIES') }
  const context: CatalogCallContext = Object.freeze({ authority, capabilities: Object.freeze(capabilities) as readonly RuntimeCapability[] })
  return Object.freeze({ context, authenticatedCallerFingerprint: fingerprint })
}
