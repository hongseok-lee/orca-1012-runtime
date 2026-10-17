import type { Pool } from 'pg'
import type { MutationOutcome } from '../db/atomic.ts'
import type { CatalogEntries } from './facade.ts'
import type { CatalogMethod, CatalogWireResults } from './wire.ts'
import type { PreparedCatalogLaunch } from './launch.ts'
import type { PreparedCatalogClose } from './close.ts'
import type { PreparedCatalogSleep } from './sleep.ts'
import type { CatalogOwnerEntries } from './owners.ts'
import type { PreparedCatalogBindingObservation, CatalogPhysicalObservationAuthority } from './binding.ts'
import { readCatalogSnapshot, resolveCatalogWorkspace, withCatalogReadSnapshot } from './read.ts'
import { projectCatalogList, projectCatalogPs, projectCatalogWorktree, readAllCatalogTabs, readCatalogWorkspaceTabs } from './projection.ts'
import { activateCatalogWorkspace, renameCatalogTerminal, selectCatalogTab, updateCatalogUi, updateCatalogWorkspace } from './metadata.ts'
import { reserveCatalogWorkspace, createCatalogTerminal } from './create.ts'
import { closeCatalogTab } from './close.ts'
import { reserveCatalogSleep } from './sleep.ts'
import { applyCatalogBindingObservation } from './binding.ts'
import { parseCatalogWorkspace } from './payload.ts'
import { parseCatalogUi } from './ui.ts'
import { CatalogError } from './errors.ts'
import type { PreparedCatalogCall } from './request.ts'
import { capturePreparedCatalogCall } from './mutation.ts'
import { captureCatalogClose } from './close.ts'
import { reserveCatalogRemoval, type PreparedCatalogRemoval } from './remove.ts'
import { reserveCatalogBrowserTab, type PreparedCatalogBrowserLaunch } from './browser.ts'
import { updateCatalogTabProps, type CatalogTabPropsVisibility } from './tab-props.ts'

export type CatalogPreparedEntries = {
  /** Supplied before invoking the request; neither method is a public proof issuer. */
  readonly launch?: PreparedCatalogLaunch
  readonly close?: PreparedCatalogClose
  readonly sleep?: PreparedCatalogSleep
  readonly removal?: PreparedCatalogRemoval
  readonly binding?: PreparedCatalogBindingObservation
  readonly physicalAuthority?: CatalogPhysicalObservationAuthority
  readonly browser?: PreparedCatalogBrowserLaunch
  readonly tabPropsVisibility?: CatalogTabPropsVisibility
}

function response<Method extends CatalogMethod>(outcome: MutationOutcome): CatalogWireResults[Method] {
  if (outcome.status === 'UNCERTAIN') {throw new CatalogError('CATALOG_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY')}
  // Callback and receipt use the same imported incumbent wire projection.
  return outcome.receipt.response as unknown as CatalogWireResults[Method]
}

async function handleWorkspace(pool: Pool, call: PreparedCatalogCall, terminal: string): Promise<string> {
  return withCatalogReadSnapshot(pool, async tx => {
    const rows = (await tx.query<{ public_id: string }>(`SELECT w.public_id FROM durable_runtime.tabs t
      JOIN durable_runtime.workspaces w ON w.id=t.workspace_id WHERE t.terminal_handle=$1`, [terminal])).rows
    if (rows.length !== 1) {throw new CatalogError('CATALOG_TERMINAL_NOT_FOUND')}
    // Authorize the resolved stable object, including tombstones for receipt replay.
    const workspace = await resolveCatalogWorkspace(tx, `id:${rows[0].public_id}`, call.context.authority)
    return workspace.public_id
  })
}

