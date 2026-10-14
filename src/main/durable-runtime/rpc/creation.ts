import type { CatalogWireResults } from '../catalog/wire.ts'
import type { Repo } from '../../../shared/repo-types.ts'
import { getRepoExecutionHostId } from '../../../shared/execution-host.ts'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../shared/runtime-session-contracts.ts'
import { CatalogCompatibilityFacade } from '../catalog/facade.ts'
import { createCatalogEntries } from '../catalog/entries.ts'
import { catalogReceiptIdentity, type PreparedCatalogCall, type ResolvedCatalogScope } from '../catalog/request.ts'
import { readCatalogSnapshot, resolveCatalogWorkspace, withCatalogReadSnapshot } from '../catalog/read.ts'
import { catalogWorkspaceScope } from '../catalog/mutation.ts'
import { parseCatalogRepo } from '../catalog/payload.ts'
import { CatalogError } from '../catalog/errors.ts'
import { resolveReceipt } from '../db/atomic.ts'
import { recordUnitIntent } from '../lifecycle/intent.ts'
import { reserveSleep } from '../lifecycle/sleep.ts'
import { recordInputCancel } from '../input/cancel.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { captureReadInvocation, projectTabs, validateCatalogSnapshot, type CatalogReadInvocation } from './read.ts'
import { prepareCatalogTerminalLaunch, prepareCatalogWorktreeLaunch, type CatalogCreationMethod, type ExistingCatalogLaunchUnit } from './launch-preparation.ts'

export const CATALOG_PUBLIC_CREATION_METHODS = Object.freeze(['worktree.create', 'session.tabs.createTerminal'] as const)
const owners = Object.freeze({ recordUnitIntent, reserveSleep, recordInputCancel })

