import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, after } from 'node:test'
import type { Pool } from 'pg'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { registerCatalogProject } from '../catalog/register.ts'
import type { CatalogRegistration } from '../catalog/register.ts'
import { captureDurableCatalogReadConfig, type DurableCatalogReadConfig } from './config.ts'
import { captureCatalogReadContext } from './context.ts'
import { DurableCatalogReadAdapter } from './public.ts'
import { fixtureConfig, fixtureRuntime, fixtureContext, deferred } from './fixture-support.mts'
import { eraseRpcMethods } from '../../runtime/rpc/core.ts'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher.ts'
import { WORKTREE_METHODS } from '../../runtime/rpc/methods/worktree.ts'
import { SESSION_TAB_METHODS } from '../../runtime/rpc/methods/session-tabs.ts'
import type { RuntimeMobileSessionTabsResult, RuntimeMobileSessionCreateTerminalResult } from '../../../shared/runtime-session-contracts.ts'
import type { CatalogWireResults } from '../catalog/wire.ts'

// Source only. The runner must supply an already prepared, separate owned DB.
// No migrations, deletes, grant, guard changes or physical runtime preparation.
if (process.env.ORCA_P116_CREATION_APPROVED !== 'root-source-reviewed' ||
    !(process.env.PGDATABASE ?? '').startsWith('orca_p116_creation_')) { throw new Error('Root review and owned creation DB required') }
const pool = createDurablePool({ max: 4 })
after(async () => { await pool.end() })
const original = eraseRpcMethods([...WORKTREE_METHODS, ...SESSION_TAB_METHODS])
const ui = { lastActiveRepoId: null, lastActiveWorktreeId: null, activeView: 'terminal', sidebarWidth: 240,
  rightSidebarOpen: false, rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files', rightSidebarWidth: 320,
  groupBy: 'none', sortBy: 'smart', projectOrderBy: 'manual', showActiveOnly: false, hideDefaultBranchWorkspace: false,
  filterRepoIds: [], collapsedGroups: [], uiZoomLevel: 0, editorFontZoomLevel: 0, worktreeCardProperties: [],
  statusBarItems: [], statusBarVisible: true, dismissedUpdateVersion: null, lastUpdateCheckAt: null }