/** No method registry/server activation. Runtime preparation remains outside this module. */
export function createCatalogEntries(pool: Pool, owners: CatalogOwnerEntries, prepared: CatalogPreparedEntries = {}): CatalogEntries {
  const entries = Object.freeze({ ...owners }), supplied = Object.freeze({ ...prepared })
  const need = <Key extends keyof CatalogPreparedEntries>(key: Key): NonNullable<CatalogPreparedEntries[Key]> => {
    const value = supplied[key]
    if (!value) {throw new CatalogError('CATALOG_PREPARED_AUTHORITY_REQUIRED')}
    return value as NonNullable<CatalogPreparedEntries[Key]>
  }
  return {
    'repo.list': async call => ({ repos: [...(await readCatalogSnapshot(pool, call.context.authority)).repositories] }),
    'projectGroup.list': async call => ({ groups: [...(await readCatalogSnapshot(pool, call.context.authority)).projectGroups] }),
    'folderWorkspace.list': async call => ({ folderWorkspaces: (await readCatalogSnapshot(pool, call.context.authority)).workspaces
      .filter(row => row.kind === 'FOLDER_WORKSPACE').map(row => parseCatalogWorkspace(row) as CatalogWireResults['folderWorkspace.list']['folderWorkspaces'][number]) }),
    'worktree.list': async call => projectCatalogList(await readCatalogSnapshot(pool, call.context.authority), call),
    'worktree.ps': async call => projectCatalogPs(await readCatalogSnapshot(pool, call.context.authority), call),
    'worktree.show': async call => withCatalogReadSnapshot(pool, async tx => {
      const workspace = await resolveCatalogWorkspace(tx, call.params.worktree, call.context.authority)
      if (workspace.deleted_at !== null) {throw new CatalogError('CATALOG_WORKSPACE_DELETED')}
      return { worktree: projectCatalogWorktree(workspace) }
    }),
    'worktree.create': async call => response<'worktree.create'>(await reserveCatalogWorkspace(pool, call, need('launch'), entries)),
    'worktree.set': async call => response<'worktree.set'>(await updateCatalogWorkspace(pool, call)),
    'worktree.activate': async call => response<'worktree.activate'>(await activateCatalogWorkspace(pool, call)),
    'worktree.sleep': async call => {
      const outcome = await reserveCatalogSleep(pool, call, need('sleep'), entries)
      if (outcome.status === 'UNCERTAIN') {throw new CatalogError('CATALOG_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY')}
      const result = outcome.receipt.response as { worktreeId: string; reservation: { status: string; reason?: string } }
      if (result.reservation.status !== 'RESERVED') {throw new CatalogError(`CATALOG_SLEEP_DEFERRED_${result.reservation.reason ?? 'UNKNOWN'}`)}
      return { worktreeId: result.worktreeId }
    },
    'worktree.rm': async call => {
      const outcome = await reserveCatalogRemoval(pool, call, need('removal'), entries)
      if (outcome.status === 'UNCERTAIN') {throw new CatalogError('CATALOG_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY')}
      return { removed: false, warning: 'Logical removal and cleanup intent reserved; physical deletion is unverified.' }
    },
    'ui.get': async call => {
      const row = (await readCatalogSnapshot(pool, call.context.authority)).ui
      if (!row) {throw new CatalogError('CATALOG_UI_NOT_INITIALIZED')}
      return { ui: parseCatalogUi(row.payload) }
    },
    'ui.set': async call => response<'ui.set'>(await updateCatalogUi(pool, call)),
    'session.tabs.list': call => readCatalogWorkspaceTabs(pool, call),
    'session.tabs.listAll': call => readAllCatalogTabs(pool, call),
    'session.tabs.createTerminal': async call => response<'session.tabs.createTerminal'>(await createCatalogTerminal(pool, call, need('launch'), entries)),
    'browser.tabCreate': async call => response<'browser.tabCreate'>(await reserveCatalogBrowserTab(pool, call, need('browser'))),
    'session.tabs.activate': async call => response<'session.tabs.activate'>(await selectCatalogTab(pool, call)),
    'session.tabs.setTabProps': async call => response<'session.tabs.setTabProps'>(await updateCatalogTabProps(pool, call, supplied.tabPropsVisibility)),
    'session.tabs.close': async call => response<'session.tabs.close'>(await closeCatalogTab(pool, call, call.params.worktree, need('close'), entries)),
    'session.tabs.closeLifecycle': async call => response<'session.tabs.closeLifecycle'>(await applyCatalogBindingObservation(pool, call, need('binding'), need('physicalAuthority'))),
    'terminal.focus': async input => {
      const call = capturePreparedCatalogCall(input)
      const workspace = await handleWorkspace(pool, call, call.params.terminal)
      return response<'terminal.focus'>(await selectCatalogTab(pool, call, workspace))
    },
    'terminal.rename': async input => {
      const call = capturePreparedCatalogCall(input)
      const workspace = await handleWorkspace(pool, call, call.params.terminal)
      return response<'terminal.rename'>(await renameCatalogTerminal(pool, call, workspace))
    },
    'terminal.close': async input => {
      const call = capturePreparedCatalogCall(input), close = captureCatalogClose(need('close'))
      const workspace = await handleWorkspace(pool, call, call.params.terminal)
      return response<'terminal.close'>(await closeCatalogTab(pool, call, workspace, close, entries))
    }
  }
}
