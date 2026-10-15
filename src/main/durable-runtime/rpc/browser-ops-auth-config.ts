import type { BrowserOpsAuthIssuer } from '../../runtime/browser-ops-auth-capability.ts'
import { captureBrowserOpsOrigin, ownBrowserAuthValue } from '../../runtime/browser-ops-auth-capability.ts'

export function captureCatalogBrowserOpsAuth(descriptor: PropertyDescriptor | undefined): BrowserOpsAuthIssuer | undefined {
  if (!descriptor) { return undefined }
  if (!('value' in descriptor)) { throw new Error('CATALOG_SERVER_CONFIG') }
  const value = descriptor.value
  if (value === undefined) { return undefined }
  const origin = captureBrowserOpsOrigin(ownBrowserAuthValue(value, 'origin'))
  const issue = ownBrowserAuthValue(value, 'issuePageSession')
  if (typeof issue !== 'function') { throw new Error('CATALOG_SERVER_CONFIG') }
  return Object.freeze({ origin, issuePageSession: issue.bind(value) })
}