async function fixture(kind: 'folder' | 'git' = 'folder') {
  const id = randomUUID(), repoId = `synthetic-creation:${id}`, root = `/synthetic/creation/${id}`
  const config: DurableCatalogReadConfig = { ...fixtureConfig(pool), repositoryIds: [repoId], launch: {
    policy: { operationDeadlineMs: 30000, idleDurationMs: null }, repositories: [{ repositoryId: repoId,
      worktreeRoot: `${root}/worktrees`, agentHomeRoot: `${root}/homes`,
      storage: { backendId: `synthetic-backend:${id}`, exportId: 'synthetic-export', canonicalDirectory: root } }] } }
  const owner = fixtureRuntime()
  const authority = captureCatalogReadContext(captureDurableCatalogReadConfig(config), fixtureContext(owner.runtime)).authority
  await registerCatalogProject(pool, authority, { mutationId: `synthetic-register:${id}`, group: null, ui,
    repo: { id: repoId, path: `${root}/repo`, displayName: repoId, kind, executionHostId: 'local', badgeColor: '#ffffff', addedAt: 1 } } as CatalogRegistration)
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,'synthetic-export')", [config.launch!.repositories[0].storage.backendId])
  })
  return { id, repoId, root, config }
}
function setup(config: DurableCatalogReadConfig, borrowed: Pool = pool) {
  const owner = fixtureRuntime(), adapter = new DurableCatalogReadAdapter({ ...config, pool: borrowed })
  const dispatcher = new RpcDispatcher({ runtime: owner.runtime, methods: adapter.bind(original) })
  const invoke = async (method: string, params: unknown) => {
    const result = await dispatcher.dispatch({ id: randomUUID(), method, params, authToken: '' }, {
      authenticatedCallerFingerprint: 'a'.repeat(64), clientKind: 'mobile', clientCapabilities: fixtureContext(owner.runtime).clientCapabilities })
    if (!result.ok) { throw new Error(result.error.message) }
    return result.result
  }
  return { ...owner, adapter, invoke }
}
function observedPool(loseCommit = false, wait?: () => Promise<void>) {
  let lost = 0, endCalls = 0
  const borrowed = new Proxy(pool, { get(target, property) {
    if (property === 'end') { return () => { endCalls++; throw new Error('Borrowed Pool ownership violated') } }
    if (property === 'connect') { return async () => {
      await wait?.()
      const client = await target.connect(); let wroteReceipt = false
      return new Proxy(client, { get(object, key) {
        if (key === 'query') { return async (...args: unknown[]) => {
          const sql = String(args[0]); if (/INSERT INTO durable_runtime.rpc_receipts/i.test(sql)) { wroteReceipt = true }
          const result = await (object.query as (...input: unknown[]) => Promise<unknown>).apply(object, args)
          if (loseCommit && lost === 0 && wroteReceipt && sql === 'COMMIT') {
            lost++; throw Object.assign(new Error('Synthetic commit acknowledgement loss'), { code: '08006' })
          }
          return result
        } }
        const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value
      } })
    } }
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
  } })
  return { borrowed, lost: () => lost, endCalls: () => endCalls }
}
async function physicalCounts() {
  return (await pool.query(`SELECT (SELECT count(*)::integer FROM durable_runtime.attempts) AS attempts,
    (SELECT count(*)::integer FROM durable_runtime.storage_write_grants) AS storage_grants,
    (SELECT count(*)::integer FROM durable_runtime.execution_grants) AS execution_grants,
    (SELECT count(*)::integer FROM durable_runtime.storage_bindings WHERE identity_verified_at IS NOT NULL) AS verifications`)).rows[0]
}
async function stored(worktree: string) {
  return (await pool.query(`SELECT w.id,w.provisioning_state,m.runtime_unit_id,u.phase,u.active_attempt_id,
    u.last_work_event_at,b.id AS binding_id,b.backend_id,b.export_id,b.canonical_directory,b.access_state,b.identity_proof_ref,
    s.id AS session_id,s.agent_id,t.terminal_handle,t.leaf_id,tm.launch_request,tm.launch_token,tm.payload
    FROM durable_runtime.workspaces w JOIN durable_runtime.catalog_workspace_metadata m ON m.workspace_id=w.id
    JOIN durable_runtime.runtime_units u ON u.id=m.runtime_unit_id
    JOIN durable_runtime.sessions s ON s.workspace_id=w.id JOIN durable_runtime.runtime_members rm ON rm.session_id=s.id
    JOIN durable_runtime.storage_bindings b ON b.id=rm.storage_binding_id JOIN durable_runtime.tabs t ON t.session_id=s.id
    JOIN durable_runtime.catalog_tab_metadata tm ON tm.tab_id=t.id WHERE w.public_id=$1 ORDER BY t.ui_order`, [worktree])).rows
}

