import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { readMigrations } from '../db/migrate.ts'
import { resolveReceipt } from '../db/atomic.ts'
import { registerCatalogProject } from '../catalog/register.ts'
import type { CatalogRegistration } from '../catalog/register.ts'
import { eraseRpcMethods } from '../../runtime/rpc/core.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher.ts'
import { REPO_METHODS } from '../../runtime/rpc/methods/repo.ts'
import { WORKTREE_METHODS } from '../../runtime/rpc/methods/worktree.ts'
import { SESSION_TAB_METHODS } from '../../runtime/rpc/methods/session-tabs.ts'
import { CLIENT_UI_METHODS } from '../../runtime/rpc/methods/client-ui.ts'
import { TERMINAL_METHODS } from '../../runtime/rpc/methods/terminal.ts'
import { projectSessionTabsForClient } from '../../runtime/rpc/methods/session-tabs-inventory.ts'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, type RuntimeCapability } from '../../../shared/protocol-version.ts'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts.ts'
import { DurableCatalogReadAdapter } from './public.ts'
import type { DurableCatalogReadConfig } from './config.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { captureCatalogReadContext } from './context.ts'
import { fixtureConfig, fixtureRuntime, fixtureContext, deferred, eventually } from './fixture-support.mts'

// Written, not executed. Uses an already prepared, separate owned DB only;
// this file never applies migrations, resets rows or touches dev registration.
if (process.env.ORCA_P116_METADATA_APPROVED !== 'root-source-reviewed' ||
  !(process.env.PGDATABASE ?? '').startsWith('orca_p116_metadata_')) { throw new Error('Root review and owned metadata DB required') }
const pool = createDurablePool({ max: 6 })
const original = eraseRpcMethods([...REPO_METHODS, ...WORKTREE_METHODS, ...SESSION_TAB_METHODS, ...CLIENT_UI_METHODS, ...TERMINAL_METHODS])
const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const ui = { lastActiveRepoId: null, lastActiveWorktreeId: null, activeView: 'terminal', sidebarWidth: 240,
  rightSidebarOpen: false, rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files', rightSidebarWidth: 320,
  groupBy: 'none', sortBy: 'smart', projectOrderBy: 'manual', showActiveOnly: false, hideDefaultBranchWorkspace: false,
  filterRepoIds: [], collapsedGroups: [], uiZoomLevel: 0, editorFontZoomLevel: 0, worktreeCardProperties: [],
  statusBarItems: [], statusBarVisible: true, dismissedUpdateVersion: null, lastUpdateCheckAt: null }

