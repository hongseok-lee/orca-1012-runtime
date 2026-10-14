import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types.ts'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import type { MutationOutcome } from '../db/atomic.ts'
import type { CatalogAuthority } from './authority.ts'
import { reserveCatalogBrowserTab } from './browser.ts'
import { prepareCatalogCall, catalogReceiptIdentity } from './request.ts'
import { catalogWorkspaceScope } from './mutation.ts'
import { readCatalogSnapshot } from './read.ts'
import { projectCatalogTabs, readAllCatalogTabs } from './projection.ts'
import { CatalogCompatibilityFacade } from './facade.ts'
import { createCatalogEntries } from './entries.ts'
import { recordUnitIntent } from '../lifecycle/intent.ts'
import { reserveSleep } from '../lifecycle/sleep.ts'
import { recordInputCancel } from '../input/cancel.ts'

// Written only. Root must separately allocate a migrated isolated DB and this first PG case.
if (process.env.ORCA_P116_BROWSER_PG_APPROVED !== 'root-browser-reservation' ||
    !(process.env.PGDATABASE ?? '').startsWith('orca_p116_browser_')) {
  throw new Error('Root allocation and isolated Browser Catalog DB required')
}

await test('PG Browser reservation, receipt-first replay and existing projection without runtime effects', async () => {
  const pool = createDurablePool({ max: 3, statement_timeout: 10000 })
  const query = (sql: string, values: readonly unknown[] = []) => withDurableTransaction(pool, tx => tx.query(sql, values))
  const ids = [logicalId('workspace', randomUUID()), logicalId('workspace', randomUUID())]
  const publicIds = ids.map(id => `synthetic-browser-workspace:${id}`)
  // Synthetic authority only; no production principal/credential or authority issuer.
  const authority = { principalId: `synthetic-browser-principal:${randomUUID()}`, repositoryIds: [],
    projectGroupIds: [], workspacePublicIds: publicIds } as unknown as CatalogAuthority
  const context = { authority, capabilities: [] }
  const groupId = `synthetic-browser-group:${randomUUID()}`
  const unitId = logicalId('runtime-unit', randomUUID()), agentId = logicalId('agent', randomUUID())
  const sessionId = logicalId('session', randomUUID()), bindingId = logicalId('storage-binding', randomUUID())
  const backendId = `synthetic-browser-backend:${randomUUID()}`
  const protectedTables = ['agents', 'sessions', 'runtime_units', 'runtime_members', 'operations', 'attempts',
    'execution_grants', 'storage_bindings', 'storage_write_grants', 'storage_mounts', 'resource_profiles']
  const protectedState = async () => {
    const result: Record<string, unknown> = {}
    for (const table of protectedTables) {
      result[table] = (await query(`SELECT to_jsonb(r) AS row FROM durable_runtime.${table} r ORDER BY to_jsonb(r)::text`)).rows
    }
    result.workspaces = (await query('SELECT to_jsonb(w) AS row FROM durable_runtime.workspaces w ORDER BY id')).rows
    result.metadata = (await query('SELECT to_jsonb(m) AS row FROM durable_runtime.catalog_workspace_metadata m ORDER BY workspace_id')).rows
    return result
  }
  const publicationState = async () => ({
    heads: (await query('SELECT * FROM durable_runtime.catalog_heads ORDER BY scope')).rows,
    counts: (await query(`SELECT (SELECT count(*)::text FROM durable_runtime.rpc_receipts) AS receipts,
      (SELECT count(*)::text FROM durable_runtime.runtime_audit_events) AS audit,
      (SELECT count(*)::text FROM durable_runtime.outbox_events) AS outbox`)).rows[0]
  })
  const response = (outcome: MutationOutcome) => {
    assert.notEqual(outcome.status, 'UNCERTAIN')
    if (outcome.status === 'UNCERTAIN') {throw new Error('Uncertain commit retained; no retry')}
    return outcome.receipt.response
  }
  try {
    assert.equal((await query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows[0].dataset_name, 'orca-1012-dev-v1')
    await query("INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES('catalog',$1) ON CONFLICT(scope) DO NOTHING", [randomUUID()])
    await query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [groupId, JSON.stringify({ id: groupId })])
    for (const [index, id] of ids.entries()) {
      const payload: FolderWorkspace = { id: publicIds[index], projectGroupId: groupId,
        name: `synthetic-browser-${index}`, folderPath: `/synthetic/browser/${id}`, comment: '', linkedTask: null,
        createdAt: 7, updatedAt: 7, lastActivityAt: 7, sortOrder: 0, isArchived: false, isUnread: false, isPinned: false }
      await query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,$3,'READY')", [id, publicIds[index], payload.name])
      await query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,project_group_id,reserved_path,payload,create_request)
        VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}')`, [id, groupId, payload.folderPath, JSON.stringify(payload)])
      await query('INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)', [`workspace:${id}`, randomUUID()])
    }
    await query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'shell')", [agentId])
    await query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [sessionId, agentId, ids[0]])
    await query(`INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase,last_work_event_at,idle_due_at)
      VALUES($1,'SUSPENDED','ABSENT','2026-10-14T00:00:00Z','2026-10-14T01:00:00Z')`, [unitId])
    await query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,'synthetic-export')", [backendId])
    await query(`INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state)
      VALUES($1,$2,'synthetic-export','/synthetic/browser','UNVERIFIED')`, [bindingId, backendId])
    await query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [unitId, sessionId, bindingId])
    const protectedBefore = await protectedState(), publicationBefore = await publicationState()
    const launch = { tabId: logicalId('tab', randomUUID()), browserPageId: 'public-browser::opaque-page' }
    const call = prepareCatalogCall('browser.tabCreate', { worktree: `id:${publicIds[0]}`, page: launch.browserPageId,
      url: 'localhost:3000', activate: true, navigation: 'caller' }, context)
    const outcome = await reserveCatalogBrowserTab(pool, call, launch)
    assert.equal(outcome.status, 'COMMITTED'); assert.deepEqual(response(outcome), { browserPageId: launch.browserPageId })
    const stored = (await query(`SELECT t.*,m.public_tab_id,m.payload,m.launch_request FROM durable_runtime.tabs t
      JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id WHERE t.id=$1`, [launch.tabId])).rows[0]
    assert.equal(stored.kind, 'browser'); assert.equal(stored.lifecycle, 'OPEN'); assert.equal(stored.ui_order, '0')
    for (const key of ['session_id', 'terminal_handle', 'leaf_id', 'pane_key']) {assert.equal(stored[key], null)}
    assert.deepEqual(stored.launch_request, JSON.parse(JSON.stringify(call.original)))
    assert.deepEqual(stored.payload, { type: 'browser', id: launch.browserPageId, title: 'http://localhost:3000/',
      browserWorkspaceId: launch.browserPageId, browserPageId: launch.browserPageId, url: 'http://localhost:3000/',
      loading: true, canGoBack: false, canGoForward: false, isActive: false })
    const identity = catalogReceiptIdentity(call, catalogWorkspaceScope({ workspace_id: ids[0] }))
    const receipt = (await query(`SELECT payload_hash,response FROM durable_runtime.rpc_receipts
      WHERE principal_id=$1 AND session_scope=$2 AND method=$3 AND operation_key=$4`, Object.values(identity.key))).rows[0]
    assert.deepEqual(receipt, { payload_hash: call.payloadHash, response: { browserPageId: launch.browserPageId } })
    const publicationAfter = await publicationState()
    for (const key of ['receipts', 'audit', 'outbox']) {
      assert.equal(BigInt(publicationAfter.counts[key]), BigInt(publicationBefore.counts[key]) + 1n)
    }
    for (const scope of ['catalog', `workspace:${ids[0]}`]) {
      assert.equal(BigInt(publicationAfter.heads.find(row => row.scope === scope)!.revision),
        BigInt(publicationBefore.heads.find(row => row.scope === scope)!.revision) + 1n)
    }
    const snapshot = await readCatalogSnapshot(pool, authority)
    const projection = projectCatalogTabs(snapshot, snapshot.workspaces.find(row => row.workspace_id === ids[0])!)
    assert.deepEqual(projection.tabs, [stored.payload]); assert.equal(projection.activeTabId, null)
    assert.deepEqual((await readAllCatalogTabs(pool, prepareCatalogCall('session.tabs.listAll', null, context))).snapshots
      .find(row => row.worktree === publicIds[0])!.tabs, [stored.payload])
    const facade = new CatalogCompatibilityFacade(createCatalogEntries(pool, { recordUnitIntent, reserveSleep, recordInputCancel }, { browser: launch }))
    assert.deepEqual(await facade.invoke('browser.tabCreate', { worktree: publicIds[0], page: launch.browserPageId, url: 'https://changed.example/' }, context), { browserPageId: launch.browserPageId })
    assert.deepEqual((await query(`SELECT t.*,m.public_tab_id,m.payload,m.launch_request FROM durable_runtime.tabs t
      JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id WHERE t.id=$1`, [launch.tabId])).rows[0], stored)
    const second = { tabId: logicalId('tab', randomUUID()), browserPageId: 'second-browser-page' }
    const secondCall = prepareCatalogCall('browser.tabCreate', { worktree: publicIds[0] }, context)
    assert.deepEqual(response(await reserveCatalogBrowserTab(pool, secondCall, second)), { browserPageId: second.browserPageId })
    assert.equal((await query('SELECT ui_order FROM durable_runtime.tabs WHERE id=$1', [second.tabId])).rows[0].ui_order, '1')
    const collision = { tabId: logicalId('tab', randomUUID()), browserPageId: 'existing-other-kind' }
    await query("INSERT INTO durable_runtime.tabs(id,workspace_id,kind,ui_order,lifecycle) VALUES($1,$2,'file',2,'OPEN')", [collision.tabId, ids[0]])
    await query(`INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request)
      VALUES($1,$2,$3,'{}')`, [collision.tabId, collision.browserPageId, JSON.stringify({ type: 'file', id: collision.browserPageId,
        title: 'Synthetic file', isActive: false, filePath: '/synthetic/file', relativePath: 'file', language: 'text', isDirty: false })])
    assert.deepEqual(await protectedState(), protectedBefore)
    const beforeFailure = await publicationState()
    await assert.rejects(reserveCatalogBrowserTab(pool, prepareCatalogCall('browser.tabCreate', {
      worktree: publicIds[0], page: collision.browserPageId }, context), collision), /CATALOG_BROWSER_PAGE_CONFLICT/)
    await assert.rejects(reserveCatalogBrowserTab(pool, prepareCatalogCall('browser.tabCreate', {
      worktree: publicIds[1], page: launch.browserPageId }, context), launch), /CATALOG_BROWSER_PAGE_CONFLICT/)
    await query("UPDATE durable_runtime.tabs SET lifecycle='CLOSED',closed_at=clock_timestamp() WHERE id=$1", [launch.tabId])
    await assert.rejects(reserveCatalogBrowserTab(pool, prepareCatalogCall('browser.tabCreate', {
      worktree: publicIds[0], page: launch.browserPageId }, context), launch), /CATALOG_BROWSER_PAGE_CLOSED/)
    assert.equal((await reserveCatalogBrowserTab(pool, call, launch)).status, 'REPLAYED')
    assert.deepEqual(await publicationState(), beforeFailure)
    await query('UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp() WHERE id=$1', [ids[0]])
    assert.equal((await reserveCatalogBrowserTab(pool, call, launch)).status, 'REPLAYED')
    await assert.rejects(reserveCatalogBrowserTab(pool, prepareCatalogCall('browser.tabCreate', {
      worktree: publicIds[0] }, context), { ...launch, tabId: logicalId('tab', randomUUID()), browserPageId: 'another-page' }), /CATALOG_WORKSPACE_DELETED/)
    // A late publication failure must roll back the Tab, metadata and receipt together.
    await query('DELETE FROM durable_runtime.catalog_heads WHERE scope=$1', [`workspace:${ids[1]}`])
    const failed = { tabId: logicalId('tab', randomUUID()), browserPageId: 'rollback-page' }
    const rollbackBefore = await publicationState()
    await assert.rejects(reserveCatalogBrowserTab(pool, prepareCatalogCall('browser.tabCreate', { worktree: publicIds[1] }, context), failed), /CATALOG_HEAD_MISSING/)
    assert.equal((await query('SELECT count(*)::text AS n FROM durable_runtime.tabs WHERE id=$1', [failed.tabId])).rows[0].n, '0')
    assert.equal((await query('SELECT count(*)::text AS n FROM durable_runtime.catalog_tab_metadata WHERE tab_id=$1', [failed.tabId])).rows[0].n, '0')
    assert.deepEqual(await publicationState(), rollbackBefore)
  } finally { await pool.end() }
})
