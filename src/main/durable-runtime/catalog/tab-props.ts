import type { Pool } from 'pg'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts.ts'
import type { RuntimeMobileSessionClientTab } from '../../../shared/runtime-mobile-session-tab-contracts.ts'
import type { MutationOutcome } from '../db/atomic.ts'
import { capturePreparedCatalogCall, lockCatalogWorkspaceMetadata, mutateCatalogWorkspace, publishCatalogMutation } from './mutation.ts'
import { loadCatalogTabs } from './metadata.ts'
import { readWorkspaceTabsInTransaction } from './projection.ts'
import { parseCatalogTab } from './payload.ts'
import type { PreparedCatalogCall } from './request.ts'
import { CatalogError } from './errors.ts'

/** Borrowed, synchronous client projection check; Catalog authority still owns scope. */
export type CatalogTabPropsVisibility = {
  assertVisible(snapshot: RuntimeMobileSessionTabsResult, tabId: string): void
}

function topLevel(tab: RuntimeMobileSessionClientTab): string {
  return tab.type === 'terminal' ? tab.parentTabId : tab.id
}

/** Same leaf -> host parent resolution as the existing headless setter. */
export async function updateCatalogTabProps(
  pool: Pool, input: PreparedCatalogCall<'session.tabs.setTabProps'>, visibility?: CatalogTabPropsVisibility
): Promise<MutationOutcome> {
  const call = capturePreparedCatalogCall(input)
  const assertVisible = visibility?.assertVisible.bind(visibility)
  return mutateCatalogWorkspace(pool, call, call.params.worktree, async (tx, workspace, membership) => {
    await lockCatalogWorkspaceMetadata(tx, membership)
    const rows = await loadCatalogTabs(tx, workspace.workspace_id)
    const parsed = rows.map(row => ({row, tab: parseCatalogTab(row)}))
    const exact = parsed.find(({tab}) => tab.id === call.params.tabId)
    if (exact?.row.lifecycle === 'CLOSED') { throw new CatalogError('CATALOG_TAB_CLOSED') }
    const open = parsed.filter(({row}) => row.lifecycle === 'OPEN')
    const selected = exact ?? open.find(({tab}) => tab.type === 'terminal' && tab.parentTabId === call.params.tabId) ??
      open.find(({tab}) => tab.type === 'browser' && tab.browserWorkspaceId === call.params.tabId)
    if (!selected) { throw new CatalogError('CATALOG_TAB_NOT_FOUND') }
    if (assertVisible && assertVisible(await readWorkspaceTabsInTransaction(tx, workspace), call.params.tabId) !== undefined) {
      throw new CatalogError('CATALOG_ASYNC_TAB_VISIBILITY')
    }
    const parent = topLevel(selected.tab)
    const affected = open.filter(({tab}) => topLevel(tab) === parent)
    for (const {row, tab} of affected) {
      const payload = { ...row.payload,
        ...(call.params.color === undefined ? {} : {color: call.params.color}),
        ...(call.params.isPinned === undefined ? {} : {isPinned: call.params.isPinned}),
        // The incumbent persistent unified-tab path stores color/pin only;
        // terminal host parents also persist mode. Omission never resets it.
        ...(tab.type !== 'terminal' || call.params.viewMode === undefined ? {} : {viewMode: call.params.viewMode}) }
      parseCatalogTab({...row, payload})
      if (tab.type === 'terminal' && call.params.viewMode !== undefined &&
          (tab.viewMode ?? 'terminal') !== call.params.viewMode) {
        const changed = await tx.query('UPDATE durable_runtime.tabs SET revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING revision',
          [row.tab_id, row.tab_revision])
        if (changed.rowCount !== 1) { throw new CatalogError('CATALOG_TAB_CHANGED') }
      }
      await tx.query('UPDATE durable_runtime.catalog_tab_metadata SET payload=$2,updated_at=clock_timestamp() WHERE tab_id=$1',
        [row.tab_id, JSON.stringify(payload)])
    }
    await publishCatalogMutation(tx, call, workspace.workspace_id, 'CATALOG_TAB_PROPS_UPDATED', {
      tabId: parent, publicTabIds: affected.map(({tab}) => tab.id),
      fields: ['color', 'isPinned', 'viewMode'].filter(key => Object.hasOwn(call.params, key)) })
    return {updated: true}
  })
}