async function guard(config: CapturedCatalogReadConfig, call: PreparedCatalogCall): Promise<void> {
  validateCatalogSnapshot(config, await readCatalogSnapshot(config.pool, call.context.authority))
}
async function receipt(config: CapturedCatalogReadConfig, call: PreparedCatalogCall, scope: ResolvedCatalogScope) {
  const result = await resolveReceipt(config.pool, catalogReceiptIdentity(call, scope))
  if (result.status === 'UNAVAILABLE') { throw new CatalogError('CATALOG_RECEIPT_UNAVAILABLE') }
  config.assertCurrentHost()
  return result
}
async function repository(config: CapturedCatalogReadConfig, call: PreparedCatalogCall, selector: string): Promise<Repo> {
  const key = selector.startsWith('id:') ? selector.slice(3) : selector
  const rows = await withCatalogReadSnapshot(config.pool, async tx => (await tx.query<{ id: string; payload: Record<string, unknown> }>(
    'SELECT id,payload FROM durable_runtime.catalog_repositories')).rows)
  // Include tombstones; current registration state is the core's post-receipt concern.
  const matches = rows.filter(row => call.context.authority.repositoryIds.includes(row.id) &&
    (row.id === key || row.payload.path === key || row.payload.displayName === key))
  if (matches.length !== 1) { throw new CatalogError(matches.length ? 'CATALOG_REPO_AMBIGUOUS' : 'CATALOG_REPO_NOT_FOUND') }
  const repo = parseCatalogRepo(matches[0])
  if (getRepoExecutionHostId(repo) !== config.hostId) { throw new CatalogError('CATALOG_REGISTRATION_HOST_MISMATCH') }
  config.assertCurrentHost()
  return repo
}
async function createWorktree(config: CapturedCatalogReadConfig, call: PreparedCatalogCall<'worktree.create'>) {
  await guard(config, call)
  const repo = await repository(config, call, call.params.repo)
  const replay = await receipt(config, call, `repo:${repo.id}` as ResolvedCatalogScope)
  if (replay.status === 'FOUND') { return replay.receipt.response as unknown as CatalogWireResults['worktree.create'] }
  const names = await withCatalogReadSnapshot(config.pool, async tx => (await tx.query<{ normalized_name: string }>(
    'SELECT normalized_name FROM durable_runtime.catalog_name_reservations WHERE namespace=$1', [repo.id])).rows.map(row => row.normalized_name))
  config.assertCurrentHost()
  const launch = prepareCatalogWorktreeLaunch(config, call, repo, names)
  return createCatalogEntries(config.pool, owners, { launch })['worktree.create'](call)
}
async function createTerminal(config: CapturedCatalogReadConfig, call: PreparedCatalogCall<'session.tabs.createTerminal'>) {
  await guard(config, call)
  const workspace = await withCatalogReadSnapshot(config.pool, tx => resolveCatalogWorkspace(tx, call.params.worktree, call.context.authority))
  const replay = await receipt(config, call, catalogWorkspaceScope(workspace))
  if (replay.status === 'FOUND') { return replay.receipt.response as unknown as RuntimeMobileSessionCreateTerminalResult }
  if (!workspace.repo_id || workspace.kind === 'FOLDER_WORKSPACE') { throw new CatalogError('CATALOG_METHOD_NOT_CONNECTED') }
  const repo = await repository(config, call, `id:${workspace.repo_id}`)
  const preparation = await withCatalogReadSnapshot(config.pool, async tx => {
    const members = (await tx.query<ExistingCatalogLaunchUnit>(`SELECT m.runtime_unit_id AS "unitId",b.id AS "bindingId",
      b.backend_id AS "backendId",b.export_id AS "exportId",b.canonical_directory AS "canonicalDirectory"
      FROM durable_runtime.runtime_members m JOIN durable_runtime.storage_bindings b ON b.id=m.storage_binding_id
      WHERE m.runtime_unit_id=$1 ORDER BY m.session_id`, [workspace.runtime_unit_id])).rows
    if (!members.length || members.some(row => row.unitId !== members[0].unitId || row.bindingId !== members[0].bindingId ||
        row.backendId !== members[0].backendId || row.exportId !== members[0].exportId || row.canonicalDirectory !== members[0].canonicalDirectory)) {
      throw new CatalogError('CATALOG_STORAGE_CONFIGURATION')
    }
    const row = (await tx.query<{ ui_order: number }>('SELECT ui_order FROM durable_runtime.tabs WHERE workspace_id=$1 ORDER BY ui_order DESC LIMIT 1', [workspace.workspace_id])).rows[0]
    return { unit: members[0], uiOrder: (row?.ui_order ?? -1) + 1 }
  })
  config.assertCurrentHost()
  const launch = prepareCatalogTerminalLaunch(config, call, repo, workspace, preparation.unit, preparation.uiOrder)
  return createCatalogEntries(config.pool, owners, { launch })['session.tabs.createTerminal'](call)
}
export function createCatalogCreationFacade(config: CapturedCatalogReadConfig): CatalogCompatibilityFacade {
  return new CatalogCompatibilityFacade({
    'worktree.create': call => createWorktree(config, call),
    'session.tabs.createTerminal': call => createTerminal(config, call)
  })
}
function projectTerminal(invocation: CatalogReadInvocation, result: RuntimeMobileSessionCreateTerminalResult): RuntimeMobileSessionCreateTerminalResult {
  // Project only the original receipt's terminal; never replace it with current
  // list state on replay. All non-tab response fields stay byte-for-byte values.
  const projected = projectTabs(invocation, { worktree: '', publicationEpoch: result.publicationEpoch,
    snapshotVersion: result.snapshotVersion, activeGroupId: null,
    activeTabId: result.tab.isActive ? result.tab.id : null, activeTabType: result.tab.isActive ? 'terminal' : null, tabs: [result.tab] })
  const tab = projected.tabs[0]
  if (!tab || tab.type !== 'terminal') { throw new CatalogError('CATALOG_TERMINAL_PROJECTION') }
  return { ...result, tab }
}
export async function createCatalogRpc(
  config: CapturedCatalogReadConfig, facade: CatalogCompatibilityFacade, method: CatalogCreationMethod, params: unknown, context: RpcContext
): Promise<unknown> {
  if (!config.launch) { throw new CatalogError('CATALOG_METHOD_NOT_CONNECTED') }
  const invocation = captureReadInvocation(config, params, context)
  if (method === 'session.tabs.createTerminal') {
    return projectTerminal(invocation, await facade.invoke(method, invocation.params, invocation.context))
  }
  return facade.invoke(method, invocation.params, invocation.context)
}
