import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { DurableCatalogReadAdapter } from './public.ts'
import { BROWSER_SCREENCAST_METHODS } from '../../runtime/rpc/methods/browser-screencast.ts'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher.ts'
import { createOrcadCatalogBrowserPublication } from '../../orcad/orcad-catalog-browser-publication.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { fixtureContext, syntheticFingerprint } from './fixture-support.mts'
import { streamRecoveryNative, streamOrigin } from './browser-stream-recovery-fixtures.ts'

// Dedicated source only. Existing migrated DB; no schema/reset/delete or current live runtime.
if (process.env.ORCA_BROWSER_STREAM_RECOVERY_APPROVED !== 'root-source-reviewed' ||
    process.env.PGDATABASE !== 'orca_public_browser_20261014') {
  throw new Error('Root stream recovery allocation and preserved isolated DB required')
}
test('원 dispatcher에서 PG OPEN row를 재사용해 같은 native ID를 복구하고 Tab/receipt와 원행을 보존합니다', { timeout: 15000 }, async t => {
  const pool = createDurablePool({ max: 3, statement_timeout: 10000 })
  t.after(() => pool.end())
  const query = (sql: string, values: readonly unknown[] = []) => withDurableTransaction(pool, tx => tx.query(sql, values))
  const identity = async () => (await query(`SELECT current_database() AS database,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
    (SELECT oid FROM pg_database WHERE datname=current_database()) AS database_oid,
    (SELECT dataset_name FROM durable_runtime.dataset_metadata) AS dataset`)).rows[0]
  const beforeIdentity = await identity()
  assert.equal(beforeIdentity.database, 'orca_public_browser_20261014')
  assert.equal(beforeIdentity.system_identifier, '7696101282789175327')
  assert.equal(beforeIdentity.database_oid, 86613); assert.equal(beforeIdentity.dataset, 'orca-1012-dev-v1')
  const ledger = (await query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 19)
  const tables = ['workspaces', 'catalog_workspace_metadata', 'catalog_project_groups', 'catalog_heads',
    'tabs', 'catalog_tab_metadata', 'rpc_receipts', 'agents', 'sessions', 'runtime_units',
    'operations', 'attempts', 'execution_grants', 'storage_bindings', 'storage_write_grants', 'storage_mounts']
  const snapshot = async () => {
    const result = new Map<string, unknown[]>()
    for (const table of tables) {
      result.set(table, (await query(`SELECT to_jsonb(r) AS row FROM durable_runtime.${table} r ORDER BY to_jsonb(r)::text`)).rows)
    }
    return result
  }
  const original = await snapshot()
  const workspaceId = logicalId('workspace', randomUUID()), folderId = `stream-recovery:${randomUUID()}`
  const publicId = `folder:${folderId}`, groupId = `stream-recovery-group:${randomUUID()}`
  const payload: FolderWorkspace = { id: folderId, projectGroupId: groupId, name: 'Synthetic stream recovery',
    folderPath: `/synthetic/stream-recovery/${workspaceId}`, comment: '', linkedTask: null, createdAt: 1, updatedAt: 1,
    lastActivityAt: 1, sortOrder: 0, isArchived: false, isUnread: false, isPinned: false }
  await query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [groupId, JSON.stringify({ id: groupId })])
  await query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,$3,'PENDING')",
    [workspaceId, publicId, payload.name])
  await query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,project_group_id,reserved_path,payload,create_request)
    VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}')`, [workspaceId, groupId, payload.folderPath, JSON.stringify(payload)])
  await query('INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)', [`workspace:${workspaceId}`, randomUUID()])
  const openPage = randomUUID(), closedPage = randomUUID()
  for (const [index, page] of [openPage, closedPage].entries()) {
    const tabId = logicalId('tab', randomUUID())
    const tabPayload = { type: 'browser', id: page, title: 'Stored Ops', browserWorkspaceId: page, browserPageId: page,
      browserProfileId: 'default', url: `${streamOrigin}/ops/`, loading: false, canGoBack: false, canGoForward: false, isActive: false }
    const launch = { method: 'browser.tabCreate', paramsSupplied: true,
      params: { worktree: `id:${publicId}`, page, profileId: 'default', url: `${streamOrigin}/ops/` } }
    await query(`INSERT INTO durable_runtime.tabs(id,workspace_id,kind,ui_order,lifecycle,closed_at)
      VALUES($1,$2,'browser',$3,$4,$5)`,
    [tabId, workspaceId, index, index === 0 ? 'OPEN' : 'CLOSED', index === 0 ? null : new Date(0)])
    await query(`INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request)
      VALUES($1,$2,$3,$4)`, [tabId, page, JSON.stringify(tabPayload), JSON.stringify(launch)])
  }
  const seeded = await snapshot(), f = streamRecoveryNative(publicId)
  t.after(f.stop)
  const config = f.config(pool)
  f.host.withBrowserTabPublication = createOrcadCatalogBrowserPublication(captureDurableCatalogReadConfig(config))
  const adapter = new DurableCatalogReadAdapter(config)
  t.after(() => adapter.dispose())
  let streams = 0
  Object.defineProperty(f.runtime, 'browserScreencast', { configurable: true, value: async function (
    this: typeof f.runtime, params: Parameters<typeof f.runtime.browserScreencast>[0],
    options: Parameters<typeof f.runtime.browserScreencast>[1]
  ) {
    assert.equal(this, f.runtime); streams++
    assert.equal(params.page, openPage); assert.equal(params.worktree, `id:${publicId}`)
    assert.ok(f.authority.findPageSession({ browserPageId: openPage, worktreePublicId: publicId }))
    options.emit({ type: 'end', subscriptionId: `synthetic-stream-recovery:${openPage}` })
  } })
  const dispatcher = new RpcDispatcher({ runtime: f.runtime, methods: adapter.bind(BROWSER_SCREENCAST_METHODS) })
  const replies: { ok: boolean; error?: { code: string }; result?: unknown }[] = []
  const subscribe = (page: string, fingerprint = syntheticFingerprint) => dispatcher.dispatchStreaming(
    { id: randomUUID(), method: 'browser.screencast', authToken: '', params: { worktree: `id:${publicId}`, page, mobile: true } },
    response => { replies.push(JSON.parse(response)) }, fixtureContext(f.runtime, { authenticatedCallerFingerprint: fingerprint }))
  f.session.beforeNavigate = () => {
    assert.equal(f.issues(), 1)
    assert.ok(f.session.cdp.calls.some(call => call.method === 'Fetch.enable'))
  }
  await subscribe(openPage)
  assert.equal(streams, 1); assert.equal(replies.filter(reply => !reply.ok).length, 0)
  const oldOwner = f.authority.findPageSession({ browserPageId: openPage, worktreePublicId: publicId })
  const nativeBefore = structuredClone(f.session.nativeCalls)
  await subscribe(openPage, 'b'.repeat(64))
  assert.equal(streams, 2); assert.equal(f.issues(), 1); assert.deepEqual(f.session.nativeCalls, nativeBefore)
  assert.equal(f.authority.findPageSession({ browserPageId: openPage, worktreePublicId: publicId }), oldOwner)
  for (const page of [randomUUID(), closedPage]) { await subscribe(page) }
  assert.equal(streams, 2); assert.equal(replies.filter(reply => !reply.ok).length, 2)
  assert.deepEqual(f.session.nativeCalls, nativeBefore); assert.equal(f.selection.length, 0)
  assert.deepEqual(await snapshot(), seeded, 'Recovery, stream and negative paths must not change any PG row')
  for (const [table, rows] of original) {
    for (const row of rows) { assert.ok(seeded.get(table)!.some(current => isDeepStrictEqual(current, row)), `Original ${table} row changed`) }
  }
  assert.deepEqual((await query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  assert.deepEqual(await identity(), beforeIdentity)
  assert.equal(seeded.get('rpc_receipts')!.length, original.get('rpc_receipts')!.length)
  assert.equal(seeded.get('tabs')!.length, original.get('tabs')!.length + 2)
  adapter.dispose()
  const streamsBefore = streams, connectsNativeBefore = f.session.nativeCalls.length
  await subscribe(openPage)
  assert.equal(streams, streamsBefore); assert.equal(f.session.nativeCalls.length, connectsNativeBefore)
  assert.equal(replies.at(-1)?.error?.code, 'CATALOG_ADAPTER_DISPOSED')
  assert.ok(f.unexpected.every(name => name === 'recordFeatureInteraction'))
  // New UUID fixture rows stay in this isolated DB. No migration/reset/delete or PG create handler.
})
