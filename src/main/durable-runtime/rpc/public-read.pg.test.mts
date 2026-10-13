import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { readMigrations, applyMigrations } from '../db/migrate.ts'
import { registerCatalogProject } from '../catalog/register.ts'
import type { CatalogAuthority } from '../catalog/authority.ts'
import type { CatalogRegistration } from '../catalog/register.ts'
import { pairedDeviceAttachmentPrincipal } from '../attachments/types.ts'
import { DurableCatalogReadAdapter } from './public.ts'
import type { DurableCatalogReadConfig } from './config.ts'
import { CatalogReadError } from './config.ts'
import { deferred, eventually, fixtureConfig, fixtureRuntime, fixtureContext } from './fixture-support.mts'

// Owned validation DB only. This file has not been executed. Never applies 014 to dev.
if (process.env.ORCA_P116_PUBLIC_READ_APPROVED !== 'root-ready' ||
  !(process.env.PGDATABASE ?? '').startsWith('orca_p116_read_')) { throw new Error('Root Ready handoff and owned public-read DB required') }
const pool = createDurablePool({ max: 6 })
const transaction = <T>(body: (client: { query: PoolClient['query'] }) => Promise<T>) =>
  withDurableTransaction(pool, tx => body(tx as unknown as { query: PoolClient['query'] }))
const owner = pairedDeviceAttachmentPrincipal(randomUUID())
const ui = { lastActiveRepoId: null, lastActiveWorktreeId: null, activeView: 'terminal', sidebarWidth: 240,
  rightSidebarOpen: false, rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files', rightSidebarWidth: 320,
  groupBy: 'none', sortBy: 'smart', projectOrderBy: 'manual', showActiveOnly: false, hideDefaultBranchWorkspace: false,
  filterRepoIds: [], collapsedGroups: [], uiZoomLevel: 0, editorFontZoomLevel: 0, worktreeCardProperties: [],
  statusBarItems: [], statusBarVisible: true, dismissedUpdateVersion: null, lastUpdateCheckAt: null }
