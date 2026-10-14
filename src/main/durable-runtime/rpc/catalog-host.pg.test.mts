import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { registerCatalogProject, type CatalogRegistration } from '../catalog/register.ts'
import { readCatalogSnapshot } from '../catalog/read.ts'
import { captureCatalogReadContext } from './context.ts'
import { captureDurableCatalogReadConfig, CatalogReadError } from './config.ts'
import { DurableCatalogReadAdapter } from './public.ts'
import { deferred, fixtureConfig, fixtureContext, fixtureRuntime } from './fixture-support.mts'

// Source only. Root supplies SQL001–019 in this exact isolated DB; no DDL/reset/delete here.
if (process.env.ORCA_CATALOG_HOST_APPROVED !== 'root-source-reviewed' ||
    process.env.PGDATABASE !== 'orca_catalog_host_20261014') {
  throw new Error('Root source review and the exact isolated Catalog host database are required')
}
const ui = { lastActiveRepoId: null, lastActiveWorktreeId: null, activeView: 'terminal', sidebarWidth: 240,
  rightSidebarOpen: false, rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files', rightSidebarWidth: 320,
  groupBy: 'none', sortBy: 'smart', projectOrderBy: 'manual', showActiveOnly: false, hideDefaultBranchWorkspace: false,
  filterRepoIds: [], collapsedGroups: [], uiZoomLevel: 0, editorFontZoomLevel: 0, worktreeCardProperties: [],
  statusBarItems: [], statusBarVisible: true, dismissedUpdateVersion: null, lastUpdateCheckAt: null }