async function fixture(host: 'local' | 'runtime:synthetic-foreign' = 'local') {
  const id = randomUUID(), repo = `synthetic-metadata-repo:${id}`, group = `synthetic-metadata-group:${id}`
  const path = `/synthetic/metadata/${id}`, publicId = `${repo}::${path}`, alias = `synthetic-metadata:${id}`
  const terminalTab = randomUUID(), fileTab = randomUUID(), agentTab = randomUUID(), agent = randomUUID(), session = randomUUID(), unit = randomUUID()
  const storage = randomUUID(), backend = `synthetic-metadata-backend:${id}`
  const terminalParent = `synthetic-terminal:${terminalTab}`, leaf = randomUUID(), incarnation = `synthetic-incarnation:${terminalTab}`
  const terminalPublic = `${terminalParent}::${leaf}`, handle = `synthetic-stable-handle:${terminalTab}`
  const config: DurableCatalogReadConfig = { ...fixtureConfig(pool), repositoryIds: [repo], projectGroupIds: [group] }
  const { runtime } = fixtureRuntime()
  const authority = captureCatalogReadContext(captureDurableCatalogReadConfig(config), fixtureContext(runtime)).authority
  await registerCatalogProject(pool, authority, { mutationId: `synthetic-register:${id}`,
    repo: { id: repo, path: `/synthetic/repos/${id}`, displayName: repo, badgeColor: '#ffffff', addedAt: 1,
      projectGroupId: group, kind: 'git', executionHostId: host },
    group: { id: group, name: group, parentPath: null, parentGroupId: null, color: null, isCollapsed: false,
      tabOrder: 0, createdAt: 1, updatedAt: 1, createdFrom: 'manual' }, ui } as CatalogRegistration)
  const git = { path, head: '', branch: `synthetic-${id}`, isBare: false, isMainWorktree: false }
  const payload = { ...git, id: publicId, repoId: repo, displayName: 'Before', comment: '', linkedIssue: null,
    linkedPR: null, linkedLinearIssue: null, isArchived: false, isUnread: false, isPinned: false, sortOrder: 0,
    lastActivityAt: 1234, parentWorktreeId: null, childWorktreeIds: [], lineage: null, git }
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,$3,'READY')", [id, publicId, id])
    await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,repo_id,project_group_id,reserved_path,payload,create_request)
      VALUES($1,'GIT',$2,$3,$4,$5,'{}')`, [id, repo, group, path, JSON.stringify(payload)])
    await tx.query("INSERT INTO durable_runtime.workspace_aliases(alias,workspace_id,origin) VALUES($1,$2,'synthetic-metadata-fixture')", [alias, id])
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'claude')", [agent])
    await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [session, agent, id])
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase,last_work_event_at,idle_due_at) VALUES($1,'SUSPENDED','ABSENT','2026-10-12T00:00:00Z','2026-10-12T01:00:00Z')", [unit])
    await tx.query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,'synthetic-export')", [backend])
    await tx.query(`INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state)
      VALUES($1,$2,'synthetic-export',$3,'UNVERIFIED')`, [storage, backend, `/synthetic/homes/${session}`])
    await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [unit, session, storage])
    // Actual immutable row relationships. The pending handle is logical only;
    // no PTY, attempt, grant or provider proof is issued by this fixture.
    await tx.query(`INSERT INTO durable_runtime.tabs(id,workspace_id,session_id,kind,terminal_handle,leaf_id,ui_order,lifecycle)
      VALUES($1,$2,$3,'terminal',$4,$5,0,'OPEN')`, [terminalTab, id, session, handle, leaf])
    await tx.query(`INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request)
      VALUES($1,$2,$3,'{}')`, [terminalTab, terminalPublic, JSON.stringify({ id: terminalPublic, type: 'terminal',
      parentTabId: terminalParent, leafId: leaf, terminal: null, status: 'pending-handle', incarnationId: incarnation,
      title: 'Before', isActive: false })])
    for (const [tab, kind, tabPayload, order] of [
      [fileTab, 'file', { id: `synthetic-file:${fileTab}`, type: 'file', title: 'File', isActive: true,
        filePath: `${path}/fixture.txt`, relativePath: 'fixture.txt', language: 'plaintext', isDirty: false }, 1],
      [agentTab, 'agent-session', { id: `agent-session:synthetic_${id}`, type: 'agent-session', title: 'Structured',
        sessionId: `synthetic_${id}`, agent: 'claude', isActive: false }, 2]
    ] as const) {
      await tx.query("INSERT INTO durable_runtime.tabs(id,workspace_id,session_id,kind,ui_order,lifecycle) VALUES($1,$2,$3,$4,$5,'OPEN')", [tab, id, session, kind, order])
      await tx.query("INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request) VALUES($1,$2,$3,'{}')", [tab, tabPayload.id, JSON.stringify(tabPayload)])
    }
    await tx.query('INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)', [`workspace:${id}`, randomUUID()])
    await tx.query("UPDATE durable_runtime.catalog_heads SET revision=revision+1 WHERE scope='catalog'")
  })
  return { id, repo, group, publicId, alias, terminalTab, terminalPublic, terminalParent, handle, incarnation,
    filePublic: `synthetic-file:${fileTab}`, agentTab, config, unit, session }
}

type Options = { beforeConnect?: () => Promise<void>; loseMutationCommitAck?: boolean; failQuery?: boolean }
function observedPool(options: Options = {}) {
  const statements: string[] = []
  let commitsLost = 0, poolEnds = 0
  const borrowed = new Proxy(pool, { get(target, key) {
    if (key === 'end') { return () => { poolEnds++; throw new Error('Adapter cannot end borrowed Pool') } }
    if (key === 'connect') { return async () => {
      await options.beforeConnect?.()
      const client = await target.connect(); let receiptWritten = false
      return new Proxy(client, { get(owner, property) {
        if (property === 'query') { return async (...args: unknown[]) => {
          const sql = String(args[0]); statements.push(sql)
          if (options.failQuery) { return owner.query('SELECT * FROM durable_runtime.synthetic_metadata_missing_relation') }
          if (/INSERT INTO durable_runtime.rpc_receipts/i.test(sql)) { receiptWritten = true }
          const result = await (owner.query as (...input: unknown[]) => Promise<unknown>).apply(owner, args)
          if (options.loseMutationCommitAck && receiptWritten && sql === 'COMMIT') {
            commitsLost++; throw Object.assign(new Error('Synthetic lost commit acknowledgement'), { code: '08006' })
          }
          return result
        } }
        const value = Reflect.get(owner, property); return typeof value === 'function' ? value.bind(owner) : value
      } })
    } }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  return { borrowed, statements, commitsLost: () => commitsLost, poolEnds: () => poolEnds }
}
async function counters() {
  return (await pool.query(`SELECT
    (SELECT count(*)::integer FROM durable_runtime.rpc_receipts) AS receipts,
    (SELECT count(*)::integer FROM durable_runtime.runtime_audit_events) AS audits,
    (SELECT count(*)::integer FROM durable_runtime.outbox_events) AS outbox,
    (SELECT count(*)::integer FROM durable_runtime.session_events) AS session_events,
    (SELECT count(*)::integer FROM durable_runtime.attempts) AS attempts,
    (SELECT count(*)::integer FROM durable_runtime.operations) AS operations`)).rows[0] as Record<string, number>
}
async function unchangedActivity(ws: Awaited<ReturnType<typeof fixture>>) {
  return (await pool.query(`SELECT (SELECT to_jsonb(s) FROM durable_runtime.sessions s WHERE id=$1) AS session,
    (SELECT to_jsonb(u) FROM durable_runtime.runtime_units u WHERE id=$2) AS unit,
    (SELECT payload->'lastActivityAt' FROM durable_runtime.catalog_workspace_metadata WHERE workspace_id=$3) AS activity`,
  [ws.session, ws.unit, ws.id])).rows[0]
}
function setup(ws: Awaited<ReturnType<typeof fixture>>, borrowed = pool) {
  const owner = fixtureRuntime(), adapter = new DurableCatalogReadAdapter({ ...ws.config, pool: borrowed })
  const dispatcher = new RpcDispatcher({ runtime: owner.runtime, methods: adapter.bind(original) })
  const options = { authenticatedCallerFingerprint: 'a'.repeat(64), clientKind: 'mobile' as const,
    clientCapabilities: fixtureContext(owner.runtime).clientCapabilities, connectionId: 'synthetic-metadata-connection' }
  const invoke = async (method: string, params?: unknown) => {
    const response = await dispatcher.dispatch({ id: randomUUID(), method, params, authToken: '' }, options)
    assert.equal(response.ok, true, wire(response).ok ? '' : JSON.stringify(response))
    if (!response.ok) { throw new Error('Unreachable failed response') }
    return response.result
  }
  return { ...owner, adapter, dispatcher, options, invoke }
}
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected

await test('public metadata first PG boundaries only; prior suites are not executed', async t => {
  try {
    const source = await readMigrations(fileURLToPath(new URL('../db/migrations/', import.meta.url)))
    assert.equal(source.length, 19)
    assert.deepEqual((await pool.query('SELECT version,checksum FROM durable_runtime.schema_migrations ORDER BY version')).rows,
      source.map(({ version, checksum }) => ({ version, checksum })))

    await t.test('six real unary metadata methods share read/subscribe projection and receipt/audit/outbox without lifecycle activity', async () => {
      const ws = await fixture(), observed = observedPool(), state = setup(ws, observed.borrowed)
      const frames: Record<string, unknown>[] = [], errors: unknown[] = []
      try {
        const before = await counters(), activity = await unchangedActivity(ws)
        await state.adapter.subscribe('session.tabs.subscribe', { worktree: ws.alias }, fixtureContext(state.runtime, {
          requestId: 'synthetic-metadata-subscribe', reportSubscriptionError: error => { errors.push(error) }
        }), frame => frames.push(frame as Record<string, unknown>))
        const changed = await state.invoke('worktree.set', { worktree: ws.alias, displayName: 'After', comment: 'Captured user metadata' }) as { worktree: { displayName: string } }
        assert.equal(changed.worktree.displayName, 'After')
        const activated = await state.invoke('worktree.activate', { worktree: ws.alias }) as { sleepingAgentWake: string }
        assert.equal(activated.sleepingAgentWake, 'not-applicable')
        const updatedUi = await state.invoke('ui.set', { sidebarWidth: 310, hideWorkspacesFromOtherDevices: true,
          browserKagiSessionLink: 'synthetic-private-value-never-persist' }) as { ui: Record<string, unknown> }
        assert.equal(updatedUi.ui.sidebarWidth, 310)
        for (const key of ['hideWorkspacesFromOtherDevices', 'browserKagiSessionLink']) { assert.equal(key in updatedUi.ui, false) }
        const selected = await state.invoke('session.tabs.activate', { worktree: ws.alias, tabId: ws.terminalPublic }) as RuntimeMobileSessionTabsResult
        assert.ok(selected.tabs.every(tab => tab.type !== 'agent-session'))
        const focused = await state.invoke('terminal.focus', { terminal: ws.handle, expectedIncarnationId: ws.incarnation }) as { focus: { handle: string } }
        assert.equal(focused.focus.handle, ws.handle)
        const renamed = await state.invoke('terminal.rename', { terminal: ws.handle, title: 'After terminal', expectedIncarnationId: ws.incarnation }) as { rename: { title: string } }
        assert.equal(renamed.rename.title, 'After terminal')
        const listed = await state.invoke('session.tabs.list', { worktree: ws.alias }) as RuntimeMobileSessionTabsResult
        await eventually(() => frames.some(frame => frame.type === 'updated' && frame.snapshotVersion === listed.snapshotVersion))
        const update = frames.findLast(frame => frame.type === 'updated' && frame.snapshotVersion === listed.snapshotVersion)!
        assert.deepEqual(wire({ ...listed }), wire(Object.fromEntries(Object.entries(update).filter(([key]) => key !== 'type'))))
        assert.equal((await state.invoke('ui.get') as { ui: { sidebarWidth: number } }).ui.sidebarWidth, 310)
        assert.equal((await state.invoke('worktree.show', { worktree: ws.alias }) as { worktree: { displayName: string } }).worktree.displayName, 'After')
        const after = await counters()
        for (const key of ['receipts', 'audits', 'outbox']) { assert.equal(after[key] - before[key], 6) }
        for (const key of ['session_events', 'attempts', 'operations']) { assert.equal(after[key], before[key]) }
        assert.deepEqual(await unchangedActivity(ws), activity)
        const own = (await pool.query('SELECT method,operation_key,response FROM durable_runtime.rpc_receipts WHERE session_scope=$1',
          [`workspace:${ws.id}`])).rows
        assert.equal(own.length, 5); assert.ok(own.every(row => String(row.operation_key).startsWith('legacy:')))
        for (const [method, response] of [['worktree.set', changed], ['worktree.activate', activated],
          ['terminal.focus', focused], ['terminal.rename', renamed]] as const) {
          assert.deepEqual(wire(own.find(row => row.method === method)!.response), wire(response))
        }
        const savedTabs = own.find(row => row.method === 'session.tabs.activate')!.response as RuntimeMobileSessionTabsResult
        assert.deepEqual(wire(projectSessionTabsForClient(savedTabs, state.options.clientKind, state.options.clientCapabilities, false)), wire(selected))
        const savedUi = (await pool.query("SELECT response FROM durable_runtime.rpc_receipts WHERE method='ui.set' ORDER BY committed_at DESC LIMIT 1")).rows[0].response
        assert.deepEqual(wire(savedUi), wire(updatedUi))
        const persistedUi = (await pool.query("SELECT payload FROM durable_runtime.catalog_ui_state WHERE scope='host'")).rows[0].payload
        assert.equal('browserKagiSessionLink' in persistedUi, false); assert.equal('hideWorkspacesFromOtherDevices' in persistedUi, false)
        assert.deepEqual(state.unexpected, []); assert.deepEqual(errors, [])
      } finally { state.adapter.dispose() }
      assert.equal(state.cleanups.size, 0); assert.equal(observed.poolEnds(), 0)
    })

    await t.test('server scope and dataset/host mismatches reject mutations without legacy fallback or receipts', async () => {
      const ws = await fixture(), other = await fixture(), foreign = await fixture('runtime:synthetic-foreign'), state = setup(ws)
      try {
        const before = await counters()
        for (const [method, params] of [['worktree.set', { worktree: other.alias, comment: 'Denied' }],
          ['terminal.rename', { terminal: other.handle, title: 'Denied' }]] as const) {
          const response = await state.dispatcher.dispatch({ id: randomUUID(), authToken: '', method, params }, state.options)
          assert.equal(response.ok, false)
        }
        const wrongDataset = new DurableCatalogReadAdapter({ ...ws.config, datasetName: 'synthetic-wrong-dataset' })
        const foreignHost = new DurableCatalogReadAdapter(foreign.config)
        try {
          await assert.rejects(wrongDataset.mutate('ui.set', { sidebarWidth: 311 }, fixtureContext(state.runtime)), code('CATALOG_DATASET_MISMATCH'))
          await assert.rejects(foreignHost.mutate('ui.set', { sidebarWidth: 312 }, fixtureContext(state.runtime)), code('CATALOG_REGISTRATION_HOST_MISMATCH'))
        } finally { wrongDataset.dispose(); foreignHost.dispose() }
        assert.deepEqual(await counters(), before); assert.deepEqual(state.unexpected, [])
      } finally { state.adapter.dispose() }
    })

    await t.test('params/caller/capabilities/client kind and original host receiver are captured before checkout', async () => {
      const ws = await fixture(), entered = deferred<void>(), gate = deferred<void>(); let blocked = true
      const observed = observedPool({ beforeConnect: async () => { if (blocked) { entered.resolve(); await gate.promise } } })
      const owner = fixtureRuntime(), allowed = [ws.repo]
      const input = { ...ws.config, pool: observed.borrowed, repositoryIds: allowed,
        readHostIdentity(): DurableCatalogReadConfig['hostId'] { assert.equal(this.hostId, 'local'); return this.hostId } }
      const adapter = new DurableCatalogReadAdapter(input)
      const capabilities: RuntimeCapability[] = [], context: RpcContext = fixtureContext(owner.runtime, { clientCapabilities: capabilities })
      const params = { worktree: ws.alias, tabId: ws.terminalPublic }
      try {
        const pending = adapter.mutate('session.tabs.activate', params, context)
        await entered.promise
        params.worktree = 'synthetic-foreign'; params.tabId = 'synthetic-foreign'
        capabilities.push(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY); context.clientKind = undefined
        context.authenticatedCallerFingerprint = 'b'.repeat(64); allowed.length = 0
        input.readHostIdentity = () => 'runtime:synthetic-replaced'
        const settings = owner.runtime.getClientSettings.bind(owner.runtime)
        owner.runtime.getClientSettings = () => ({ ...settings(), experimentalStructuredNativeChat: true })
        blocked = false; gate.resolve()
        const response = await pending as RuntimeMobileSessionTabsResult
        assert.equal(response.worktree, ws.publicId); assert.ok(response.tabs.every(tab => tab.type !== 'agent-session'))
        const receipt = (await pool.query('SELECT principal_id FROM durable_runtime.rpc_receipts WHERE session_scope=$1', [`workspace:${ws.id}`])).rows[0]
        assert.equal(receipt.principal_id, JSON.stringify(['catalog-host-fingerprint-v1', ws.config.datasetName, 'local', 'a'.repeat(64)]))
        assert.deepEqual(owner.unexpected, [])
      } finally { blocked = false; gate.resolve(); adapter.dispose() }
    })

    await t.test('closed Tab and stale incarnation reject new mutation; immutable terminal identity is retained', async () => {
      const ws = await fixture(), state = setup(ws)
      try {
        await assert.rejects(state.adapter.mutate('terminal.focus', { terminal: ws.handle, expectedIncarnationId: 'synthetic-stale' }, fixtureContext(state.runtime)), code('CATALOG_STALE_TERMINAL'))
        const before = await counters()
        await pool.query("UPDATE durable_runtime.tabs SET lifecycle='CLOSED',closed_at=clock_timestamp(),revision=revision+1 WHERE id=$1", [ws.terminalTab])
        await assert.rejects(state.adapter.mutate('terminal.rename', { terminal: ws.handle, title: 'Rejected' }, fixtureContext(state.runtime)), code('CATALOG_TAB_CLOSED'))
        assert.equal((await pool.query('SELECT terminal_handle FROM durable_runtime.tabs WHERE id=$1', [ws.terminalTab])).rows[0].terminal_handle, ws.handle)
        assert.deepEqual(await counters(), before)
      } finally { state.adapter.dispose() }
    })

    await t.test('actual PG failure stays an error; observed COMMIT loss is UNCERTAIN with one retained legacy key', async () => {
      const ws = await fixture(), broken = observedPool({ failQuery: true }), uncertain = observedPool({ loseMutationCommitAck: true })
      const state = setup(ws), failing = new DurableCatalogReadAdapter({ ...ws.config, pool: broken.borrowed }), lost = new DurableCatalogReadAdapter({ ...ws.config, pool: uncertain.borrowed })
      try {
        const before = await counters()
        await assert.rejects(failing.mutate('ui.set', { sidebarWidth: 340 }, fixtureContext(state.runtime)))
        assert.deepEqual(await counters(), before)
        await assert.rejects(lost.mutate('worktree.set', { worktree: ws.alias, comment: 'Committed once' }, fixtureContext(state.runtime)), code('CATALOG_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY'))
        assert.equal(uncertain.commitsLost(), 1)
        const rows = (await pool.query('SELECT principal_id,session_scope,method,operation_key,payload_hash FROM durable_runtime.rpc_receipts WHERE session_scope=$1', [`workspace:${ws.id}`])).rows
        assert.equal(rows.length, 1); const row = rows[0]; assert.match(row.operation_key, /^legacy:/)
        const resolved = await resolveReceipt(pool, { key: { principalId: row.principal_id, sessionScope: row.session_scope, method: row.method, operationKey: row.operation_key }, payloadHash: row.payload_hash })
        assert.equal(resolved.status, 'FOUND'); assert.equal((await counters()).receipts - before.receipts, 1)
        assert.equal(uncertain.statements.filter(sql => /INSERT INTO durable_runtime.rpc_receipts/i.test(sql)).length, 1)
        assert.deepEqual(state.unexpected, [])
      } finally { failing.dispose(); lost.dispose(); state.adapter.dispose() }
    })
  } finally { await pool.end() }
})
