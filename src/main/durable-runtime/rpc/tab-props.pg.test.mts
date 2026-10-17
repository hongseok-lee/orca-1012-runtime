import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { terminalFixture, readStored } from '../terminal/durable-verification-fixtures.mts'
import { emptyTerminalDraft } from '../terminal/draft-reducer.ts'
import { saveTerminalDraftInTransaction } from '../terminal/draft-repository.ts'
import { assertManagedCatalogTarget } from '../terminal/catalog-target.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { fixtureContext, fixtureRuntime } from './fixture-support.mts'
import { createCatalogMetadataFacade, mutateCatalogRpc, CATALOG_PUBLIC_METADATA_METHODS } from './metadata.ts'
import { captureCatalogReadContext } from './context.ts'
import { prepareCatalogCall } from '../catalog/request.ts'
import { updateCatalogTabProps } from '../catalog/tab-props.ts'

if (process.env.ORCA_TERMINAL_PUBLIC_DB !== 'orca_public_clipboard_20261014' ||
    process.env.PGDATABASE !== process.env.ORCA_TERMINAL_PUBLIC_DB) {
  throw new Error('Exact isolated tab props database required')
}

// New metadata boundary only. Existing sequential/overlapping Terminal tests are not rerun.
await test('existing setTabProps preserves parent scope, visibility, omitted fields, receipts and Terminal mode pins', async t => {
  const pool = createDurablePool({ max: 4 })
  t.after(async () => { await pool.end() })
  const identity = (await pool.query(`SELECT current_database() AS name,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system,
    (SELECT dataset_name FROM durable_runtime.dataset_metadata) AS dataset,pg_backend_pid() AS pid`)).rows[0]
  assert.equal(identity.name, 'orca_public_clipboard_20261014'); assert.equal(identity.oid, '80991')
  assert.equal(identity.system, '7696101282789175327'); assert.equal(identity.dataset, 'orca-1012-dev-v1')
  const ledger = (await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 19)
  t.diagnostic(JSON.stringify({phase: 'same-pool-identity', ...identity, ledger: ledger.length}))
  const f = await terminalFixture(pool), session = f.sessionId
  const target = (await pool.query('SELECT * FROM durable_runtime.tabs WHERE terminal_handle=$1', [f.terminalHandle])).rows[0]
  const group = `tab-props:${randomUUID()}`, parent = `parent:${randomUUID()}`
  const firstId = `${parent}::first`, siblingId = `${parent}::second`, otherId = `other:${randomUUID()}`
  const terminalPayload = (id: string, host: string, leaf: string, handle: string, active = false) => ({
    id, type: 'terminal', title: 'unchanged title', parentTabId: host, leafId: leaf,
    terminal: handle, status: 'ready', isActive: active, color: '#112233', isPinned: false, viewMode: 'chat'
  })
  const insertTab = async (id: string, host: string, leaf: string, order: number) => {
    const tabId = randomUUID(), handle = `tab-props:${randomUUID()}`
    await pool.query("INSERT INTO durable_runtime.tabs(id,workspace_id,session_id,kind,terminal_handle,ui_order,lifecycle) VALUES($1,$2,$3,'terminal',$4,$5,'OPEN')",
      [tabId, target.workspace_id, session, handle, order])
    await pool.query("INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request) VALUES($1,$2,$3,'{}')",
      [tabId, id, terminalPayload(id, host, leaf, handle)])
    return tabId
  }
  await withDurableTransaction(pool, async tx => {
    await tx.query("UPDATE durable_runtime.agents SET provider='codex' WHERE id=(SELECT agent_id FROM durable_runtime.sessions WHERE id=$1)", [session])
    await tx.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [group,
      {id: group, name: 'tab props', createdFrom: 'manual', parentPath: null, parentGroupId: null, color: null,
        tabOrder: 0, createdAt: 1, updatedAt: 1, isCollapsed: false}])
    await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata
      (workspace_id,kind,project_group_id,reserved_path,payload,create_request,runtime_unit_id)
      VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}',$5)`, [target.workspace_id, group, `/synthetic/props/${group}`,
      {id: target.workspace_id, projectGroupId: group, name: 'props Workspace', folderPath: `/synthetic/props/${group}`,
        comment: '', createdAt: 1, updatedAt: 1, lastActivityAt: 1, sortOrder: 0,
        isArchived: false, isUnread: false, isPinned: false, executionHostId: 'local'}, f.unitId])
    // Existing production head initialization convention; no DDL/reset or runtime effect.
    for (const scope of ['catalog', `workspace:${target.workspace_id}`]) {
      await tx.query('INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2) ON CONFLICT(scope) DO NOTHING', [scope, randomUUID()])
    }
    await tx.query("INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request) VALUES($1,$2,$3,'{}')",
      [target.id, firstId, terminalPayload(firstId, parent, 'first', f.terminalHandle, true)])
    const draft = {...emptyTerminalDraft(f.binding, '0'), chunks: [{ingressId: 'synthetic-old-draft', text: 'keep original draft', attachments: []}]}
    await lockAggregates(tx, {sessionIds: [session]})
    await saveTerminalDraftInTransaction(tx, {draft, attachments: [], lastIngress: {synthetic: true}}, '0', false)
  })
  const sibling = await insertTab(siblingId, parent, 'second', 1)
  await insertTab(otherId, otherId, 'other-leaf', 2)
  const browser = randomUUID(), browserId = `browser:${randomUUID()}`
  await pool.query("INSERT INTO durable_runtime.tabs(id,workspace_id,kind,ui_order,lifecycle) VALUES($1,$2,'browser',3,'OPEN')", [browser, target.workspace_id])
  await pool.query("INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request) VALUES($1,$2,$3,'{}')", [browser, browserId,
    {id: browserId, type: 'browser', title: 'private client page', isActive: false, browserWorkspaceId: `bw:${randomUUID()}`,
      browserPageId: null, url: 'about:blank', loading: false, canGoBack: false, canGoForward: false, placement: {kind: 'client'}}])
  const runtime = fixtureRuntime().runtime, context = fixtureContext(runtime)
  const config = captureDurableCatalogReadConfig({pool, datasetName: identity.dataset, hostId: 'local', readHostIdentity: () => 'local',
    repositoryIds: [], projectGroupIds: [], workspacePublicIds: [target.workspace_id]})
  const facade = createCatalogMetadataFacade(config)
  assert.ok(CATALOG_PUBLIC_METADATA_METHODS.includes('session.tabs.setTabProps'))
  const invoke = (params: unknown) => mutateCatalogRpc(config, facade, 'session.tabs.setTabProps', params, context)
  const read = async () => (await pool.query(`SELECT m.* FROM durable_runtime.catalog_tab_metadata m
    JOIN durable_runtime.tabs t ON t.id=m.tab_id WHERE t.workspace_id=$1 ORDER BY m.public_tab_id`, [target.workspace_id])).rows
  const effects = async () => (await pool.query(`SELECT
    (SELECT to_jsonb(u) FROM durable_runtime.runtime_units u WHERE id=$1) AS unit,
    (SELECT to_jsonb(s) FROM durable_runtime.sessions s WHERE id=$2) AS session,
    (SELECT count(*)::int FROM durable_runtime.input_components WHERE session_id=$2) AS inputs,
    (SELECT count(*)::int FROM durable_runtime.outbox_events WHERE aggregate_id=$1 AND aggregate_kind<>'catalog') AS wake`, [f.unitId, session])).rows[0]
  const oldDraft = await readStored(pool, f), oldEffects = await effects()
  const before = await read(), untouched = before.find(row => row.public_tab_id === otherId)
  const params: {worktree: string; tabId: string; color: string | null; isPinned: boolean} = {
    worktree: `id:${target.workspace_id}`, tabId: firstId, color: null, isPinned: true}
  const pending = invoke(params); params.color = '#mutated-after-capture'
  assert.deepEqual(await pending, {updated: true})
  let rows = await read()
  for (const id of [firstId, siblingId]) {
    const row = rows.find(row => row.public_tab_id === id)
    assert.equal(row.payload.color, null); assert.equal(row.payload.isPinned, true); assert.equal(row.payload.viewMode, 'chat')
    assert.equal(row.payload.title, 'unchanged title'); assert.equal(row.binding_revision, '0')
  }
  assert.deepEqual(rows.find(row => row.public_tab_id === otherId), untouched)
  await assert.rejects(invoke({worktree: `id:${target.workspace_id}`, tabId: browserId, color: '#ffffff'}), /tab_not_found/)
  await assert.rejects(invoke({worktree: `id:${randomUUID()}`, tabId: firstId, viewMode: 'chat'}), /selector_not_found/)
  const foreign = (await pool.query(`SELECT w.public_id,m.public_tab_id,to_jsonb(m) AS metadata
    FROM durable_runtime.catalog_tab_metadata m JOIN durable_runtime.tabs t ON t.id=m.tab_id
    JOIN durable_runtime.workspaces w ON w.id=t.workspace_id WHERE w.id<>$1 ORDER BY w.id,m.tab_id LIMIT 1`, [target.workspace_id])).rows[0]
  assert.ok(foreign, 'Reuse one preserved foreign Workspace for the permission denial only')
  await assert.rejects(invoke({worktree: `id:${foreign.public_id}`, tabId: foreign.public_tab_id, color: '#blocked'}), /selector_not_found/)
  assert.deepEqual((await pool.query('SELECT to_jsonb(m) AS metadata FROM durable_runtime.catalog_tab_metadata m WHERE public_tab_id=$1',
    [foreign.public_tab_id])).rows[0].metadata, foreign.metadata)
  const original = rows.find(row => row.public_tab_id === firstId)
  const pin = {tabId: target.id, tabRevision: target.revision, bindingRevision: original.binding_revision,
    provider: 'codex', payload: original.payload}
  assert.deepEqual(await invoke({worktree: `id:${target.workspace_id}`, tabId: parent, viewMode: 'terminal'}), {updated: true})
  rows = await read()
  assert.equal(rows.find(row => row.public_tab_id === siblingId).payload.viewMode, 'terminal')
  assert.equal(rows.find(row => row.public_tab_id === otherId).payload.viewMode, 'chat')
  await assert.rejects(withDurableTransaction(pool, async tx => {
    await lockAggregates(tx, {sessionIds: [session]}); await assertManagedCatalogTarget(tx, pin, f.binding)
  }), /TERMINAL_CATALOG_TARGET_CHANGED/)
  assert.deepEqual(await invoke({worktree: `id:${target.workspace_id}`, tabId: siblingId, color: '#abcdef'}), {updated: true})
  rows = await read(); assert.equal(rows.find(row => row.public_tab_id === firstId).payload.viewMode, 'terminal')
  assert.equal(rows.find(row => row.public_tab_id === firstId).payload.isPinned, true)
  // The same internal prepared receipt can replay; this does not add a legacy wire dedup field.
  const callContext = captureCatalogReadContext(config, context), receiptKey = `props-receipt:${randomUUID()}`
  const makeCall = (color: string) => ({...prepareCatalogCall('session.tabs.setTabProps',
    {worktree: `id:${target.workspace_id}`, tabId: parent, color}, callContext), operationKey: receiptKey})
  assert.equal((await updateCatalogTabProps(pool, makeCall('#eeeeee'))).status, 'COMMITTED')
  const afterFirst = await read()
  assert.equal((await updateCatalogTabProps(pool, makeCall('#eeeeee'))).status, 'REPLAYED')
  assert.deepEqual(await read(), afterFirst)
  await assert.rejects(updateCatalogTabProps(pool, makeCall('#different')), /RECEIPT_PAYLOAD_CONFLICT/)
  await pool.query("UPDATE durable_runtime.tabs SET lifecycle='CLOSED',closed_at=clock_timestamp(),revision=revision+1 WHERE id=$1", [sibling])
  const closed = (await read()).find(row => row.tab_id === sibling)
  await assert.rejects(invoke({worktree: `id:${target.workspace_id}`, tabId: siblingId, viewMode: 'chat'}), /CATALOG_TAB_CLOSED/)
  assert.deepEqual(await invoke({worktree: `id:${target.workspace_id}`, tabId: parent, viewMode: 'chat'}), {updated: true})
  assert.deepEqual((await read()).find(row => row.tab_id === sibling), closed)
  assert.deepEqual(await readStored(pool, f), oldDraft)
  assert.deepEqual(await effects(), oldEffects)
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  t.diagnostic(JSON.stringify({phase: 'complete', parentLeaves: 2, providerCalls: 0, wakeChanges: 0,
    originalFloorDraftPreserved: true, originalModePinRejected: true, legacyRetryLimitPreserved: true}))
})