await test('repo-folder public creation and additional terminal retain immutable original requests and one Unit with logical pending surfaces only', async () => {
  const ws = await fixture(), state = setup(ws.config), before = await physicalCounts()
  const request = { repo: `id:${ws.repoId}`, name: 'typed-name', clientMutationId: `create:${ws.id}`, startupAgent: 'claude',
    startupPrompt: 'synthetic prompt', startupDraft: 'synthetic draft', startupEnv: { SYNTHETIC_FIELD: 'retained' }, startupCommandDelivery: 'shell-ready',
    activate: false, navigation: 'caller', noParent: true, comment: 'synthetic comment' }
  try {
    const result = await state.invoke('worktree.create', request) as CatalogWireResults['worktree.create']
    const worktree = result.worktree.id, first = (await stored(worktree))[0]
    assert.match(worktree, /::workspace:[0-9a-f-]+$/)
    assert.equal(first.provisioning_state, 'PENDING'); assert.equal(first.phase, 'ABSENT'); assert.equal(first.active_attempt_id, null)
    assert.equal(first.access_state, 'UNVERIFIED'); assert.equal(first.identity_proof_ref, null)
    assert.equal(first.last_work_event_at, null); assert.deepEqual(first.launch_request.params, request)
    assert.equal(first.launch_request.server.agentHomePath, `${ws.root}/homes/${first.agent_id}`)
    assert.equal(first.payload.status, 'pending-handle'); assert.equal(first.payload.terminal, null)
    assert.equal(first.payload.ptyId, undefined); assert.equal(first.payload.incarnationId, undefined)
    const listed = await state.invoke('worktree.list', {}) as { worktrees: { id: string }[] }
    assert.ok(listed.worktrees.some(row => row.id === worktree))
    const terminal = { worktree: `id:${worktree}`, command: 'synthetic retained command', env: { SYNTHETIC_FIELD: 'terminal' },
      envToDelete: ['SYNTHETIC_REMOVE'], launchToken: `synthetic-token:${ws.id}`, startupCommandDelivery: 'fast', activate: true,
      clientMutationId: `terminal:${ws.id}` }
    const added = await state.invoke('session.tabs.createTerminal', terminal) as RuntimeMobileSessionCreateTerminalResult
    const rows = await stored(worktree); assert.equal(rows.length, 2)
    assert.equal(rows[0].runtime_unit_id, rows[1].runtime_unit_id); assert.equal(rows[0].binding_id, rows[1].binding_id)
    assert.notEqual(rows[0].session_id, rows[1].session_id); assert.notEqual(rows[0].agent_id, rows[1].agent_id)
    assert.deepEqual(rows[1].launch_request.params, terminal); assert.equal(rows[1].launch_token, terminal.launchToken)
    assert.equal(added.tab.status, 'pending-handle'); assert.equal(added.tab.terminal, null)
    const tabs = await state.invoke('session.tabs.list', { worktree: `id:${worktree}` }) as RuntimeMobileSessionTabsResult
    assert.equal(tabs.tabs.length, 2); assert.deepEqual(added.tab, tabs.tabs.find(row => row.id === added.tab.id))
    const effects = (await pool.query(`SELECT (SELECT count(*)::integer FROM durable_runtime.rpc_receipts WHERE operation_key=ANY($1)) AS receipts,
      (SELECT count(*)::integer FROM durable_runtime.runtime_audit_events WHERE next_state->>'publicId'=$2 OR next_state->>'publicTabId'=$3) AS audit,
      (SELECT count(*)::integer FROM durable_runtime.outbox_events WHERE aggregate_id=$4) AS outbox,
      (SELECT count(*)::integer FROM durable_runtime.operations WHERE runtime_unit_id=$5) AS operations`,
    [[request.clientMutationId, terminal.clientMutationId], worktree, added.tab.id, first.id, first.runtime_unit_id])).rows[0]
    assert.equal(effects.receipts, 2); assert.equal(effects.audit, 2); assert.equal(effects.outbox, 2); assert.ok(effects.operations >= 1)
    assert.deepEqual(await physicalCounts(), before); assert.deepEqual(state.unexpected, [])
  } finally { state.adapter.dispose() }
})

await test('original receipts precede tombstones and changed launch preparation conditions; a different payload keeps its conflict', async () => {
  const ws = await fixture(), state = setup(ws.config)
  const request = { repo: `id:${ws.repoId}`, name: 'receipt-first', clientMutationId: `receipt:${ws.id}` }
  try {
    const created = await state.invoke('worktree.create', request) as CatalogWireResults['worktree.create']
    const terminalRequest = { worktree: `id:${created.worktree.id}`, clientMutationId: `terminal-replay:${ws.id}` }
    const terminal = await state.invoke('session.tabs.createTerminal', terminalRequest)
    await withDurableTransaction(pool, async tx => {
      await tx.query('UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp() WHERE public_id=$1', [created.worktree.id])
      await tx.query('UPDATE durable_runtime.catalog_repositories SET deleted_at=clock_timestamp() WHERE id=$1', [ws.repoId])
      await tx.query("UPDATE durable_runtime.tabs SET lifecycle='CLOSED',closed_at=clock_timestamp() WHERE workspace_id=(SELECT id FROM durable_runtime.workspaces WHERE public_id=$1)", [created.worktree.id])
    })
    const changed = setup({ ...ws.config, launch: { ...ws.config.launch!, repositories: [] } })
    try {
      assert.deepEqual(JSON.parse(JSON.stringify(await changed.invoke('worktree.create', request))), JSON.parse(JSON.stringify(created)))
      assert.deepEqual(JSON.parse(JSON.stringify(await changed.invoke('session.tabs.createTerminal', terminalRequest))), JSON.parse(JSON.stringify(terminal)))
      await assert.rejects(changed.invoke('worktree.create', { ...request, name: 'different' }), /RECEIPT_PAYLOAD_CONFLICT/)
      await assert.rejects(changed.invoke('session.tabs.createTerminal', { ...terminalRequest, command: 'different' }), /RECEIPT_PAYLOAD_CONFLICT/)
    } finally { changed.adapter.dispose() }
    await assert.rejects(state.invoke('session.tabs.createTerminal', { ...terminalRequest, clientMutationId: `new-terminal:${ws.id}` }), /CATALOG_WORKSPACE_DELETED/)
    assert.deepEqual(state.unexpected, [])
  } finally { state.adapter.dispose() }
})

