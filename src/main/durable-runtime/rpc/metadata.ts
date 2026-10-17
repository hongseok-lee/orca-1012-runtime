import type { PreparedCatalogCall } from '../catalog/request.ts'
import type { CatalogWireResults } from '../catalog/wire.ts'
import { CatalogCompatibilityFacade } from '../catalog/facade.ts'
import { createCatalogEntries } from '../catalog/entries.ts'
import { readCatalogSnapshot } from '../catalog/read.ts'
import { recordUnitIntent } from '../lifecycle/intent.ts'
import { reserveSleep } from '../lifecycle/sleep.ts'
import { recordInputCancel } from '../input/cancel.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { captureReadInvocation, projectTabs, validateCatalogSnapshot } from './read.ts'
import type { CatalogTabPropsVisibility } from '../catalog/tab-props.ts'
import { assertProjectedSessionTabVisible } from '../../runtime/rpc/methods/session-tab-browser-placement-projection.ts'
import { CatalogError } from '../catalog/errors.ts'

export const CATALOG_PUBLIC_METADATA_METHODS = Object.freeze([
  'worktree.set', 'worktree.activate', 'ui.set', 'session.tabs.activate', 'session.tabs.setTabProps', 'session.tabs.close', 'terminal.focus', 'terminal.rename'
] as const)
export type CatalogMetadataMethod = typeof CATALOG_PUBLIC_METADATA_METHODS[number]

function guardedEntry<Method extends CatalogMetadataMethod>(
  config: CapturedCatalogReadConfig,
  entry: (call: PreparedCatalogCall<Method>) => Promise<CatalogWireResults[Method]>
): (call: PreparedCatalogCall<Method>) => Promise<CatalogWireResults[Method]> {
  return async call => {
    // The Facade has already captured params, authority and the original receipt
    // key before this first I/O. Never retry an uncertain COMMIT with a new key.
    const snapshot = await readCatalogSnapshot(config.pool, call.context.authority)
    validateCatalogSnapshot(config, snapshot)
    // No OPEN check here: the core resolves stable objects and replays its
    // original receipt before current tombstone/closed/incarnation checks.
    return entry(call)
  }
}

/** Borrows the read adapter's Pool/config. Real owner entries are supplied for
 * the incumbent Facade; these metadata methods never invoke lifecycle IO. */
export function createCatalogMetadataFacade(config: CapturedCatalogReadConfig, tabPropsVisibility?: CatalogTabPropsVisibility): CatalogCompatibilityFacade {
  const entries = createCatalogEntries(config.pool, { recordUnitIntent, reserveSleep, recordInputCancel }, { tabPropsVisibility, close: { inputAuthorities: [] } })
  return new CatalogCompatibilityFacade({
    'worktree.set': guardedEntry(config, entries['worktree.set']),
    'worktree.activate': guardedEntry(config, entries['worktree.activate']),
    'ui.set': guardedEntry(config, entries['ui.set']),
    'session.tabs.activate': guardedEntry(config, entries['session.tabs.activate']),
    'session.tabs.setTabProps': guardedEntry(config, entries['session.tabs.setTabProps']),
    'session.tabs.close': guardedEntry(config, entries['session.tabs.close']),
    'terminal.focus': guardedEntry(config, entries['terminal.focus']),
    'terminal.rename': guardedEntry(config, entries['terminal.rename'])
  })
}

export async function mutateCatalogRpc(
  config: CapturedCatalogReadConfig, facade: CatalogCompatibilityFacade,
  method: CatalogMetadataMethod, params: unknown, context: RpcContext
): Promise<unknown> {
  // Same transport fingerprint, detached params/capabilities/client kind and
  // structured policy as reads. Config captured the host method and receiver.
  const invocation = captureReadInvocation(config, params, context)
  if (method === 'session.tabs.setTabProps') {
    // Same incumbent client projection, checked again against the locked PG snapshot.
    const current = createCatalogMetadataFacade(config, { assertVisible(snapshot, tabId) {
      if (invocation.clientKind) {
        try { assertProjectedSessionTabVisible(projectTabs(invocation, snapshot), tabId) }
        catch { throw new CatalogError('tab_not_found') }
      }
    } })
    return current.invoke(method, invocation.params, invocation.context)
  }
  if (method === 'session.tabs.activate') {
    return projectTabs(invocation, await facade.invoke(method, invocation.params, invocation.context))
  }
  return facade.invoke(method, invocation.params, invocation.context)
}
