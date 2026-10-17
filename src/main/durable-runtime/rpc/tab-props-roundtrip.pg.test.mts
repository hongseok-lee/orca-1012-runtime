import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { assertManagedCatalogTarget } from '../terminal/catalog-target.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { fixtureContext, fixtureRuntime } from './fixture-support.mts'
import { createCatalogMetadataFacade, mutateCatalogRpc } from './metadata.ts'

if (process.env.ORCA_TERMINAL_PUBLIC_DB !== 'orca_public_clipboard_20261014' ||
    process.env.PGDATABASE !== process.env.ORCA_TERMINAL_PUBLIC_DB) {
  throw new Error('Exact isolated tab props roundtrip database required')
}

// Reuse the exact one UUID-scoped tab-props fixture; no new Session/seed or old callback.
await test('mode roundtrip advances semantic Tab revision and cannot revive the original Chat pin', async t => {
  const pool = createDurablePool({max: 3})
  t.after(async () => { await pool.end() })
  const identity = (await pool.query(`SELECT current_database() AS name,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system,
    (SELECT dataset_name FROM durable_runtime.dataset_metadata) AS dataset,pg_backend_pid() AS pid`)).rows[0]
  assert.equal(identity.name, 'orca_public_clipboard_20261014'); assert.equal(identity.oid, '80991')
  assert.equal(identity.system, '7696101282789175327'); assert.equal(identity.dataset, 'orca-1012-dev-v1')
  const ledger = (await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 19)
  const owned = (await pool.query(`SELECT w.public_id,t.*,m.payload,m.binding_revision,m.public_tab_id
    FROM durable_runtime.catalog_workspace_metadata c JOIN durable_runtime.workspaces w ON w.id=c.workspace_id
    JOIN durable_runtime.tabs t ON t.workspace_id=w.id JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id
    WHERE c.project_group_id LIKE 'tab-props:%' AND t.lifecycle='OPEN'
      AND m.public_tab_id LIKE '%::first' AND m.payload->>'viewMode'='chat'`)).rows
  assert.equal(owned.length, 1, 'exact original tab-props callback target; no newest-row selection')
  const original = owned[0], session = logicalId('session', original.session_id)
  const read = async () => (await pool.query(`SELECT t.revision,m.binding_revision,m.payload FROM durable_runtime.tabs t
    JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id WHERE t.id=$1`, [original.id])).rows[0]
  const beforeHeads = (await pool.query('SELECT scope,revision FROM durable_runtime.catalog_heads ORDER BY scope')).rows
  const state = async () => (await pool.query(`SELECT
    (SELECT to_jsonb(s) FROM durable_runtime.sessions s WHERE id=$1) AS session,
    (SELECT to_jsonb(u) FROM durable_runtime.runtime_units u JOIN durable_runtime.runtime_members r ON r.runtime_unit_id=u.id WHERE r.session_id=$1) AS unit,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.terminal_handle) FROM durable_runtime.legacy_drafts d WHERE session_id=$1) AS draft,
    (SELECT to_jsonb(f) FROM durable_runtime.terminal_input_floors f WHERE terminal_handle=$2) AS floor,
    (SELECT count(*)::int FROM durable_runtime.input_components WHERE session_id=$1) AS inputs`, [session, original.terminal_handle])).rows[0]
  const beforeState = await state(), context = fixtureContext(fixtureRuntime().runtime)
  const config = captureDurableCatalogReadConfig({pool, datasetName: identity.dataset, hostId: 'local', readHostIdentity: () => 'local',
    repositoryIds: [], projectGroupIds: [], workspacePublicIds: [original.public_id]})
  const facade = createCatalogMetadataFacade(config)
  const invoke = (patch: object) => mutateCatalogRpc(config, facade, 'session.tabs.setTabProps',
    {worktree: `id:${original.public_id}`, tabId: original.public_tab_id, ...patch}, context)
  const binding = {sessionId: session, logicalHandle: original.terminal_handle, principalId: beforeState.floor.principal_id,
    pairedDeviceId: beforeState.floor.paired_device_id, connectionId: beforeState.floor.connection_id,
    floorGeneration: beforeState.floor.floor_generation, mode: 'AGENT_CHAT_COMPAT' as const}
  const pin = {tabId: original.id, tabRevision: original.revision,
    bindingRevision: original.binding_revision, provider: 'codex', payload: original.payload}
  assert.deepEqual(await invoke({viewMode: 'chat'}), {updated: true})
  assert.equal((await read()).revision, original.revision, 'same mode is not a transition')
  assert.deepEqual(await invoke({color: original.payload.color}), {updated: true})
  assert.equal((await read()).revision, original.revision, 'omitted mode is unchanged')
  assert.deepEqual(await invoke({viewMode: 'terminal'}), {updated: true})
  assert.equal((await read()).revision, String(BigInt(original.revision) + 1n))
  assert.deepEqual(await invoke({viewMode: 'chat'}), {updated: true})
  const after = await read()
  assert.equal(after.revision, String(BigInt(original.revision) + 2n))
  assert.equal(after.binding_revision, original.binding_revision)
  assert.deepEqual(after.payload, original.payload)
  await assert.rejects(withDurableTransaction(pool, async tx => {
    await lockAggregates(tx, {sessionIds: [session]})
    await assertManagedCatalogTarget(tx, pin, binding)
  }), /TERMINAL_CATALOG_TARGET_CHANGED/)
  assert.deepEqual(await state(), beforeState)
  const afterHeads = (await pool.query('SELECT scope,revision FROM durable_runtime.catalog_heads ORDER BY scope')).rows
  assert.deepEqual(afterHeads.map(row => ({...row, revision: String(BigInt(row.revision) - 4n)})), beforeHeads)
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  t.diagnostic(JSON.stringify({phase: 'roundtrip-complete', ...identity, targetTab: original.id,
    targetWorkspace: original.workspace_id, semanticRevisionBefore: original.revision,
    semanticRevisionAfter: after.revision, bindingRevisionUnchanged: true, originalPinStale: true, oldCallbacksRepeated: 0}))
})