await test('Git public identity and retained generated-name reservation replay one original result after an actual committed acknowledgement loss', async () => {
  const ws = await fixture('git'), observed = observedPool(true), state = setup(ws.config, observed.borrowed)
  const request = { repo: `id:${ws.repoId}`, nameWasGenerated: true, clientMutationId: `lost-ack:${ws.id}`, baseBranch: 'main' }
  try {
    await assert.rejects(state.invoke('worktree.create', request), /CATALOG_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY/)
    assert.equal(observed.lost(), 1)
    const replayed = await state.invoke('worktree.create', request) as CatalogWireResults['worktree.create']
    assert.ok(replayed.worktree.id.startsWith(`${ws.repoId}::${ws.root}/worktrees/`))
    assert.equal(replayed.worktree.head, ''); assert.equal(replayed.worktree.branch, '')
    const rows = (await pool.query(`SELECT w.public_id,n.normalized_name,n.generated,n.retired
      FROM durable_runtime.workspaces w JOIN durable_runtime.catalog_name_reservations n ON n.workspace_id=w.id
      WHERE n.namespace=$1`, [ws.repoId])).rows
    assert.equal(rows.length, 1); assert.equal(rows[0].public_id, replayed.worktree.id); assert.equal(rows[0].generated, true)
    await pool.query('UPDATE durable_runtime.catalog_name_reservations SET retired=true WHERE namespace=$1', [ws.repoId])
    const next = await state.invoke('worktree.create', { ...request, clientMutationId: `next-name:${ws.id}` }) as CatalogWireResults['worktree.create']
    assert.notEqual(next.worktree.path, replayed.worktree.path)
    assert.deepEqual(await state.invoke('worktree.create', request), replayed)
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM durable_runtime.rpc_receipts WHERE operation_key=$1', [request.clientMutationId])).rows[0].n, 1)
    assert.deepEqual(state.unexpected, [])
  } finally { state.adapter.dispose(); assert.equal(observed.endCalls(), 0) }
})

