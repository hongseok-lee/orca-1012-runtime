import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { fixture } from '../input/verification-fixtures.mts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { createCatalogTerminalSendRpc } from './terminal-send.ts'
import { fixtureRuntime, fixtureContext, deferred } from './fixture-support.mts'
import { TerminalConnectionOwner } from '../../runtime/rpc/terminal-connection-owner.ts'
import { buildAgentTuiClearInputForText } from '../../../shared/agent-tui-input-clear.ts'

if (process.env.ORCA_TERMINAL_PUBLIC_DB !== 'orca_public_clipboard_20261014' ||
    process.env.PGDATABASE !== process.env.ORCA_TERMINAL_PUBLIC_DB) {
  throw new Error('Exact isolated Terminal ordering database required')
}

// One new overlapping ingress boundary; the prior sequential callback is reused.
await test('overlapping clear/body/CR keeps arrival order and fences later input after uncertain COMMIT', async t => {
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
  t.diagnostic(JSON.stringify({ phase: 'same-pool-identity', ...identity, ledger: ledger.length }))
  const f = await fixture(pool), session = f.request.authority.sessionId
  const tab = (await pool.query('SELECT * FROM durable_runtime.tabs WHERE terminal_handle=$1', [f.terminalHandle])).rows[0]
  const group = `terminal-order:${randomUUID()}`, publicTab = `terminal-tab:${randomUUID()}`
  await withDurableTransaction(pool, async tx => {
    await tx.query("UPDATE durable_runtime.agents SET provider='codex' WHERE id=(SELECT agent_id FROM durable_runtime.sessions WHERE id=$1)", [session])
    await tx.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [group, { id: group }])
    await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata
      (workspace_id,kind,project_group_id,reserved_path,payload,create_request,runtime_unit_id)
      VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}',$5)`, [tab.workspace_id, group, `/synthetic/terminal/${group}`,
      { id: tab.workspace_id, projectGroupId: group, name: 'Terminal ordering', folderPath: `/synthetic/terminal/${group}`,
        comment: '', createdAt: 1, updatedAt: 1, lastActivityAt: 1, sortOrder: 0,
        isArchived: false, isUnread: false, isPinned: false, executionHostId: 'local' }, f.unitId])
    await tx.query("INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request) VALUES($1,$2,$3,'{}')",
      [tab.id, publicTab, { id: publicTab, type: 'terminal', title: 'synthetic managed Chat', isActive: true,
        parentTabId: 'parent', leafId: 'leaf', status: 'ready', terminal: f.terminalHandle, viewMode: 'chat' }])
  })
  const owner = new TerminalConnectionOwner(), device = randomUUID(), fingerprint = 'a'.repeat(64)
  owner.register('ordered', device)
  const connection = owner.capture('ordered', device, fingerprint, () => true)
  const context = fixtureContext(fixtureRuntime().runtime, { pairedDeviceId: device,
    authenticatedCallerFingerprint: fingerprint, terminalInputConnection: connection })
  const entered = deferred<void>(), release = deferred<void>()
  let reads = 0, receiptCommits = 0, lost = false
  const observed = new Proxy(pool, { get(target, property) {
    if (property === 'connect') {
      return async () => {
        const client = await target.connect(); let receiptWritten = false
        return new Proxy(client, { get(original, key) {
          if (key === 'query') {
            return async (...args: unknown[]) => {
              const sql = String(args[0])
              if (sql === 'SELECT id FROM durable_runtime.tabs WHERE terminal_handle=$1') {
                reads++
                if (reads === 1) { entered.resolve(); await release.promise }
              }
              const result = await Reflect.apply(original.query, original, args)
              if (sql.startsWith('INSERT INTO durable_runtime.rpc_receipts')) { receiptWritten = true }
              if (sql === 'COMMIT' && receiptWritten) {
                receiptWritten = false; receiptCommits++
                if (receiptCommits === 3 && !lost) { lost = true; throw new Error('synthetic CR COMMIT acknowledgement lost') }
              }
              return result
            }
          }
          const value = Reflect.get(original, key)
          return typeof value === 'function' ? value.bind(original) : value
        } })
      }
    }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const handler = createCatalogTerminalSendRpc(captureDurableCatalogReadConfig({ pool: observed,
    datasetName: identity.dataset, hostId: 'local', readHostIdentity: () => 'local',
    repositoryIds: [], projectGroupIds: [group], workspacePublicIds: [] }))
  const legacy = () => { throw new Error('Managed input must not use legacy PTY') }
  const invoke = (params: unknown, id: string) => handler(params, { ...context, requestId: id }, legacy)
  const ids = Array.from({ length: 4 }, () => randomUUID())
  const body = { terminal: f.terminalHandle, text: 'original overlapped body 😀' }
  const clear = invoke({ terminal: f.terminalHandle, text: buildAgentTuiClearInputForText('old') }, ids[0])
  const draft = invoke(body, ids[1])
  const submit = invoke({ terminal: f.terminalHandle, text: '\r' }, ids[2])
  const following = invoke({ terminal: f.terminalHandle, text: 'must not guess', enter: true }, ids[3])
  // Install observers immediately; rejected later requests must not be unhandled.
  const combined = Promise.allSettled([clear, draft, submit, following])
  body.text = 'mutated after enqueue'
  await entered.promise
  assert.equal(reads, 1, 'later sends cannot overtake the first target read')
  assert.equal(await connection.runOrderedInput('unrelated-handle', 'unrelated-key', async () => 'independent'), 'independent')
  release.resolve()
  const results = await combined
  const accepted = { send: { handle: f.terminalHandle, accepted: true, bytesWritten: 0 } }
  assert.deepEqual(results[0], { status: 'fulfilled', value: accepted })
  assert.deepEqual(results[1], { status: 'fulfilled', value: accepted })
  assert.equal(results[2].status, 'rejected'); assert.equal(results[3].status, 'rejected')
  if (results[2].status !== 'rejected' || results[3].status !== 'rejected') { throw new Error('Missing uncertain fence') }
  assert.match(String(results[2].reason), /COMMIT_UNCERTAIN_RESOLVE_SAME_KEY/)
  assert.match(String(results[3].reason), /PRIOR_COMMIT_UNCERTAIN/)
  assert.equal(reads, 3); assert.equal(lost, true)
  const texts = async () => (await pool.query(`SELECT body_or_blob_ref->'payload'->>'text' AS text
    FROM durable_runtime.input_components WHERE session_id=$1 ORDER BY input_seq`, [session])).rows.map(row => row.text)
  assert.deepEqual(await texts(), ['original overlapped body 😀'])
  assert.deepEqual(await invoke({ terminal: f.terminalHandle, text: '\r' }, ids[2]), accepted)
  assert.deepEqual(await texts(), ['original overlapped body 😀'])
  assert.deepEqual(await invoke({ terminal: f.terminalHandle, text: 'explicit following input', enter: true }, randomUUID()), accepted)
  assert.deepEqual(await texts(), ['original overlapped body 😀', 'explicit following input'])
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  t.diagnostic(JSON.stringify({ phase: 'ordered-complete', delayedFirstRead: true,
    priorCommitFence: true, sameKeyResolution: true, unrelatedHandleIndependent: true, providerCalls: 0 }))
})
