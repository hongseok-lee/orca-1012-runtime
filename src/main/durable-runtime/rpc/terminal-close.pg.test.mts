import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {test} from 'node:test'
import {createDurablePool, withDurableTransaction} from '../db/connection.ts'
import {fixture} from '../input/verification-fixtures.mts'
import {acceptInput} from '../input/intake.ts'
import {DurableCatalogReadAdapter} from './public.ts'
import {fixtureConfig, fixtureContext, fixtureRuntime} from './fixture-support.mts'
import {defineMethod, eraseRpcMethods} from '../../runtime/rpc/core.ts'
import {CloseTab} from '../../../shared/rpc-contract/session-tabs-schemas-params.ts'

if (process.env.ORCA_TERMINAL_CLOSE_DB !== 'orca_public_clipboard_20261014' ||
    process.env.PGDATABASE !== process.env.ORCA_TERMINAL_CLOSE_DB) {
  throw new Error('Exact isolated Terminal close adapter database required')
}

// One new public adapter boundary. Synthetic auth context, original CloseTab
// schema/PG close+cancel owners; no provider, physical stop or auth issuer.
await test('metadata registry closes an empty Session and refuses pending cancellation without owner authority', async t => {
  const pool = createDurablePool({max: 3})
  t.after(() => pool.end())
  const identity = (await pool.query(`SELECT current_database() AS name,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system,
    (SELECT dataset_name FROM durable_runtime.dataset_metadata) AS dataset,pg_backend_pid() AS pid`)).rows[0]
  assert.equal(identity.name, 'orca_public_clipboard_20261014')
  assert.equal(identity.oid, '80991'); assert.equal(identity.system, '7696101282789175327')
  const ledger = (await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 19)
  t.diagnostic(JSON.stringify({phase: 'same-pool-identity', ...identity, ledger: ledger.length}))
  const group = `terminal-close-adapter:${randomUUID()}`
  await pool.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [group, {id: group}])
  async function target(pending: boolean) {
    const f = await fixture(pool, 'RUNNING')
    const tab = (await pool.query('SELECT * FROM durable_runtime.tabs WHERE terminal_handle=$1', [f.terminalHandle])).rows[0]
    const publicTabId = `close-tab:${randomUUID()}`
    await withDurableTransaction(pool, async tx => {
      await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata
        (workspace_id,kind,project_group_id,reserved_path,payload,create_request,runtime_unit_id)
        VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}',$5)`, [tab.workspace_id, group, `/synthetic/close/${tab.workspace_id}`,
        {id: tab.workspace_id, projectGroupId: group, name: 'synthetic close adapter', folderPath: `/synthetic/close/${tab.workspace_id}`,
          comment: '', createdAt: 1, updatedAt: 1, lastActivityAt: 1, sortOrder: 0, isArchived: false, isUnread: false,
          isPinned: false, executionHostId: 'local'}, f.unitId])
      await tx.query("INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request) VALUES($1,$2,$3,'{}')",
        [tab.id, publicTabId, {id: publicTabId, type: 'terminal', title: 'synthetic empty Session', isActive: true,
          parentTabId: 'synthetic-parent', leafId: 'synthetic-leaf', status: 'ready', terminal: f.terminalHandle}])
    })
    if (pending) { assert.notEqual((await acceptInput(pool, f.request)).status, 'UNCERTAIN') }
    return {...f, tab, publicTabId}
  }
  const empty = await target(false), pending = await target(true), owner = fixtureRuntime()
  const adapter = new DurableCatalogReadAdapter({...fixtureConfig(pool), projectGroupIds: [group]})
  t.after(() => adapter.dispose())
  let legacyCalls = 0
  // The registry must replace this fixture sentinel while preserving the
  // incumbent public name/schema. Actual server declaration is unchanged.
  const declaration = defineMethod({name: 'session.tabs.close', params: CloseTab,
    handler: async () => {legacyCalls++; throw new Error('unexpected legacy close') }})
  const bound = adapter.bind(eraseRpcMethods([declaration]))[0]
  assert.equal(bound.name, declaration.name); assert.equal(bound.params, declaration.params)
  const context = fixtureContext(owner.runtime)
  const invoke = (params: unknown, callContext = context) => bound.handler(CloseTab.parse(params) as never, callContext)
  const emptyParams = {worktree: `id:${empty.tab.workspace_id}`, tabId: empty.publicTabId, reason: 'user', clientMutationId: randomUUID()}
  await assert.rejects(invoke(emptyParams, {...context, authenticatedCallerFingerprint: undefined}), /CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
  assert.deepEqual(await invoke(emptyParams), {closed: true})
  const closed = (await pool.query(`SELECT t.lifecycle AS tab_lifecycle,t.closed_at,s.lifecycle AS session_lifecycle,s.session_fence
    FROM durable_runtime.tabs t JOIN durable_runtime.sessions s ON s.id=t.session_id WHERE t.id=$1`, [empty.tab.id])).rows[0]
  assert.equal(closed.tab_lifecycle, 'CLOSED'); assert.ok(closed.closed_at)
  assert.equal(closed.session_lifecycle, 'CLOSING'); assert.equal(closed.session_fence, '1')
  const before = (await pool.query(`SELECT
    (SELECT to_jsonb(t) FROM durable_runtime.tabs t WHERE t.id=$1) AS tab,
    (SELECT to_jsonb(s) FROM durable_runtime.sessions s WHERE s.id=$2) AS session,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM durable_runtime.messages m WHERE m.session_id=$2) AS messages,
    (SELECT count(*)::text FROM durable_runtime.cancel_intents WHERE session_id=$2) AS cancels,
    (SELECT count(*)::text FROM durable_runtime.rpc_receipts WHERE method='session.tabs.close') AS receipts,
    (SELECT count(*)::text FROM durable_runtime.outbox_events) AS outbox`, [pending.tab.id, pending.request.authority.sessionId])).rows[0]
  await assert.rejects(invoke({worktree: `id:${pending.tab.workspace_id}`, tabId: pending.publicTabId,
    reason: 'user', clientMutationId: randomUUID()}), /CATALOG_CANCEL_AUTHORITY_REQUIRED/)
  const after = (await pool.query(`SELECT
    (SELECT to_jsonb(t) FROM durable_runtime.tabs t WHERE t.id=$1) AS tab,
    (SELECT to_jsonb(s) FROM durable_runtime.sessions s WHERE s.id=$2) AS session,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM durable_runtime.messages m WHERE m.session_id=$2) AS messages,
    (SELECT count(*)::text FROM durable_runtime.cancel_intents WHERE session_id=$2) AS cancels,
    (SELECT count(*)::text FROM durable_runtime.rpc_receipts WHERE method='session.tabs.close') AS receipts,
    (SELECT count(*)::text FROM durable_runtime.outbox_events) AS outbox`, [pending.tab.id, pending.request.authority.sessionId])).rows[0]
  assert.deepEqual(after, before)
  assert.equal(legacyCalls, 0); assert.deepEqual(owner.unexpected, [])
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
})