await test('authenticated scope, real dataset/host guard, mutable invocation/config capture and PG unavailability never fall back to physical runtime', async () => {
  const ws = await fixture(), gate = deferred<void>(), entered = deferred<void>()
  let blocked = false
  const observed = observedPool(false, async () => { if (!blocked) { blocked = true; entered.resolve(); await gate.promise } })
  const config = { ...ws.config, launch: { policy: { ...ws.config.launch!.policy }, repositories: ws.config.launch!.repositories.map(row => ({ ...row,
    storage: { ...row.storage } })) } }
  const state = setup(config, observed.borrowed)
  const params = { repo: `id:${ws.repoId}`, name: 'before-await', startupEnv: { SYNTHETIC_FIELD: 'before' }, clientMutationId: `capture:${ws.id}` }
  try {
    const pending = state.invoke('worktree.create', params)
    await entered.promise
    params.name = 'after-await'; params.startupEnv.SYNTHETIC_FIELD = 'after'
    config.launch.repositories[0].storage.exportId = 'after-await'
    gate.resolve()
    const result = await pending as CatalogWireResults['worktree.create']
    const row = (await stored(result.worktree.id))[0]
    assert.equal(row.launch_request.params.name, 'before-await'); assert.equal(row.launch_request.params.startupEnv.SYNTHETIC_FIELD, 'before')
    assert.equal(row.export_id, 'synthetic-export')
    const outside = setup({ ...ws.config, repositoryIds: [], launch: { ...ws.config.launch!, repositories: [] } })
    const mismatch = setup({ ...ws.config, datasetName: 'synthetic-other-dataset' })
    try {
      await assert.rejects(outside.invoke('worktree.create', { repo: `id:${ws.repoId}`, name: 'outside' }), /CATALOG_REPO_NOT_FOUND/)
      await assert.rejects(mismatch.invoke('worktree.create', { repo: `id:${ws.repoId}`, name: 'dataset' }), /CATALOG_DATASET_MISMATCH/)
    } finally { outside.adapter.dispose(); mismatch.adapter.dispose() }
    let currentHost: DurableCatalogReadConfig['hostId'] = 'local'
    const hostChanged = new DurableCatalogReadAdapter({ ...ws.config, readHostIdentity: (): DurableCatalogReadConfig['hostId'] => currentHost })
    try {
      await assert.rejects(hostChanged.create('worktree.create', { repo: `id:${ws.repoId}` },
        fixtureContext(state.runtime, { authenticatedCallerFingerprint: undefined })), /CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
      currentHost = 'runtime:synthetic-replaced'
      await assert.rejects(hostChanged.create('worktree.create', { repo: `id:${ws.repoId}` }, fixtureContext(state.runtime)), /CATALOG_HOST_MISMATCH/)
    } finally { hostChanged.dispose() }
    const unavailable = setup(ws.config, { connect: async () => { throw Object.assign(new Error('Synthetic PG unavailable'), { code: '08006' }) } } as unknown as Pool)
    try { await assert.rejects(unavailable.invoke('worktree.create', { repo: `id:${ws.repoId}`, name: 'unavailable' }), /08006/) }
    finally { unavailable.adapter.dispose() }
    assert.deepEqual(state.unexpected, [])
  } finally { gate.resolve(); state.adapter.dispose() }
})

await test('concurrent separate Workspaces and Units share exactly one canonical binding without changing its original state or issuing physical rights', async () => {
  const ws = await fixture(), state = setup(ws.config), before = await physicalCounts()
  const canonical = ws.config.launch!.repositories[0].storage
  const bindingRows = async () => (await pool.query(`SELECT to_jsonb(b) AS original FROM durable_runtime.storage_bindings b
    WHERE backend_id=$1 AND export_id=$2 AND canonical_directory=$3`,
  [canonical.backendId, canonical.exportId, canonical.canonicalDirectory])).rows as { original: Record<string, unknown> }[]
  try {
    const [left, right] = await Promise.all([
      state.invoke('worktree.create', { repo: `id:${ws.repoId}`, name: 'canonical-left', clientMutationId: `canonical-left:${ws.id}` }),
      state.invoke('worktree.create', { repo: `id:${ws.repoId}`, name: 'canonical-right', clientMutationId: `canonical-right:${ws.id}` })
    ]) as [CatalogWireResults['worktree.create'], CatalogWireResults['worktree.create']]
    assert.notEqual(left.worktree.id, right.worktree.id)
    const first = (await stored(left.worktree.id))[0], second = (await stored(right.worktree.id))[0]
    assert.notEqual(first.id, second.id); assert.notEqual(first.runtime_unit_id, second.runtime_unit_id)
    assert.notEqual(first.session_id, second.session_id); assert.equal(first.binding_id, second.binding_id)
    const bindings = await bindingRows(); assert.equal(bindings.length, 1)
    const originalBinding = bindings[0].original
    assert.equal(originalBinding.id, first.binding_id); assert.equal(originalBinding.access_state, 'UNVERIFIED')
    assert.equal(originalBinding.identity_proof_ref, null); assert.equal(originalBinding.identity_verified_at, null)
    assert.equal(originalBinding.writer_attempt_id, null); assert.equal(originalBinding.seal_id, null)
    const peers = (await pool.query(`SELECT runtime_unit_id,session_id,storage_binding_id FROM durable_runtime.runtime_members
      WHERE session_id=ANY($1::uuid[]) ORDER BY session_id`, [[first.session_id, second.session_id]])).rows
    assert.equal(peers.length, 2); assert.ok(peers.every(row => row.storage_binding_id === originalBinding.id))
    assert.deepEqual(new Set(peers.map(row => row.runtime_unit_id)), new Set([first.runtime_unit_id, second.runtime_unit_id]))
    // A further fresh Workspace takes the existing exact-tuple branch. Compare
    // the complete original row, including future additive metadata fields.
    const third = await state.invoke('worktree.create', { repo: `id:${ws.repoId}`, name: 'canonical-existing',
      clientMutationId: `canonical-existing:${ws.id}` }) as CatalogWireResults['worktree.create']
    const existing = (await stored(third.worktree.id))[0]
    assert.equal(existing.binding_id, originalBinding.id)
    assert.notEqual(existing.runtime_unit_id, first.runtime_unit_id); assert.notEqual(existing.runtime_unit_id, second.runtime_unit_id)
    assert.deepEqual(await bindingRows(), bindings)
    assert.deepEqual(await physicalCounts(), before); assert.deepEqual(state.unexpected, [])
  } finally { state.adapter.dispose() }
})