async function registration(host: 'local' | 'runtime:synthetic-other' = 'local') {
  const repo = `synthetic-read-repo:${randomUUID()}`, group = `synthetic-read-group:${randomUUID()}`
  const authority = { principalId: owner, repositoryIds: [repo], projectGroupIds: [group], workspacePublicIds: [] } as unknown as CatalogAuthority
  await registerCatalogProject(pool, authority, { mutationId: `synthetic-register:${randomUUID()}`,
    repo: { id: repo, path: `/synthetic/public-read/${repo}`, displayName: repo, badgeColor: '#ffffff', addedAt: 1,
      kind: 'git', projectGroupId: group, executionHostId: host },
    group: { id: group, name: group, parentPath: null, parentGroupId: null, color: null, isCollapsed: false,
      tabOrder: 0, createdAt: 1, updatedAt: 1, createdFrom: 'manual' }, ui } as CatalogRegistration)
  return { repo, group }
}
async function workspace(reg: { repo: string; group: string }) {
  const id = randomUUID(), path = `/synthetic/public-read/workspaces/${id}`, publicId = `${reg.repo}::${path}`
  const alias = `synthetic-read-alias:${id}`, tab = randomUUID()
  const git = { path, head: '', branch: `synthetic-${id}`, isBare: false, isMainWorktree: false }
  const payload = { ...git, id: publicId, repoId: reg.repo, displayName: 'Synthetic read label', comment: '',
    linkedIssue: null, linkedPR: null, linkedLinearIssue: null, isArchived: false, isUnread: false, isPinned: false,
    sortOrder: 0, lastActivityAt: 0, parentWorktreeId: null, childWorktreeIds: [], lineage: null, git }
  // Minimal synthetic metadata in the owned DB: no provider, Unit or writer proof.
  await transaction(async tx => {
    await tx.query(`INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,$3,'RESERVED')`, [id, publicId, id])
    await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,repo_id,project_group_id,reserved_path,payload,create_request)
      VALUES($1,'GIT',$2,$3,$4,$5,'{}')`, [id, reg.repo, reg.group, path, JSON.stringify(payload)])
    await tx.query(`INSERT INTO durable_runtime.workspace_aliases(alias,workspace_id,origin) VALUES($1,$2,'synthetic-public-read-fixture')`, [alias, id])
    await tx.query(`INSERT INTO durable_runtime.tabs(id,workspace_id,kind,ui_order,lifecycle) VALUES($1,$2,'file',0,'OPEN')`, [tab, id])
    await tx.query(`INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request) VALUES($1,$2,$3,'{}')`,
      [tab, `synthetic-file:${tab}`, JSON.stringify({ id: `synthetic-file:${tab}`, type: 'file', title: 'Before', isActive: true,
        filePath: `${path}/fixture.txt`, relativePath: 'fixture.txt', language: 'plaintext', isDirty: false })])
    await tx.query(`INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)`, [`workspace:${id}`, randomUUID()])
    await tx.query(`UPDATE durable_runtime.catalog_heads SET revision=revision+1 WHERE scope='catalog'`)
  })
  return { id, publicId, alias, tab }
}
async function updateTab(ws: Awaited<ReturnType<typeof workspace>>) {
  await transaction(async tx => {
    await tx.query(`UPDATE durable_runtime.catalog_tab_metadata SET payload=jsonb_set(payload,'{title}','"After"') WHERE tab_id=$1`, [ws.tab])
    await tx.query(`UPDATE durable_runtime.catalog_heads SET revision=revision+1 WHERE scope IN ('catalog',$1)`, [`workspace:${ws.id}`])
  })
}
function config(reg: { repo: string; group: string }, borrowed = pool): DurableCatalogReadConfig {
  return { ...fixtureConfig(borrowed), repositoryIds: [reg.repo], projectGroupIds: [reg.group] }
}
type Frame = { type: string; snapshots?: unknown[]; removed?: true; tabs?: { title: string }[]; [key: string]: unknown }
function streamContext(runtime: ReturnType<typeof fixtureRuntime>['runtime'], request: string, errors: unknown[], signal?: AbortSignal, connection = 'synthetic-connection') {
  return fixtureContext(runtime, { requestId: request, connectionId: connection, signal, reportSubscriptionError: error => { errors.push(error) } })
}
function observedPool(options: { connect?: () => Promise<void>; pollFailure?: () => boolean } = {}) {
  const reads: string[] = []; let polls = 0
  const borrowed = new Proxy(pool, { get(target, key) {
    if (key === 'query') { return async (...args: unknown[]) => {
      polls++
      reads.push(String(args[0]))
      if (options.pollFailure?.()) { return target.query('SELECT * FROM durable_runtime.synthetic_public_read_missing_relation') }
      return (target.query as (...values: unknown[]) => Promise<unknown>).apply(target, args)
    } }
    if (key === 'connect') { return async () => {
      await options.connect?.()
      const client = await target.connect()
      return new Proxy(client, { get(original, property) {
        if (property === 'query') { return (...args: unknown[]) => {
          reads.push(String(args[0])); return (original.query as (...values: unknown[]) => Promise<unknown>).apply(original, args)
        } }
        const value = Reflect.get(original, property)
        return typeof value === 'function' ? value.bind(original) : value
      } })
    } }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return { borrowed, reads, polls: () => polls }
}
function assertReadOnly(statements: readonly string[]) {
  for (const sql of statements) { assert.match(sql.trim(), /^(SELECT\b|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$|COMMIT$|ROLLBACK$)/i) }
}
const code = (expected: string) => (error: unknown) => error instanceof CatalogReadError && error.code === expected

await test('new public-read PG composition boundaries; no prior Catalog/P115 suite', async t => {
  try {
    const migrations = (await readMigrations(fileURLToPath(new URL('../db/migrations/', import.meta.url)))).filter(row => Number(row.version.slice(0, 3)) <= 14)
    assert.equal(migrations.length, 14); assert.ok(migrations[13].version.startsWith('014-'))
    assert.equal((await pool.query("SELECT to_regnamespace('durable_runtime') AS existing")).rows[0].existing, null)
    await applyMigrations(pool, migrations)
    const first = await registration(), other = await registration(), foreign = await registration('runtime:synthetic-other')
    const initial = await workspace(first), otherWs = await workspace(other)

    await t.test('list and subscribe return the same PG revision/projector; read-only and old runtime calls remain zero', async () => {
      const observed = observedPool(), { runtime, unexpected, cleanups } = fixtureRuntime()
      const adapter = new DurableCatalogReadAdapter(config(first, observed.borrowed)), errors: unknown[] = [], frames: Frame[] = []
      const before = (await pool.query('SELECT * FROM durable_runtime.catalog_heads ORDER BY scope')).rows
      try {
        const listed = await adapter.read('session.tabs.listAll', undefined, fixtureContext(runtime))
        await adapter.subscribe('session.tabs.subscribeAll', undefined, streamContext(runtime, 'equivalent', errors), frame => frames.push(frame as Frame))
        assert.deepEqual({ snapshots: frames[0].snapshots, authoritative: frames[0].authoritative }, listed)
        assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.catalog_heads ORDER BY scope')).rows, before)
        assertReadOnly(observed.reads); assert.deepEqual(unexpected, []); assert.deepEqual(errors, [])
      } finally { adapter.dispose() }
      assert.equal(cleanups.size, 0)
    })

    await t.test('server namespace limits rows and resolves no foreign selector; creator principal is not a new ACL', async () => {
      const { runtime } = fixtureRuntime(), adapter = new DurableCatalogReadAdapter(config(first))
      try {
        const result = await adapter.read('worktree.list', {}, fixtureContext(runtime)) as { worktrees: { id: string }[] }
        assert.deepEqual(result.worktrees.map(row => row.id), [initial.publicId])
        const anotherCaller = fixtureContext(runtime, { authenticatedCallerFingerprint: 'b'.repeat(64) })
        assert.deepEqual(await adapter.read('worktree.list', {}, anotherCaller), result)
        await assert.rejects(adapter.read('worktree.show', { worktree: otherWs.alias }, fixtureContext(runtime)))
      } finally { adapter.dispose() }
    })

    await t.test('wrong dataset and foreign registration host are errors rather than empty inventories', async () => {
      const { runtime } = fixtureRuntime()
      for (const [input, expected] of [
        [{ ...config(first), datasetName: 'synthetic-other-dataset' }, 'CATALOG_DATASET_MISMATCH'],
        [config(foreign), 'CATALOG_REGISTRATION_HOST_MISMATCH']
      ] as const) {
        const adapter = new DurableCatalogReadAdapter(input)
        try { await assert.rejects(adapter.read('repo.list', undefined, fixtureContext(runtime)), code(expected)) }
        finally { adapter.dispose() }
      }
    })

    await t.test('unconfirmed missing selector fails without snapshot, removed frame or leaked cleanup', async () => {
      const { runtime, cleanups } = fixtureRuntime(), adapter = new DurableCatalogReadAdapter(config(first))
      const frames: Frame[] = [], errors: unknown[] = []
      try {
        await assert.rejects(adapter.subscribe('session.tabs.subscribe', { worktree: `id:synthetic-missing:${randomUUID()}` },
          streamContext(runtime, 'unconfirmed-missing', errors), frame => frames.push(frame as Frame)))
        assert.deepEqual(frames, []); assert.deepEqual(errors, []); assert.equal(cleanups.size, 0)
      } finally { adapter.dispose() }
    })

    await t.test('caller target/fingerprint/capabilities and original config method survive a delayed Pool checkout', async () => {
      const gate = deferred<void>(), entered = deferred<void>(); let held = false
      const observed = observedPool({ connect: async () => { if (!held) { held = true; entered.resolve(); await gate.promise } } })
      const { runtime } = fixtureRuntime(), input = config(first, observed.borrowed), adapter = new DurableCatalogReadAdapter(input)
      const params = { worktree: initial.alias }, context = fixtureContext(runtime)
      try {
        const pending = adapter.read('session.tabs.list', params, context)
        await entered.promise
        params.worktree = otherWs.alias; context.authenticatedCallerFingerprint = 'b'.repeat(64); context.clientCapabilities = []
        const mutable = input as { -readonly [Key in keyof DurableCatalogReadConfig]: DurableCatalogReadConfig[Key] }
        mutable.readHostIdentity = () => 'runtime:synthetic-other'; mutable.repositoryIds = [other.repo]; mutable.projectGroupIds = [other.group]
        gate.resolve()
        const result = await pending as { worktree: string }
        assert.equal(result.worktree, initial.publicId); assertReadOnly(observed.reads)
      } finally { gate.resolve(); adapter.dispose() }
    })

    await t.test('alias subscription keeps original UUID after alias reassignment', async () => {
      const ws = await workspace(first), replacement = await workspace(first), { runtime } = fixtureRuntime()
      const adapter = new DurableCatalogReadAdapter(config(first)), errors: unknown[] = [], frames: Frame[] = []
      try {
        await adapter.subscribe('session.tabs.subscribe', { worktree: ws.alias }, streamContext(runtime, 'stable-alias', errors), frame => frames.push(frame as Frame))
        await transaction(async tx => { await tx.query('UPDATE durable_runtime.workspace_aliases SET workspace_id=$1 WHERE alias=$2', [replacement.id, ws.alias]) })
        await updateTab(ws)
        await eventually(() => frames.some(frame => frame.type === 'updated'))
        assert.ok(frames.every(frame => frame.type === 'end' || frame.worktree === ws.publicId))
        assert.deepEqual(errors, [])
      } finally { adapter.dispose() }
    })

    await t.test('listener is present before the initial PG checkout and a raced publication is re-read', async () => {
      const ws = await workspace(first), gate = deferred<void>(), entered = deferred<void>(); let held = false
      const observed = observedPool({ connect: async () => { if (!held) { held = true; entered.resolve(); await gate.promise } } })
      const { runtime } = fixtureRuntime(), adapter = new DurableCatalogReadAdapter(config(first, observed.borrowed))
      const frames: Frame[] = [], errors: unknown[] = []
      try {
        const pending = adapter.subscribe('session.tabs.subscribeAll', undefined, streamContext(runtime, 'initial-race', errors), frame => frames.push(frame as Frame))
        await entered.promise; await updateTab(ws); gate.resolve(); await pending
        const listed = await adapter.read('session.tabs.listAll', undefined, fixtureContext(runtime)) as { snapshots: unknown[] }
        assert.deepEqual(frames[0].snapshots, listed.snapshots); assert.deepEqual(errors, [])
      } finally { gate.resolve(); adapter.dispose() }
    })

    await t.test('disconnect during initial PG await removes listener immediately; late result emits zero', async () => {
      const gate = deferred<void>(), entered = deferred<void>(); let held = false
      const observed = observedPool({ connect: async () => { if (!held) { held = true; entered.resolve(); await gate.promise } } })
      const { runtime, cleanups } = fixtureRuntime(), adapter = new DurableCatalogReadAdapter(config(first, observed.borrowed))
      const abort = new AbortController(), frames: Frame[] = [], errors: unknown[] = []
      try {
        const pending = adapter.subscribe('session.tabs.subscribeAll', undefined, streamContext(runtime, 'disconnect-race', errors, abort.signal), frame => frames.push(frame as Frame))
        await entered.promise; abort.abort()
        const polls = observed.polls()
        await new Promise(resolve => setTimeout(resolve, 40))
        assert.equal(observed.polls(), polls); assert.equal(cleanups.size, 0)
        gate.resolve(); await pending
        assert.deepEqual(frames, []); assert.deepEqual(errors, [])
        const afterInitial = new AbortController()
        await adapter.subscribe('session.tabs.subscribeAll', undefined, streamContext(runtime, 'disconnect-live', errors, afterInitial.signal), frame => frames.push(frame as Frame))
        assert.equal(frames.length, 1)
        afterInitial.abort(); await updateTab(initial)
        await new Promise(resolve => setTimeout(resolve, 40))
        assert.equal(frames.length, 1); assert.equal(cleanups.size, 0)
      } finally { gate.resolve(); adapter.dispose() }
    })

    await t.test('unsubscribe respects connection/request and original single versus all scope', async () => {
      const { runtime, cleanups } = fixtureRuntime(), adapter = new DurableCatalogReadAdapter(config(first))
      const errors: unknown[] = [], framesA: Frame[] = [], framesB: Frame[] = [], framesSingle: Frame[] = []
      try {
        await adapter.subscribe('session.tabs.subscribeAll', undefined, streamContext(runtime, 'all-a', errors), frame => framesA.push(frame as Frame))
        await adapter.subscribe('session.tabs.subscribeAll', undefined, streamContext(runtime, 'all-b', errors, undefined, 'other-connection'), frame => framesB.push(frame as Frame))
        await adapter.subscribe('session.tabs.subscribe', { worktree: initial.alias }, streamContext(runtime, 'single-a', errors), frame => framesSingle.push(frame as Frame))
        await adapter.unsubscribe('session.tabs.unsubscribeAll', { subscriptionId: 'all-a' }, fixtureContext(runtime))
        assert.equal(framesA.at(-1)?.type, 'end'); assert.notEqual(framesB.at(-1)?.type, 'end'); assert.notEqual(framesSingle.at(-1)?.type, 'end')
        assert.equal(cleanups.size, 2)
        await adapter.unsubscribe('session.tabs.unsubscribe', { worktree: initial.alias, subscriptionId: 'single-a' }, fixtureContext(runtime))
        assert.equal(framesSingle.at(-1)?.type, 'end'); assert.equal(cleanups.size, 1); assert.deepEqual(errors, [])
      } finally { adapter.dispose() }
    })

    await t.test('actual PG head query error produces failure and end without empty or deletion frames', async () => {
      let fail = false
      const observed = observedPool({ pollFailure: () => fail }), { runtime, cleanups } = fixtureRuntime()
      const adapter = new DurableCatalogReadAdapter(config(first, observed.borrowed)), frames: Frame[] = [], errors: unknown[] = []
      try {
        await adapter.subscribe('session.tabs.subscribeAll', undefined, streamContext(runtime, 'db-error', errors), frame => frames.push(frame as Frame))
        fail = true
        await eventually(() => errors.length === 1)
        assert.equal(frames.at(-1)?.type, 'end'); assert.equal(cleanups.size, 0)
        assert.equal(frames.filter(frame => frame.type === 'snapshots').length, 1)
        assert.ok(frames.every(frame => frame.removed !== true))
        assert.ok(errors[0] instanceof CatalogReadError); assert.ok(!(errors[0] as Error).message.includes('synthetic_public_read_missing_relation'))
      } finally { adapter.dispose() }
    })

    await t.test('only confirmed original workspace tombstone produces removed and stream end', async () => {
      const ws = await workspace(first), { runtime } = fixtureRuntime(), adapter = new DurableCatalogReadAdapter(config(first))
      const frames: Frame[] = [], errors: unknown[] = []
      try {
        await adapter.subscribe('session.tabs.subscribe', { worktree: ws.alias }, streamContext(runtime, 'confirmed-delete', errors), frame => frames.push(frame as Frame))
        await transaction(async tx => {
          await tx.query('UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp(),revision=revision+1 WHERE id=$1', [ws.id])
          await tx.query(`UPDATE durable_runtime.catalog_heads SET revision=revision+1 WHERE scope IN ('catalog',$1)`, [`workspace:${ws.id}`])
        })
        await eventually(() => frames.some(frame => frame.removed === true))
        assert.equal(frames.at(-1)?.type, 'end'); assert.equal(frames.find(frame => frame.removed)?.worktree, ws.publicId)
        assert.deepEqual(errors, [])
      } finally { adapter.dispose() }
    })
  } finally { await pool.end() }
})
