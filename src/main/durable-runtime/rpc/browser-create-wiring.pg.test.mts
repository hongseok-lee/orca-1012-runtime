import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import type { Pool } from 'pg'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { DurableCatalogReadAdapter } from './public.ts'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher.ts'
import { BROWSER_CORE_METHODS } from '../../runtime/rpc/methods/browser-core.ts'
import { BrowserTabCreateParams } from '../../runtime/rpc/methods/browser-tab-create-schema.ts'
import { deferred, fixtureConfig, fixtureContext, fixtureRuntime, syntheticFingerprint } from './fixture-support.mts'

// Source only. Reuse the existing exact database and ledger; no migration/reset/delete.
if (process.env.ORCA_PUBLIC_BROWSER_WIRING_APPROVED !== 'root-wiring-reviewed' ||
    process.env.PGDATABASE !== 'orca_public_browser_20261014') {
  throw new Error('Root Browser wiring review and preserved isolated database required')
}

await test('원 Browser declaration에서 dispatcher·adapter·PG 예약과 합성 native commit 순서를 연결합니다', async t => {
  const pool = createDurablePool({ database: process.env.PGDATABASE, max: 3, statement_timeout: 10000 })
  t.after(() => pool.end())
  const query = (sql: string, values: readonly unknown[] = []) => withDurableTransaction(pool, tx => tx.query(sql, values))
  const identity = (await query(`SELECT current_database() AS database,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
    (SELECT oid FROM pg_database WHERE datname=current_database()) AS database_oid,
    (SELECT dataset_name FROM durable_runtime.dataset_metadata) AS dataset,
    pg_backend_pid() AS backend_pid,clock_timestamp() AS utc`)).rows[0]
  assert.equal(identity.database, 'orca_public_browser_20261014')
  assert.equal(identity.system_identifier, '7696101282789175327')
  assert.equal(identity.database_oid, 86613)
  assert.equal(identity.dataset, 'orca-1012-dev-v1')
  t.diagnostic(JSON.stringify({ ...identity, nodePid: process.pid, authentication: 'synthetic-context' }))
  const ledger = (await query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 19)
  const preservedTables = ['workspaces', 'catalog_workspace_metadata', 'catalog_project_groups',
    'tabs', 'catalog_tab_metadata', 'rpc_receipts']
  const preserved = new Map<string, unknown[]>()
  for (const table of preservedTables) {
    preserved.set(table, (await query(`SELECT to_jsonb(r) AS row FROM durable_runtime.${table} r ORDER BY to_jsonb(r)::text`)).rows)
  }
  const oldHeads = (await query("SELECT * FROM durable_runtime.catalog_heads WHERE scope<>'catalog' ORDER BY scope")).rows
  const workspaceId = logicalId('workspace', randomUUID()), groupId = `synthetic-browser-wiring-group:${randomUUID()}`
  const folderId = `synthetic-browser-wiring:${workspaceId}`, publicId = `folder:${folderId}`
  const payload: FolderWorkspace = { id: folderId, projectGroupId: groupId, name: 'Synthetic Browser wiring',
    folderPath: `/synthetic/browser-wiring/${workspaceId}`, comment: '', linkedTask: null,
    createdAt: 11, updatedAt: 11, lastActivityAt: 11, sortOrder: 0, isArchived: false, isUnread: false, isPinned: false }
  await query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [groupId, JSON.stringify({ id: groupId })])
  await query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,$3,'PENDING')",
    [workspaceId, publicId, payload.name])
  await query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,project_group_id,reserved_path,payload,create_request)
    VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}')`, [workspaceId, groupId, payload.folderPath, JSON.stringify(payload)])
  await query('INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)', [`workspace:${workspaceId}`, randomUUID()])

  const tab = async (page: string) => (await query(`SELECT t.*,m.public_tab_id,m.payload,m.launch_request
    FROM durable_runtime.tabs t JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id WHERE m.public_tab_id=$1`, [page])).rows[0]
  const receipts = async (page: string) => (await query(`SELECT * FROM durable_runtime.rpc_receipts
    WHERE response=$1::jsonb ORDER BY operation_key`, [JSON.stringify({ browserPageId: page })])).rows
  const owner = fixtureRuntime()
  type CreateParams = Parameters<typeof owner.runtime.browserTabCreate>[0]
  type Caller = Parameters<typeof owner.runtime.browserTabCreate>[1]
  const nativeCalls: { params: CreateParams; caller: Caller }[] = []
  let nativeFailure = false, connects = 0, holdFirst = true
  const entered = deferred<void>(), release = deferred<void>()
  t.after(() => release.resolve())
  const borrowed: Pool = Object.create(pool)
  Object.defineProperty(borrowed, 'connect', { value: async function () {
    assert.equal(this, borrowed)
    connects++
    if (holdFirst) { holdFirst = false; entered.resolve(); await release.promise }
    return pool.connect()
  } })
  Object.defineProperty(borrowed, 'query', { value: pool.query.bind(pool) })
  const create = async function (this: typeof owner.runtime, params: CreateParams, caller: Caller) {
    assert.equal(this, owner.runtime)
    assert.ok(params.page)
    // This independent observer connection cannot see uncommitted reservation rows.
    const stored = await tab(params.page), committed = await receipts(params.page)
    assert.equal(stored.workspace_id, workspaceId)
    assert.equal(stored.lifecycle, 'OPEN'); assert.equal(stored.kind, 'browser')
    assert.equal(stored.public_tab_id, params.page)
    assert.equal(committed.length, 1)
    assert.equal(committed[0].principal_id, JSON.stringify(['catalog-host-fingerprint-v1', 'orca-1012-dev-v1', 'local', syntheticFingerprint]))
    nativeCalls.push({ params: { ...params }, caller: caller === undefined ? undefined : { ...caller } })
    if (nativeFailure) { throw Object.assign(new Error('Synthetic wiring native failure'), { code: 'SYNTHETIC_BROWSER_WIRING_NATIVE_FAILURE' }) }
    return { browserPageId: params.page }
  }
  Object.defineProperty(owner.runtime, 'browserTabCreate', { configurable: true, value: create })
  const adapter = new DurableCatalogReadAdapter({ ...fixtureConfig(borrowed), workspacePublicIds: [publicId] })
  t.after(() => adapter.dispose())
  const methods = adapter.bind(BROWSER_CORE_METHODS)
  assert.equal(methods.find(method => method.name === 'browser.tabCreate')!.params, BrowserTabCreateParams)
  const dispatcher = new RpcDispatcher({ runtime: owner.runtime, methods })
  const firstPage = randomUUID()
  const params = { worktree: `id:${publicId}`, page: firstPage, url: 'localhost:4000', profileId: 'default',
    activate: true, navigation: 'caller' as const, targetGroupId: 'synthetic-wiring-selected-group', waitForRegistration: false }
  const parsedOriginal = BrowserTabCreateParams.parse(params)
  const capabilities = [...fixtureContext(owner.runtime).clientCapabilities!]
  const options = { authenticatedCallerFingerprint: syntheticFingerprint, pairedDeviceId: 'synthetic-device',
    clientKind: 'mobile' as 'mobile' | 'runtime', clientCapabilities: capabilities, clientId: 'synthetic-browser-wiring-never-store' }
  const pending = dispatcher.dispatch({ id: randomUUID(), authToken: '', method: 'browser.tabCreate', params }, options)
  await entered.promise
  params.url = 'https://changed-after-await.example/'
  params.page = 'changed-after-await'; params.worktree = 'outside'; params.activate = false
  options.authenticatedCallerFingerprint = 'changed-after-await'
  options.pairedDeviceId = 'changed-after-await'; options.clientKind = 'runtime'; capabilities.length = 0
  Object.defineProperty(owner.runtime, 'browserTabCreate', { configurable: true, value() { throw new Error('Replacement wiring create consulted') } })
  release.resolve()
  const response = await pending
  assert.equal(response.ok, true)
  if (!response.ok) { assert.fail(response.error.message) }
  assert.deepEqual(response.result, { browserPageId: firstPage })
  assert.deepEqual(nativeCalls[0], { params: { ...parsedOriginal, url: 'http://localhost:4000/' },
    caller: { pairedDeviceId: 'synthetic-device', clientKind: 'mobile' } })
  const stored = await tab(firstPage)
  assert.deepEqual(stored.launch_request, { method: 'browser.tabCreate', paramsSupplied: true, params: parsedOriginal })
  assert.equal(JSON.stringify(stored).includes('synthetic-browser-wiring-never-store'), false)
  assert.equal((await query('SELECT provisioning_state FROM durable_runtime.workspaces WHERE id=$1', [workspaceId])).rows[0].provisioning_state, 'PENDING')

  Object.defineProperty(owner.runtime, 'browserTabCreate', { configurable: true, value: create })
  nativeFailure = true
  const failedPage = randomUUID(), failedParams = { worktree: publicId, page: failedPage, url: 'about:blank' }
  const transport = { authenticatedCallerFingerprint: syntheticFingerprint, pairedDeviceId: 'synthetic-device',
    clientKind: 'mobile' as const, clientCapabilities: fixtureContext(owner.runtime).clientCapabilities }
  const failed = await dispatcher.dispatch({ id: randomUUID(), authToken: '', method: 'browser.tabCreate', params: failedParams }, transport)
  assert.equal(failed.ok, false)
  if (failed.ok) { assert.fail('Native failure became wire success') }
  assert.equal(failed.error.code, 'SYNTHETIC_BROWSER_WIRING_NATIVE_FAILURE')
  const failedStored = await tab(failedPage), failedReceipts = await receipts(failedPage)
  assert.equal(failedStored.lifecycle, 'OPEN'); assert.equal(failedReceipts.length, 1)
  assert.deepEqual(failedStored.launch_request.params, BrowserTabCreateParams.parse(failedParams))
  assert.equal(nativeCalls.length, 2)

  adapter.dispose()
  const disposedPage = randomUUID(), connectsBeforeDisposed = connects
  const disposed = await dispatcher.dispatch({ id: randomUUID(), authToken: '', method: 'browser.tabCreate',
    params: { worktree: publicId, page: disposedPage } }, transport)
  assert.equal(disposed.ok, false)
  if (disposed.ok) { assert.fail('Disposed adapter became wire success') }
  assert.equal(disposed.error.code, 'CATALOG_ADAPTER_DISPOSED')
  assert.equal(connects, connectsBeforeDisposed); assert.equal(nativeCalls.length, 2)
  assert.equal(await tab(disposedPage), undefined); assert.deepEqual(await receipts(disposedPage), [])
  assert.deepEqual(await tab(failedPage), failedStored); assert.deepEqual(await receipts(failedPage), failedReceipts)
  assert.deepEqual((await query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  for (const table of preservedTables) {
    const after = (await query(`SELECT to_jsonb(r) AS row FROM durable_runtime.${table} r ORDER BY to_jsonb(r)::text`)).rows
    for (const row of preserved.get(table)!) { assert.ok(after.some(current => isDeepStrictEqual(current, row)), `Original ${table} row changed`) }
  }
  const currentHeads = (await query("SELECT * FROM durable_runtime.catalog_heads WHERE scope<>'catalog' ORDER BY scope")).rows
  for (const head of oldHeads) { assert.ok(currentHeads.some(current => isDeepStrictEqual(current, head)), 'Original Workspace head changed') }
  // Browser feature-interaction telemetry is an existing dispatcher effect, not a native/PG fallback.
  assert.ok(owner.unexpected.every(name => name === 'recordFeatureInteraction'))
  assert.equal(Object.isFrozen(pool), false)
})
