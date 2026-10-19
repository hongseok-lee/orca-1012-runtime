import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { fixture, instrumentPool } from '../input/verification-fixtures.mts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { createCatalogTerminalSendRpc } from './terminal-send.ts'
import { fixtureRuntime, fixtureContext } from './fixture-support.mts'
import { TerminalConnectionOwner } from '../../runtime/rpc/terminal-connection-owner.ts'
import { buildAgentTuiClearInputForText } from '../../../shared/agent-tui-input-clear.ts'

if (process.env.ORCA_TERMINAL_PUBLIC_DB !== 'orca_public_clipboard_20261014' ||
    process.env.PGDATABASE !== process.env.ORCA_TERMINAL_PUBLIC_DB) {
  throw new Error('Exact isolated Terminal public fixture database required')
}

// This is a synthetic authenticated socket owner, not a pairing/provider proof.
await test('public managed Terminal preserves owner, draft, receipt and uncertain COMMIT boundaries', async t => {
  const pool = createDurablePool({ max: 4 })
  t.after(async () => { await pool.end() })
  const identity = (await pool.query(`SELECT current_database() AS name,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system,
    (SELECT dataset_name FROM durable_runtime.dataset_metadata) AS dataset,
    pg_backend_pid() AS pid`)).rows[0]
  assert.equal(identity.name, 'orca_public_clipboard_20261014')
  assert.equal(identity.oid, '80991')
  assert.equal(identity.system, '7696101282789175327')
  assert.equal(identity.dataset, 'orca-1012-dev-v1')
  const ledger = (await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 19)
  t.diagnostic(JSON.stringify({ phase: 'same-pool-identity', ...identity, ledger: ledger.length }))
  const f = await fixture(pool), session = f.request.authority.sessionId
  const tab = (await pool.query('SELECT * FROM durable_runtime.tabs WHERE terminal_handle=$1', [f.terminalHandle])).rows[0]
  const group = `terminal-public:${randomUUID()}`
  const tabPayload = { id: `tab:${randomUUID()}`, type: 'terminal', title: 'synthetic managed Chat',
    isActive: true, parentTabId: 'synthetic-parent', leafId: 'synthetic-leaf', status: 'ready',
    terminal: f.terminalHandle, viewMode: 'chat' }
  await withDurableTransaction(pool, async tx => {
    await tx.query("UPDATE durable_runtime.agents SET provider='codex' WHERE id=(SELECT agent_id FROM durable_runtime.sessions WHERE id=$1)", [session])
    await tx.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [group, { id: group }])
    await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata
      (workspace_id,kind,project_group_id,reserved_path,payload,create_request,runtime_unit_id)
      VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}',$5)`, [tab.workspace_id, group, `/synthetic/terminal/${group}`,
      { id: tab.workspace_id, projectGroupId: group, name: 'Terminal fixture', folderPath: `/synthetic/terminal/${group}`,
        comment: '', createdAt: 1, updatedAt: 1, lastActivityAt: 1, sortOrder: 0,
        isArchived: false, isUnread: false, isPinned: false, executionHostId: 'local' }, f.unitId])
    await tx.query('INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request) VALUES($1,$2,$3,\'{}\')',
      [tab.id, tabPayload.id, tabPayload])
  })
  const runtime = fixtureRuntime().runtime, fingerprint = 'a'.repeat(64), device = randomUUID()
  const owner = new TerminalConnectionOwner()
  const connect = (id: string, registry = owner, caller = fingerprint, paired = device) => {
    registry.register(id, paired)
    return fixtureContext(runtime, { requestId: randomUUID(), pairedDeviceId: paired,
      authenticatedCallerFingerprint: caller, terminalInputConnection: registry.capture(id, paired, caller, () => true) })
  }
  let context = connect('first')
  const configuration = (borrowed: Pool) => captureDurableCatalogReadConfig({ pool: borrowed,
    datasetName: identity.dataset, hostId: 'local', readHostIdentity: () => 'local',
    repositoryIds: [], projectGroupIds: [group], workspacePublicIds: [] })
  let legacyCalls = 0
  const legacy = () => { legacyCalls++; return { originalLegacy: true } }
  const handler = createCatalogTerminalSendRpc(configuration(pool))
  const send = (text: string, enter = false, key = randomUUID(), active = context) =>
    handler({ terminal: f.terminalHandle, text, enter, client: { id: 'forged', type: 'mobile' } },
      { ...active, requestId: key }, legacy)
  const accepted = { send: { handle: f.terminalHandle, accepted: true, bytesWritten: 0 } }
  const state = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM durable_runtime.input_components WHERE session_id=$1) AS inputs,
    (SELECT count(*)::int FROM durable_runtime.rpc_receipts WHERE method='terminal.send' AND session_scope=$2) AS receipts,
    (SELECT to_jsonb(f) FROM durable_runtime.terminal_input_floors f WHERE terminal_handle=$3) AS floor,
    (SELECT count(*)::int FROM durable_runtime.session_events WHERE session_id=$1) AS events`,
    [session, JSON.stringify(['terminal', f.terminalHandle]), f.terminalHandle])).rows[0]
  const texts = async () => (await pool.query(`SELECT body_or_blob_ref->'payload'->>'text' AS text
    FROM durable_runtime.input_components WHERE session_id=$1 ORDER BY input_seq`, [session])).rows.map(row => row.text)
  // Caller mutation is captured before the first checkout/await, including callbacks.
  const mutable = { terminal: f.terminalHandle, text: 'iPhone original\n😀 /logical/image.png', enter: true }
  const mutableContext = { ...context, requestId: randomUUID() }
  const mutating = instrumentPool(pool, { onConnect: async n => {
    if (n === 1) {
      mutable.text = 'replacement'; mutableContext.requestId = 'replacement'
      mutableContext.terminalInputConnection = connect('unrelated').terminalInputConnection
    }
  } })
  assert.deepEqual(await createCatalogTerminalSendRpc(configuration(mutating))(mutable, mutableContext, legacy), accepted)
  assert.deepEqual(await texts(), ['iPhone original\n😀 /logical/image.png'])
  const key = randomUUID()
  assert.deepEqual(await send('Mac draft', false, key), accepted)
  const first = await state()
  assert.deepEqual(await send('Mac draft', false, key), accepted)
  assert.deepEqual(await state(), first)
  await assert.rejects(send('different', false, key), /RECEIPT_PAYLOAD_CONFLICT/)
  const other = connect('second')
  await assert.rejects(send('cannot steal', false, randomUUID(), other), /INVALIDATION_UNPROVEN/)
  owner.invalidate('first')
  context = other
  assert.deepEqual(await send('\r'), accepted)
  assert.deepEqual(await texts(), ['iPhone original\n😀 /logical/image.png', 'Mac draft'])
  // A new server process: the same device and caller take the earlier process's floor over.
  const restartOwner = new TerminalConnectionOwner()
  context = connect('after-restart', restartOwner)
  assert.deepEqual(await send('discard me'), accepted)
  assert.deepEqual(await send(buildAgentTuiClearInputForText('discard me')), accepted)
  assert.deepEqual(await send('after clear', true), accepted)
  assert.equal((await texts()).at(-1), 'after clear')
  // Another device (iPhone) sending to the same session takes the floor at the next generation, and back.
  const generation = async () => BigInt((await state()).floor.floor_generation)
  const before = await generation()
  const phone = connect('phone', restartOwner, 'b'.repeat(64), randomUUID())
  assert.deepEqual(await send('from phone', true, randomUUID(), phone), accepted)
  assert.equal((await texts()).at(-1), 'from phone')
  assert.equal(await generation(), before + 1n)
  assert.deepEqual(await send('mac again', true), accepted)
  assert.equal((await texts()).at(-1), 'mac again')
  assert.equal(await generation(), before + 2n)
  const beforeUnsupported = await state()
  await assert.rejects(handler({ terminal: f.terminalHandle, interrupt: true }, { ...context, requestId: randomUUID() }, legacy), /SEMANTIC_NOT_CONNECTED/)
  await assert.rejects(handler({ terminal: f.terminalHandle, text: '\x1b[1;1R', inputKind: 'query-reply' },
    { ...context, requestId: randomUUID() }, legacy), /SEMANTIC_NOT_CONNECTED/)
  await pool.query("UPDATE durable_runtime.catalog_tab_metadata SET payload=payload-'viewMode' WHERE tab_id=$1", [tab.id])
  await assert.rejects(send('omitted is not Chat', true), /RAW_NOT_CONNECTED/)
  await pool.query('UPDATE durable_runtime.catalog_tab_metadata SET payload=$2 WHERE tab_id=$1', [tab.id, tabPayload])
  assert.deepEqual(await state(), beforeUnsupported)
  // Owned but incomplete metadata never reaches the original PTY path.
  const incomplete = `terminal-incomplete:${randomUUID()}`
  await pool.query("INSERT INTO durable_runtime.tabs(id,workspace_id,kind,terminal_handle,ui_order,lifecycle) VALUES($1,$2,'terminal',$3,2,'OPEN')",
    [randomUUID(), tab.workspace_id, incomplete])
  await assert.rejects(handler({ terminal: incomplete, text: 'must refuse' }, context, legacy), /MANAGED_TARGET_INCOMPLETE/)
  assert.deepEqual(await handler({ terminal: `unowned:${randomUUID()}`, text: 'legacy' }, context, legacy), { originalLegacy: true })
  assert.equal(legacyCalls, 1)
  // Change only this fixture's mode between baseline and claim. No draft/intake mutation is allowed.
  let changed = false
  const stalePool = instrumentPool(pool, { onConnect: async n => {
    if (n === 5) {
      changed = true
      await pool.query("UPDATE durable_runtime.catalog_tab_metadata SET payload=jsonb_set(payload,'{viewMode}','\"terminal\"') WHERE tab_id=$1", [tab.id])
    }
  } })
  await assert.rejects(createCatalogTerminalSendRpc(configuration(stalePool))(
    { terminal: f.terminalHandle, text: 'stale mode', enter: true }, { ...context, requestId: randomUUID() }, legacy))
  assert.equal(changed, true)
  await pool.query('UPDATE durable_runtime.catalog_tab_metadata SET payload=$2 WHERE tab_id=$1', [tab.id, tabPayload])
  assert.deepEqual(await state(), beforeUnsupported)
  // Simulate loss of this client's COMMIT acknowledgement after PG really committed.
  let lost = false
  const uncertainPool = new Proxy(pool, { get(target, property) {
    if (property === 'connect') {
      return async () => {
        const client = await target.connect(); let receiptWritten = false
        return new Proxy(client, { get(connection, name) {
          if (name === 'query') {
            return async (...args: unknown[]) => {
              const sql = String(args[0]), result = await Reflect.apply(connection.query, connection, args)
              if (sql.startsWith('INSERT INTO durable_runtime.rpc_receipts')) { receiptWritten = true }
              if (sql === 'COMMIT' && receiptWritten && !lost) { lost = true; throw new Error('synthetic lost COMMIT acknowledgement') }
              return result
            }
          }
          const value = Reflect.get(connection, name)
          return typeof value === 'function' ? value.bind(connection) : value
        } })
      }
    }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const uncertainKey = randomUUID(), uncertainParams = { terminal: f.terminalHandle, text: 'uncertain original', enter: true }
  await assert.rejects(createCatalogTerminalSendRpc(configuration(uncertainPool))(uncertainParams,
    { ...context, requestId: uncertainKey }, legacy), /COMMIT_UNCERTAIN_RESOLVE_SAME_KEY/)
  assert.equal(lost, true)
  const committed = await state()
  assert.deepEqual(await handler(uncertainParams, { ...context, requestId: uncertainKey }, legacy), accepted)
  assert.deepEqual(await state(), committed)
  assert.equal((await texts()).filter(text => text === 'uncertain original').length, 1)
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  assert.equal((await pool.query('SELECT phase FROM durable_runtime.runtime_units WHERE id=$1', [f.unitId])).rows[0].phase, 'ABSENT')
  t.diagnostic(JSON.stringify({ phase: 'complete', inputs: committed.inputs, legacyCalls, providerCalls: 0, podCreated: 0 }))
})
