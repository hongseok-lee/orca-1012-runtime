import type { Pool } from 'pg'
import type { TabId } from '../../../shared/durable-runtime/identity.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { normalizeBrowserNavigationUrl } from '../../../shared/browser-url.ts'
import type { RuntimeMobileSessionBrowserTab } from '../../../shared/runtime-mobile-session-tab-contracts.ts'
import { BrowserTabCreateParams } from '../../../shared/rpc-contract/browser-tab-create-params.ts'
import type { MutationOutcome } from '../db/atomic.ts'
import type { CatalogTab } from './read.ts'
import type { PreparedCatalogCall } from './request.ts'
import { captureCatalogJson, captureCatalogParsed } from './immutable.ts'
import { capturePreparedCatalogCall, lockCatalogWorkspaceMetadata, mutateCatalogWorkspace, publishCatalogMutation } from './mutation.ts'
import { parseCatalogTab } from './payload.ts'
import { CatalogError } from './errors.ts'

/** The caller allocates both IDs once before its first await; Catalog issues neither. */
export type PreparedCatalogBrowserLaunch = {
  readonly tabId: TabId
  readonly browserPageId: string
}

export function captureCatalogBrowserLaunch(input: PreparedCatalogBrowserLaunch): PreparedCatalogBrowserLaunch {
  const captured = captureCatalogParsed(input)
  if (typeof captured.browserPageId !== 'string' || !captured.browserPageId) {
    throw new CatalogError('CATALOG_BROWSER_PAGE_ID')
  }
  return Object.freeze({ tabId: logicalId('tab', captured.tabId), browserPageId: captured.browserPageId })
}

/** Retain public params verbatim, never an extra bearer, RpcContext or launch DTO. */
function browserLaunchRequest(call: PreparedCatalogCall<'browser.tabCreate'>) {
  const request = captureCatalogJson(call.original)
  if (request === null || typeof request !== 'object' || Array.isArray(request) ||
      request.method !== 'browser.tabCreate' || request.params === null ||
      typeof request.params !== 'object' || Array.isArray(request.params) ||
      Object.keys(request).some(key => !['method', 'paramsSupplied', 'params'].includes(key)) ||
      Object.keys(request.params).some(key => !Object.hasOwn(BrowserTabCreateParams.shape, key))) {
    throw new CatalogError('CATALOG_BROWSER_REQUEST')
  }
  return request
}

/** Logical PG reservation only; no page load, Session, Agent, wake or physical writer. */
export async function reserveCatalogBrowserTab(
  pool: Pool, input: PreparedCatalogCall<'browser.tabCreate'>, inputLaunch: PreparedCatalogBrowserLaunch
): Promise<MutationOutcome> {
  const call = capturePreparedCatalogCall(input), launch = captureCatalogBrowserLaunch(inputLaunch)
  const selector = call.params.worktree
  if (!selector) {throw new CatalogError('CATALOG_WORKSPACE_SELECTOR_REQUIRED')}
  if (call.params.page !== undefined && call.params.page !== launch.browserPageId) {
    throw new CatalogError('CATALOG_BROWSER_PAGE_ID')
  }
  const url = normalizeBrowserNavigationUrl(call.params.url ?? 'about:blank')
  if (url === null) {throw new CatalogError('CATALOG_BROWSER_URL')}
  const launchRequest = browserLaunchRequest(call)
  return mutateCatalogWorkspace(pool, call, selector, async (tx, workspace, membership) => {
    // One page key serializes cross-Workspace creates; the Workspace key owns ui_order.
    await lockCatalogWorkspaceMetadata(tx, membership, [`browser-page:${launch.browserPageId}`])
    const existing = (await tx.query<CatalogTab>(`SELECT m.*,t.workspace_id,t.session_id,t.kind,
      t.terminal_handle,t.lifecycle,t.revision AS tab_revision FROM durable_runtime.catalog_tab_metadata m
      JOIN durable_runtime.tabs t ON t.id=m.tab_id WHERE m.public_tab_id=$1`, [launch.browserPageId])).rows[0]
    if (existing) {
      if (existing.workspace_id !== workspace.workspace_id || existing.kind !== 'browser') {
        throw new CatalogError('CATALOG_BROWSER_PAGE_CONFLICT')
      }
      if (existing.lifecycle !== 'OPEN') {throw new CatalogError('CATALOG_BROWSER_PAGE_CLOSED')}
      const payload = parseCatalogTab(existing)
      if (payload.type !== 'browser' || payload.browserPageId !== launch.browserPageId ||
          payload.browserWorkspaceId !== launch.browserPageId) {throw new CatalogError('CATALOG_BROWSER_PAGE_CONFLICT')}
      return { browserPageId: existing.public_tab_id }
    }
    const last = (await tx.query<{ maximum: string | null }>(
      'SELECT max(ui_order)::text AS maximum FROM durable_runtime.tabs WHERE workspace_id=$1', [workspace.workspace_id])).rows[0].maximum
    const uiOrder = last === null ? 0n : BigInt(last) + 1n
    if (uiOrder < 0n || uiOrder > BigInt(Number.MAX_SAFE_INTEGER)) {throw new CatalogError('CATALOG_BROWSER_UI_ORDER')}
    const payload: RuntimeMobileSessionBrowserTab = {
      type: 'browser', id: launch.browserPageId, title: url,
      browserWorkspaceId: launch.browserPageId, browserPageId: launch.browserPageId,
      ...(call.params.profileId === undefined ? {} : { browserProfileId: call.params.profileId }),
      url, loading: true, canGoBack: false, canGoForward: false, isActive: false
    }
    await tx.query(`INSERT INTO durable_runtime.tabs
      (id,workspace_id,session_id,kind,terminal_handle,leaf_id,pane_key,ui_order,lifecycle)
      VALUES($1,$2,NULL,'browser',NULL,NULL,NULL,$3,'OPEN')`, [launch.tabId, workspace.workspace_id, uiOrder.toString()])
    await tx.query(`INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request)
      VALUES($1,$2,$3,$4)`, [launch.tabId, launch.browserPageId, JSON.stringify(payload), JSON.stringify(launchRequest)])
    await publishCatalogMutation(tx, call, workspace.workspace_id, 'CATALOG_BROWSER_TAB_RESERVED', { browserPageId: launch.browserPageId })
    return { browserPageId: launch.browserPageId }
  })
}