type Frame = { type: string; worktree?: string; removed?: true; snapshots?: unknown[] }
type ReadTransaction = { statements: string[]; released: number; actualRepoRows: Record<string, unknown>[] }
function observedPool(pool: Pool) {
  const transactions: ReadTransaction[] = [], polls: string[] = []
  const borrowed = new Proxy(pool, { get(target, key) {
    if (key === 'query') { return (...args: unknown[]) => {
      polls.push(String(args[0]))
      return (target.query as (...values: unknown[]) => Promise<unknown>).apply(target, args)
    } }
    if (key === 'connect') { return async () => {
      const client = await target.connect(), record: ReadTransaction = { statements: [], released: 0, actualRepoRows: [] }
      transactions.push(record)
      return new Proxy(client, { get(original, property) {
        if (property === 'query') { return async (sql: string, values?: unknown[]) => {
          record.statements.push(sql)
          const result = await original.query(sql, values)
          if (sql === 'SELECT id,payload FROM durable_runtime.catalog_repositories WHERE id=$1') {
            record.actualRepoRows.push(...result.rows)
          }
          return result
        } }
        if (property === 'release') { return (...args: Parameters<typeof client.release>) => {
          record.released++; return original.release(...args)
        } }
        const value = Reflect.get(original, property)
        return typeof value === 'function' ? value.bind(original) : value
      } })
    } }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return { borrowed, transactions, polls }
}
const mismatch = (error: unknown) => error instanceof CatalogReadError && error.code === 'CATALOG_REGISTRATION_HOST_MISMATCH'

test('Catalog host PG1: actual read/subscribe and deleted-repo tombstone authority', { timeout: 15000 }, async t => {
  const pool = createDurablePool({ max: 4, application_name: 'orca-catalog-host-first' })
  t.after(async () => { await pool.end() })
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'orca_catalog_host_20261014')
  assert.equal((await pool.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id, '7696101282789175327')
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 19, 'Root supplies SQL001–019; the callback does not migrate')
  const owner = fixtureRuntime(), observation = observedPool(pool)
  const adapters: DurableCatalogReadAdapter[] = []
  t.after(() => { for (const adapter of adapters) { adapter.dispose() } })
  const config = (repoId: string) => ({ ...fixtureConfig(observation.borrowed), repositoryIds: [repoId] })
  async function register(legacyRemote: boolean) {
    const repoId = `synthetic-host:${randomUUID()}`, input = config(repoId)
    const authority = captureCatalogReadContext(captureDurableCatalogReadConfig(input), fixtureContext(owner.runtime)).authority
    await registerCatalogProject(pool, authority, { mutationId: `host-register:${randomUUID()}`, group: null, ui,
      repo: { id: repoId, path: `/synthetic/catalog-host/${repoId}`, displayName: 'Synthetic host repo',
        badgeColor: '#ffffff', addedAt: 1, kind: 'git', ...(legacyRemote ? { connectionId: 'synthetic remote' } : {}) }
    } as CatalogRegistration)
    const adapter = new DurableCatalogReadAdapter(input); adapters.push(adapter)
    return { repoId, authority, adapter }
  }
  async function seedWorkspace(repoId: string) {
    const id = randomUUID(), path = `/synthetic/catalog-host/workspace/${id}`, publicId = `${repoId}::${path}`
    const git = { path, head: '', branch: 'synthetic', isBare: false, isMainWorktree: false }
    const payload = { ...git, id: publicId, repoId, displayName: 'Synthetic tombstone', comment: '', linkedIssue: null,
      linkedPR: null, linkedLinearIssue: null, isArchived: false, isUnread: false, isPinned: false, sortOrder: 0,
      lastActivityAt: 0, parentWorktreeId: null, childWorktreeIds: [], lineage: null, git }
    await withDurableTransaction(pool, async tx => {
      await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,$3,'RESERVED')", [id, publicId, id])
      await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,repo_id,reserved_path,payload,create_request)
        VALUES($1,'GIT',$2,$3,$4,'{}')`, [id, repoId, path, JSON.stringify(payload)])
      await tx.query('INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)', [`workspace:${id}`, randomUUID()])
      await tx.query("UPDATE durable_runtime.catalog_heads SET revision=revision+1 WHERE scope='catalog'")
    })
    return { id, publicId }
  }
  async function tombstone(workspace: Awaited<ReturnType<typeof seedWorkspace>>) {
    await withDurableTransaction(pool, async tx => {
      await tx.query('UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp(),revision=revision+1 WHERE id=$1', [workspace.id])
      await tx.query("UPDATE durable_runtime.catalog_heads SET revision=revision+1 WHERE scope IN ('catalog',$1)", [`workspace:${workspace.id}`])
    })
  }

  const activeRemote = await register(true), rejectedFrames: Frame[] = [], rejectedErrors: unknown[] = []
  await assert.rejects(activeRemote.adapter.read('repo.list', undefined, fixtureContext(owner.runtime)), mismatch)
  await assert.rejects(activeRemote.adapter.subscribe('session.tabs.subscribeAll', undefined,
    fixtureContext(owner.runtime, { requestId: randomUUID(), reportSubscriptionError: error => { rejectedErrors.push(error) } }),
    frame => rejectedFrames.push(frame as Frame)), mismatch)
  assert.deepEqual(rejectedFrames, []); assert.deepEqual(rejectedErrors, []); assert.equal(owner.cleanups.size, 0)
  activeRemote.adapter.dispose()

  const local = await register(false), localWorkspace = await seedWorkspace(local.repoId)
  const localList = await local.adapter.read('worktree.list', {}, fixtureContext(owner.runtime)) as { worktrees: { id: string }[] }
  assert.deepEqual(localList.worktrees.map(row => row.id), [localWorkspace.publicId])
  const localFrames: Frame[] = [], localErrors: unknown[] = [], localEnded = deferred<void>()
  await local.adapter.subscribe('session.tabs.subscribe', { worktree: `id:${localWorkspace.publicId}` },
    fixtureContext(owner.runtime, { requestId: randomUUID(), reportSubscriptionError: error => { localErrors.push(error) } }), frame => {
      localFrames.push(frame as Frame)
      if ((frame as Frame).type === 'end') { localEnded.resolve() }
    })
  assert.equal(localFrames[0].type, 'snapshot')
  await tombstone(localWorkspace); await localEnded.promise
  assert.equal(localFrames.filter(frame => frame.removed).length, 1)
  assert.equal(localFrames.find(frame => frame.removed)?.worktree, localWorkspace.publicId)
  assert.deepEqual(localErrors, []); assert.equal(owner.cleanups.size, 0)
  local.adapter.dispose()

  const deletedRemote = await register(true), remoteWorkspace = await seedWorkspace(deletedRemote.repoId)
  // Deterministic ordering: the repo is absent before BOTH initial snapshots,
  // while the Workspace still exists. Then await the actual adapter's snapshot
  // and prior-map installation before publishing the Workspace tombstone.
  // No timer race, synthetic snapshot, scheduler override or private-method call.
  await withDurableTransaction(pool, async tx => {
    await tx.query('UPDATE durable_runtime.catalog_repositories SET deleted_at=clock_timestamp(),revision=revision+1 WHERE id=$1', [deletedRemote.repoId])
    await tx.query("UPDATE durable_runtime.catalog_heads SET revision=revision+1 WHERE scope='catalog'")
  })
  const initial = await readCatalogSnapshot(pool, deletedRemote.authority)
  assert.deepEqual(initial.repositories, [])
  assert.deepEqual(initial.workspaces.map(row => row.workspace_id), [remoteWorkspace.id])
  const frames: Frame[] = [], errors: unknown[] = [], failed = deferred<void>()
  await deletedRemote.adapter.subscribe('session.tabs.subscribe', { worktree: `id:${remoteWorkspace.publicId}` },
    fixtureContext(owner.runtime, { requestId: randomUUID(), reportSubscriptionError: error => {
      errors.push(error); failed.resolve()
    } }), frame => frames.push(frame as Frame))
  assert.equal(frames.length, 1); assert.equal(frames[0].type, 'snapshot')
  assert.equal(frames[0].worktree, remoteWorkspace.publicId)
  const repoChecksBefore = observation.transactions.filter(row => row.actualRepoRows.some(repo => repo.id === deletedRemote.repoId)).length
  await tombstone(remoteWorkspace); await failed.promise
  // The incumbent RR helper sanitizes CatalogReadError raised inside its body
  // to DB_FAILURE. Preserve that public error boundary rather than changing it
  // in this host-only correction; the actual repo row/ROLLBACK below proves
  // which path rejected the tombstone.
  assert.equal(errors.length, 1)
  assert.ok(errors[0] instanceof CatalogReadError)
  assert.equal((errors[0] as CatalogReadError).code, 'DB_FAILURE')
  assert.equal(frames.filter(frame => frame.removed).length, 0)
  assert.equal(frames.filter(frame => frame.type === 'updated').length, 0)
  assert.equal(frames.at(-1)?.type, 'end'); assert.equal(owner.cleanups.size, 0)
  const actualChecks = observation.transactions.filter(row => row.actualRepoRows.some(repo => repo.id === deletedRemote.repoId))
  assert.equal(actualChecks.length, repoChecksBefore + 1, 'confirmTombstone must query the actual deleted repo')
  assert.equal((actualChecks.at(-1)!.actualRepoRows[0].payload as { connectionId: string }).connectionId, 'synthetic remote')
  assert.equal(actualChecks.at(-1)!.statements.at(-1), 'ROLLBACK')
  deletedRemote.adapter.dispose()

  for (const transaction of observation.transactions) {
    assert.equal(transaction.statements[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    assert.equal(transaction.released, 1)
    for (const sql of transaction.statements) { assert.match(sql.trim(), /^(SELECT\b|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$|COMMIT$|ROLLBACK$)/i) }
  }
  assert.ok(observation.polls.length > 0)
  assert.deepEqual(owner.unexpected, [])
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  assert.equal((await pool.query('SELECT deleted_at IS NOT NULL AS deleted FROM durable_runtime.catalog_repositories WHERE id=$1', [deletedRemote.repoId])).rows[0].deleted, true)
})
