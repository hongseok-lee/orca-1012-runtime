import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createDurablePool } from '../durable-runtime/db/connection.ts'
import { registerCatalogProject } from '../durable-runtime/catalog/register.ts'
import type { CatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import type { CatalogRegistration } from '../durable-runtime/catalog/register.ts'
import { captureOrcadDurableCatalogConfig, prepareOrcadDurableCatalog } from './orcad-durable-catalog.ts'
import { prepareMissingStartupFixture, type MissingStartupBoundary } from './orcad-durable-catalog.pg-fixtures.mts'

// Root supplies a new owned validation DB with accepted schema 001–014 first.
// This fixture never migrates, applies dev schema or reuses PR43's validation DB.
if (process.env.ORCA_P116_STARTUP_APPROVED !== 'root-ready' ||
    !(process.env.PGDATABASE ?? '').startsWith('orca_p116_startup_')) {
  throw new Error('Root startup Ready and separate owned schema-ready validation DB required')
}
const pg = { host: process.env.PGHOST!, port: Number(process.env.PGPORT ?? '5432'),
  database: process.env.PGDATABASE!, user: process.env.PGUSER!, max: 2 }
const pgpassFile = process.env.PGPASSFILE!
const selection = process.env.ORCA_P116_STARTUP_PG_SELECTION
if (selection !== undefined && selection !== 'failed-four') { throw new Error('Unknown startup PG fixture selection') }
const failedFourOnly = selection === 'failed-four'
// In focused mode, even the successful callbacks' shared Pool/registration setup is skipped.
let pool: Pool
const repo = `synthetic-startup-repo:${randomUUID()}`
const group = `synthetic-startup-group:${randomUUID()}`
const input = (): { datasetName: string; hostId: string; repositoryIds: string[];
  projectGroupIds: string[]; workspacePublicIds: readonly string[]; pg: typeof pg } => ({
  datasetName: 'orca-1012-dev-v1', hostId: 'local',
  repositoryIds: [repo], projectGroupIds: [group], workspacePublicIds: [], pg: { ...pg } })
const ui = { lastActiveRepoId: null, lastActiveWorktreeId: null, activeView: 'terminal', sidebarWidth: 240,
  rightSidebarOpen: false, rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files', rightSidebarWidth: 320,
  groupBy: 'none', sortBy: 'smart', projectOrderBy: 'manual', showActiveOnly: false, hideDefaultBranchWorkspace: false,
  filterRepoIds: [], collapsedGroups: [], uiZoomLevel: 0, editorFontZoomLevel: 0, worktreeCardProperties: [],
  statusBarItems: [], statusBarVisible: true, dismissedUpdateVersion: null, lastUpdateCheckAt: null }
const registration = () => ({
  repo: { id: repo, path: `/synthetic/startup/${repo}`, displayName: repo, badgeColor: '#ffffff', addedAt: 1,
    kind: 'git', projectGroupId: group, executionHostId: 'local' },
  group: { id: group, name: group, parentPath: null, parentGroupId: null, color: null, isCollapsed: false,
    tabOrder: 0, createdAt: 1, updatedAt: 1, createdFrom: 'manual' }, ui
}) as Pick<CatalogRegistration, 'repo' | 'group' | 'ui'>
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
async function rejectedMissing(boundary: MissingStartupBoundary, expected: string) {
  const missingPg = await prepareMissingStartupFixture(pg, boundary, registration())
  const observed = observedFactory()
  try {
    await assert.rejects(prepareOrcadDurableCatalog(
      captureOrcadDurableCatalogConfig({ ...input(), pg: missingPg }, pgpassFile), observed.factory),
    (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === expected)
  } finally { assert.equal(observed.ends(), 1) }
}
await test('new orcad startup PG registration and Pool ownership boundaries', async t => {
  try {
    if (!failedFourOnly) {
      pool = createDurablePool(pg)
      const authority = { principalId: `synthetic-startup-principal:${randomUUID()}`,
        repositoryIds: [repo], projectGroupIds: [group], workspacePublicIds: [] } as unknown as CatalogAuthority
      await registerCatalogProject(pool, authority, { mutationId: `synthetic-startup-register:${randomUUID()}`,
        ...registration() } as CatalogRegistration)
    }

    await t.test('registered PG startup captures stable local identity and repeated normal cleanup closes once', { skip: failedFourOnly }, async () => {
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
    await t.test('unregistered configured project is failure and closes its Pool', { skip: failedFourOnly }, async () => {
      await rejected({ ...input(), repositoryIds: ['synthetic-missing-registration'] })
    })
    await t.test('foreign registered repository host is failure and closes its Pool', { skip: failedFourOnly }, async () => {
      await pool.query("UPDATE durable_runtime.catalog_repositories SET payload=jsonb_set(payload,'{executionHostId}','\"runtime:synthetic-other\"') WHERE id=$1", [repo])
      try { await rejected() } finally {
        await pool.query("UPDATE durable_runtime.catalog_repositories SET payload=jsonb_set(payload,'{executionHostId}','\"local\"') WHERE id=$1", [repo])
      }
    })
    await t.test('missing catalog head cannot become an empty successful startup', async () => {
      await rejectedMissing('catalog-head', 'CATALOG_HEAD_MISSING')
    })
    await t.test('missing UI publication head is an explicit startup configuration failure', async () => {
      await rejectedMissing('ui-head', 'CATALOG_STARTUP_HEAD_MISSING')
    })
    await t.test('missing initialized UI is failure and closes its Pool', async () => {
      await rejectedMissing('ui-state', 'CATALOG_STARTUP_UI_NOT_INITIALIZED')
    })
    await t.test('missing dataset registration is failure and cannot start with an empty Catalog', async () => {
      await rejectedMissing('dataset', 'CATALOG_STARTUP_DATASET_MISMATCH')
    })
    await t.test('registered workspace without its publication head is rejected', { skip: failedFourOnly }, async () => {
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
  } finally { if (!failedFourOnly) { await pool?.end() } }
})
