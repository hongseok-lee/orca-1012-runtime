import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types.ts'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createOpsBrowserSessionAuthority } from '../ops/browser-session-auth.ts'
import { createCatalogBrowserCreateRpc } from './browser-create.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { fixtureConfig, fixtureContext, fixtureRuntime, syntheticFingerprint } from './fixture-support.mts'

// Source only now. A later Root allocation must select the existing isolated database explicitly.
if (process.env.ORCA_OPS_BROWSER_COMPOSITION_PG_APPROVED !== 'root-source-reviewed' ||
    !(process.env.PGDATABASE ?? '').startsWith('orca_public_browser_')) {
  throw new Error('Root composition PG allocation and existing migrated isolated DB required')
}
test('page issuance follows committed PG reservation and post-native failure revokes only newly owned auth', async t => {
  const pool = createDurablePool({ max: 3, statement_timeout: 10000 })
  const authority = createOpsBrowserSessionAuthority({ datasetName: 'orca-1012-dev-v1', namespaceId: 'synthetic-composition', workspaceIds: [] })
  t.after(async () => { authority.close(); await pool.end() })
  const query = (sql: string, values: readonly unknown[] = []) => withDurableTransaction(pool, tx => tx.query(sql, values))
  const workspaceId = logicalId('workspace', randomUUID()), folderId = `composition-folder:${randomUUID()}`
  const publicId = `folder:${folderId}`, groupId = `composition-group:${randomUUID()}`
  const payload: FolderWorkspace = { id: folderId, projectGroupId: groupId, name: 'Synthetic Ops composition',
    folderPath: `/synthetic/ops-composition/${workspaceId}`, comment: '', linkedTask: null, createdAt: 1, updatedAt: 1,
    lastActivityAt: 1, sortOrder: 0, isArchived: false, isUnread: false, isPinned: false }
  await query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [groupId, JSON.stringify({ id: groupId })])
  await query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,$3,'PENDING')", [workspaceId, publicId, payload.name])
  await query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,project_group_id,reserved_path,payload,create_request)
    VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}')`, [workspaceId, groupId, payload.folderPath, JSON.stringify(payload)])
  await query('INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)', [`workspace:${workspaceId}`, randomUUID()])
  const owner = fixtureRuntime()
  let issues = 0, nativeCalls = 0, fingerprintReads = 0, mismatch = false
  const config = captureDurableCatalogReadConfig({ ...fixtureConfig(pool), workspacePublicIds: [publicId], browserOpsAuth: {
    origin: 'https://ops.example.test:8443', issuePageSession(input) { issues++; return authority.issuePageSession(input) }
  } })
  const row = async (page: string) => (await query(`SELECT t.lifecycle,t.workspace_id FROM durable_runtime.tabs t
    JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id WHERE m.public_tab_id=$1`, [page])).rows
  Object.defineProperty(owner.runtime, 'browserTabCreate', { value: async function (params: { page: string }, caller: Parameters<typeof owner.runtime.browserTabCreate>[1]) {
    assert.equal(this, owner.runtime); nativeCalls++
    assert.equal(issues, nativeCalls - 1, 'no session is issued before this native target boundary')
    const committed = await row(params.page)
    assert.equal(committed[0]?.lifecycle, 'OPEN'); assert.equal(committed[0]?.workspace_id, workspaceId)
    assert.ok((await query('SELECT 1 FROM durable_runtime.rpc_receipts WHERE response=$1::jsonb', [JSON.stringify({ browserPageId: params.page })])).rows.length > 0)
    const capability = caller?.opsAuth; assert.ok(capability)
    assert.equal(capability.browserPageId, params.page); assert.equal(capability.worktreePublicId, publicId)
    assert.equal(capability.authenticatedCallerFingerprint, syntheticFingerprint)
    const session = capability.openPageSession()
    capability.ownCleanup(async () => { session.dispose() })
    return { browserPageId: mismatch ? 'synthetic-wrong-return' : params.page }
  } })
  const handler = createCatalogBrowserCreateRpc(config)
  const context = () => Object.defineProperty(fixtureContext(owner.runtime), 'authenticatedCallerFingerprint', {
    get() { fingerprintReads++; return syntheticFingerprint }
  })
  const firstPage = randomUUID()
  assert.equal(issues, 0)
  assert.deepEqual(await handler({ worktree: `id:${publicId}`, page: firstPage, url: 'about:blank', activate: false }, context()), { browserPageId: firstPage })
  assert.equal(fingerprintReads, 1); assert.equal(issues, 1)
  assert.ok(authority.findPageSession({ browserPageId: firstPage, worktreePublicId: publicId }))
  mismatch = true
  const failedPage = randomUUID()
  await assert.rejects(handler({ worktree: `id:${publicId}`, page: failedPage, url: 'about:blank', activate: false }, context()), /CATALOG_BROWSER_NATIVE_PAGE_MISMATCH/)
  assert.equal(issues, 2); assert.equal(fingerprintReads, 2)
  assert.equal(authority.findPageSession({ browserPageId: failedPage, worktreePublicId: publicId }), null)
  assert.ok(authority.findPageSession({ browserPageId: firstPage, worktreePublicId: publicId }))
  assert.equal((await row(failedPage))[0]?.lifecycle, 'OPEN', 'committed PG reservation is not deleted with auth cleanup')
  assert.ok((await query('SELECT 1 FROM durable_runtime.rpc_receipts WHERE response=$1::jsonb', [JSON.stringify({ browserPageId: failedPage })])).rows.length > 0)
  // New UUID fixture rows are retained; no reset, ledger change, old-row deletion or blind native close.
})
