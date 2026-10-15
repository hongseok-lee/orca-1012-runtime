import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { captureCatalogReadContext } from './context.ts'
import { prepareCatalogCall } from '../catalog/request.ts'
import { reserveCatalogBrowserTab } from '../catalog/browser.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { CatalogError } from '../catalog/errors.ts'
import { catalogBrowserMaterialization, readCatalogBrowserState, validateCatalogBrowserRequest } from './browser-create-state.ts'

/** Source-only seam: registration in public.ts/registry.ts is a separate owner step. */
export function createCatalogBrowserCreateRpc(input: CapturedCatalogReadConfig) {
  const ownerPool = input.pool
  const connect = ownerPool.connect.bind(ownerPool)
  const assertCurrentHost = input.assertCurrentHost.bind(input)
  const carrier: Pool = Object.create(ownerPool)
  const pool = new Proxy(carrier, {
    get(_target, property) {
      if (property === 'connect') { return connect }
      const value = Reflect.get(ownerPool, property, ownerPool)
      return typeof value === 'function' ? value.bind(ownerPool) : value
    }
  })
  const config = Object.freeze({ ...input, pool, assertCurrentHost })
  return async (params: unknown, context: RpcContext): Promise<{ browserPageId: string }> => {
    // No RpcContext, credential or mutable owner survives as a deferred argument.
    const call = prepareCatalogCall('browser.tabCreate', params, captureCatalogReadContext(config, context))
    const original = call.original
    if (!original || typeof original !== 'object' || Array.isArray(original)) {
      throw new CatalogError('CATALOG_PARAMS')
    }
    validateCatalogBrowserRequest(original.params)
    const runtime = context.runtime
    const create = runtime.browserTabCreate.bind(runtime)
    const caller = Object.freeze({ pairedDeviceId: context.pairedDeviceId, clientKind: context.clientKind })
    const launch = Object.freeze({ tabId: logicalId('tab', randomUUID()), browserPageId: call.params.page ?? randomUUID() })
    const selector = call.params.worktree!
    const initial = await readCatalogBrowserState(config, call, selector)
    // Freeze the resolver-owned Workspace across a mutable `active`/alias selector.
    // Original request/hash/key remain unchanged; generated IDs are only launch data.
    const bound = Object.freeze({ ...call, params: Object.freeze({ ...call.params, worktree: `id:${initial.workspace.public_id}` }) })
    const outcome = await reserveCatalogBrowserTab(pool, bound, launch)
    assertCurrentHost()
    if (outcome.status === 'UNCERTAIN') {
      // Legacy Browser params carry no stable mutation key. Do not silently retry
      // or return a new page: the original receipt key needs operator resolution.
      throw new CatalogError('CATALOG_BROWSER_COMMIT_UNCERTAIN')
    }
    const response = outcome.receipt.response
    if (!response || typeof response !== 'object' || Array.isArray(response) ||
        Object.keys(response).length !== 1 || response.browserPageId !== launch.browserPageId) {
      throw new CatalogError('CATALOG_BROWSER_RESERVATION_RESPONSE')
    }
    const state = await readCatalogBrowserState(config, call, `id:${initial.workspace.public_id}`, launch.browserPageId)
    const tab = state.tab!
    if (tab.lifecycle !== 'OPEN' || state.workspace.deleted_at !== null) {
      if (outcome.status === 'REPLAYED') { return { browserPageId: launch.browserPageId } }
      throw new CatalogError('CATALOG_BROWSER_CLOSED_BEFORE_CREATE')
    }
    const materialize = catalogBrowserMaterialization(state.workspace, tab)
    const result = await create({ ...materialize,
      activate: call.params.activate, navigation: call.params.navigation,
      targetGroupId: call.params.targetGroupId, waitForRegistration: call.params.waitForRegistration }, caller)
    // A native error is propagated unchanged; its committed Tab/receipt are retained.
    assertCurrentHost()
    if (result.browserPageId !== launch.browserPageId) { throw new CatalogError('CATALOG_BROWSER_NATIVE_PAGE_MISMATCH') }
    const current = await readCatalogBrowserState(config, call, `id:${initial.workspace.public_id}`, launch.browserPageId)
    if (current.tab!.tab_id !== tab.tab_id || current.workspace.workspace_id !== state.workspace.workspace_id) {
      throw new CatalogError('CATALOG_BROWSER_IDENTITY_CHANGED')
    }
    if (current.tab!.lifecycle !== 'OPEN' || current.workspace.deleted_at !== null) {
      // The existing create/close wire exposes no generation token. A follow-up
      // close could hit a replacement generation, so do not issue it blindly.
      // Physical termination is unverified: return failure, never reopen/publish
      // the tombstone or claim a successful caller selection after this race.
      throw new CatalogError('CATALOG_BROWSER_CLOSED_DURING_CREATE_CLEANUP_UNVERIFIED')
    }
    return { browserPageId: launch.browserPageId }
  }
}
