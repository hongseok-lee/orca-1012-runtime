import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createDurablePool } from '../durable-runtime/db/connection.ts'
import { registerCatalogProject } from '../durable-runtime/catalog/register.ts'
import type { CatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import type { CatalogRegistration } from '../durable-runtime/catalog/register.ts'
import { captureOrcadDurableCatalogConfig, prepareOrcadDurableCatalog,
  OrcadDurableCatalogConfigurationError } from './orcad-durable-catalog.ts'

// Root supplies a new owned validation DB with accepted schema 001–014 first.
// This fixture never migrates, applies dev schema or reuses PR43's validation DB.
if (process.env.ORCA_P116_STARTUP_APPROVED !== 'root-ready' ||
    !(process.env.PGDATABASE ?? '').startsWith('orca_p116_startup_')) {
  throw new Error('Root startup Ready and separate owned schema-ready validation DB required')
}
const pg = { host: process.env.PGHOST!, port: Number(process.env.PGPORT ?? '5432'),
  database: process.env.PGDATABASE!, user: process.env.PGUSER!, max: 2 }
const pgpassFile = process.env.PGPASSFILE!
const pool = createDurablePool(pg)
const repo = `synthetic-startup-repo:${randomUUID()}`
const group = `synthetic-startup-group:${randomUUID()}`
const input = () => ({ datasetName: 'orca-1012-dev-v1', hostId: 'local',
  repositoryIds: [repo], projectGroupIds: [group], workspacePublicIds: [], pg: { ...pg } })
const ui = { lastActiveRepoId: null, lastActiveWorktreeId: null, activeView: 'terminal', sidebarWidth: 240,
  rightSidebarOpen: false, rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files', rightSidebarWidth: 320,
  groupBy: 'none', sortBy: 'smart', projectOrderBy: 'manual', showActiveOnly: false, hideDefaultBranchWorkspace: false,
  filterRepoIds: [], collapsedGroups: [], uiZoomLevel: 0, editorFontZoomLevel: 0, worktreeCardProperties: [],
  statusBarItems: [], statusBarVisible: true, dismissedUpdateVersion: null, lastUpdateCheckAt: null }
function observedFactory() {
  let ends = 0
  const statements: string[] = []
  const factory = (options: Parameters<typeof createDurablePool>[0]): Pool => {
    const actual = createDurablePool(options)
    return new Proxy(actual, { get(target, key) {
      if (key === 'end') { return async () => { ends++; await target.end() } }
      if (key === 'connect') { return async () => {
        const client = await target.connect()
        return new Proxy(client, { get(original, property) {
          if (property === 'query') { return (...args: unknown[]) => {
            statements.push(String(args[0]))
            return (original.query as (...values: unknown[]) => Promise<unknown>).apply(original, args)
          } }
          const value = Reflect.get(original, property)
          return typeof value === 'function' ? value.bind(original) : value
        } })
      } }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  return { factory, statements, ends: () => ends }
}
async function rejected(inputValue = input()) {
  const observed = observedFactory()
  await assert.rejects(prepareOrcadDurableCatalog(captureOrcadDurableCatalogConfig(inputValue, pgpassFile), observed.factory))
  assert.equal(observed.ends(), 1)
}
await test('new orcad startup PG registration and Pool ownership boundaries', async t => {
  try {
    const authority = { principalId: `synthetic-startup-principal:${randomUUID()}`,
      repositoryIds: [repo], projectGroupIds: [group], workspacePublicIds: [] } as unknown as CatalogAuthority
    await registerCatalogProject(pool, authority, { mutationId: `synthetic-startup-register:${randomUUID()}`,
      repo: { id: repo, path: `/synthetic/startup/${repo}`, displayName: repo, badgeColor: '#ffffff', addedAt: 1,
        kind: 'git', projectGroupId: group, executionHostId: 'local' },
      group: { id: group, name: group, parentPath: null, parentGroupId: null, color: null, isCollapsed: false,
        tabOrder: 0, createdAt: 1, updatedAt: 1, createdFrom: 'manual' }, ui } as CatalogRegistration)

    await t.test('registered PG startup captures stable local identity and repeated normal cleanup closes once', async () => {
      const mutable = input(), observed = observedFactory()
      const pending = prepareOrcadDurableCatalog(captureOrcadDurableCatalogConfig(mutable, pgpassFile), observed.factory)
      mutable.hostId = 'runtime:synthetic-replacement'; mutable.repositoryIds[0] = 'synthetic-replacement'; mutable.pg.host = 'synthetic-replacement'
      const owner = await pending
      assert.ok(owner)
      assert.equal(owner.readConfig.readHostIdentity(), 'local')
      assert.deepEqual(owner.readConfig.repositoryIds, [repo])
      assert.ok(observed.statements.length > 0)
      for (const sql of observed.statements) { assert.match(sql.trim(), /^(SELECT\b|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$|COMMIT$|ROLLBACK$)/i) }
      const stop1 = owner.stop(), stop2 = owner.stop()
      assert.equal(stop1, stop2); await Promise.all([stop1, stop2]); assert.equal(observed.ends(), 1)
    })
    await t.test('unregistered configured project is failure and closes its Pool', async () => {
      await rejected({ ...input(), repositoryIds: ['synthetic-missing-registration'] })
    })
    await t.test('foreign registered repository host is failure and closes its Pool', async () => {
      await pool.query("UPDATE durable_runtime.catalog_repositories SET payload=jsonb_set(payload,'{executionHostId}','\"runtime:synthetic-other\"') WHERE id=$1", [repo])
      try { await rejected() } finally {
        await pool.query("UPDATE durable_runtime.catalog_repositories SET payload=jsonb_set(payload,'{executionHostId}','\"local\"') WHERE id=$1", [repo])
      }
    })
    await t.test('missing catalog head cannot become an empty successful startup', async () => {
      const head = (await pool.query("DELETE FROM durable_runtime.catalog_heads WHERE scope='catalog' RETURNING *")).rows[0]
      assert.ok(head)
      try { await rejected() } finally {
        await pool.query('INSERT INTO durable_runtime.catalog_heads(scope,dataset_name,publication_epoch,revision) VALUES($1,$2,$3,$4)',
          [head.scope, head.dataset_name, head.publication_epoch, head.revision])
      }
    })
    await t.test('missing UI publication head is an explicit startup configuration failure', async () => {
      const head = (await pool.query("DELETE FROM durable_runtime.catalog_heads WHERE scope='ui:host' RETURNING *")).rows[0]
      assert.ok(head)
      const observed = observedFactory()
      try {
        await assert.rejects(prepareOrcadDurableCatalog(captureOrcadDurableCatalogConfig(input(), pgpassFile), observed.factory),
          (error: unknown): boolean => error instanceof OrcadDurableCatalogConfigurationError && error.code === 'CATALOG_STARTUP_HEAD_MISSING')
        assert.equal(observed.ends(), 1)
      } finally {
        await pool.query('INSERT INTO durable_runtime.catalog_heads(scope,dataset_name,publication_epoch,revision) VALUES($1,$2,$3,$4)',
          [head.scope, head.dataset_name, head.publication_epoch, head.revision])
      }
    })
    await t.test('missing initialized UI is failure and closes its Pool', async () => {
      const row = (await pool.query("DELETE FROM durable_runtime.catalog_ui_state WHERE scope='host' RETURNING *")).rows[0]
      assert.ok(row)
      try { await rejected() } finally {
        await pool.query('INSERT INTO durable_runtime.catalog_ui_state(scope,payload,revision) VALUES($1,$2,$3)', [row.scope, row.payload, row.revision])
      }
    })
    await t.test('missing dataset registration is failure and cannot start with an empty Catalog', async () => {
      const heads = (await pool.query('DELETE FROM durable_runtime.catalog_heads RETURNING *')).rows
      await pool.query('DELETE FROM durable_runtime.dataset_metadata')
      try { await rejected() } finally {
        await pool.query("INSERT INTO durable_runtime.dataset_metadata(dataset_name) VALUES('orca-1012-dev-v1')")
        for (const head of heads) {
          await pool.query('INSERT INTO durable_runtime.catalog_heads(scope,dataset_name,publication_epoch,revision) VALUES($1,$2,$3,$4)',
            [head.scope, head.dataset_name, head.publication_epoch, head.revision])
        }
      }
    })
    await t.test('registered workspace without its publication head is rejected', async () => {
      const id = randomUUID(), path = `/synthetic/startup/workspace/${id}`, publicId = `${repo}::${path}`
      const git = { path, head: '', branch: 'synthetic', isBare: false, isMainWorktree: false }
      const payload = { ...git, id: publicId, repoId: repo, displayName: 'Synthetic startup workspace', comment: '',
        linkedIssue: null, linkedPR: null, linkedLinearIssue: null, isArchived: false, isUnread: false, isPinned: false,
        sortOrder: 0, lastActivityAt: 0, parentWorktreeId: null, childWorktreeIds: [], lineage: null, git }
      await pool.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,$3,'RESERVED')", [id, publicId, id])
      await pool.query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,repo_id,project_group_id,reserved_path,payload,create_request)
        VALUES($1,'GIT',$2,$3,$4,$5,'{}')`, [id, repo, group, path, JSON.stringify(payload)])
      await rejected({ ...input(), workspacePublicIds: [publicId] })
    })
  } finally { await pool.end() }
})
