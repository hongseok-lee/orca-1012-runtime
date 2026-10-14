import assert from 'node:assert/strict'
import { test } from 'node:test'
import pg from 'pg'
import type { Pool } from 'pg'
import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import { createOrcadCatalogBrowserFactory } from './orcad-catalog-browser-host.ts'
import { browserFixtureHost, browserFixtureProvider, browserFixtureLaunch, browserFixtureRegistration } from './orcad-catalog-browser-fixture-input.ts'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host.ts'

// One controlled value callback. Query replies are synthetic, never actual PG/Chrome evidence.
test('captured Catalog browser factory preserves host receivers and borrowed ownership', async () => {
  const launch = browserFixtureLaunch('synthetic-value-repo', 'value')
  const row = { ...launch.workspace, workspace_id: launch.workspace.id, public_id: launch.workspace.publicId,
    repo_id: launch.workspace.repoId, project_group_id: null, reserved_path: launch.workspace.reservedPath,
    payload: launch.workspace.payload, deleted_at: null, provisioning_state: 'PENDING' }
  const registration = browserFixtureRegistration('synthetic-value-repo')
  const repositoryRow = { id: registration.repo.id, payload: registration.repo }
  const state: { host?: RuntimeBrowserCommandHost; connects: number; releases: number; ends: number; queries: string[] } =
    { connects: 0, releases: 0, ends: 0, queries: [] }
  const owner = new pg.Pool({ max: 1 })
  try {
  const client = new Proxy(new pg.Client(), {
    get(target, property) {
      if (property === 'release') { return () => { state.releases++ } }
      if (property === 'query') { return async (sql: string) => {
        state.queries.push(sql)
        const rows = sql.includes('dataset_metadata') ? [{ dataset_name: 'orca-1012-dev-v1' }]
          : sql.includes('catalog_workspace_metadata') ? [row]
          : sql.includes('workspace_aliases') ? [{ workspace_id: launch.workspace.id }]
          : sql.includes('FROM durable_runtime.workspaces') ? [{ id: launch.workspace.id, dataset_name: 'orca-1012-dev-v1' }]
          : sql.includes('catalog_repositories') ? [repositoryRow]
          : []
        return { rows, rowCount: rows.length, command: 'SELECT', fields: [], oid: 0 }
      } }
      return Reflect.get(target, property, target)
    }
  })
  const controlledConnect = async function (this: Pool) { assert.equal(this, pool); state.connects++; return client }
  const pool = new Proxy(owner, { get(target, property) {
    if (property === 'connect') { return controlledConnect }
    if (property === 'end') { return () => { state.ends++; throw new Error('Borrowed Pool.end') } }
    return Reflect.get(target, property, target)
  } })
  const config = { pool, datasetName: 'orca-1012-dev-v1', hostId: LOCAL_EXECUTION_HOST_ID,
    readHostIdentity() { assert.equal(this, config); return LOCAL_EXECUTION_HOST_ID },
    repositoryIds: [registration.repo.id], projectGroupIds: [], workspacePublicIds: [] }
  const host = browserFixtureHost()
  host.getAgentBrowserBridge = function () { assert.equal(this, host); return null }
  let notified = false
  host.notifyHeadlessBrowserSessionTabsChanged = function () { assert.equal(this, host); notified = true }
  Object.defineProperty(host, 'fixtureValue', { configurable: true,
    get() { assert.equal(this, host); return 123 } })
  const descriptors = Object.getOwnPropertyDescriptors(host)
  const originalConnect = pool.connect, originalFactoryState = Object.getOwnPropertyDescriptors(config)
  const provider = browserFixtureProvider(value => { state.host = value })
  const providerDescriptors = Object.getOwnPropertyDescriptors(provider)
  const factory = createOrcadCatalogBrowserFactory(provider, config)
  assert.ok(factory); factory(host)
  const bound = state.host; assert.ok(bound)
  assert.notEqual(bound, host)
  const expected = { id: launch.workspace.publicId, repoId: registration.repo.id, hostId: LOCAL_EXECUTION_HOST_ID }
  assert.deepEqual(await bound.resolveWorktreeSelector(`id:${launch.workspace.publicId}`), expected)
  assert.deepEqual(await bound.resolveBrowserWorkspace(launch.workspace.aliases[0]), expected)
  assert.equal(bound.getAgentBrowserBridge(), null)
  assert.equal(Reflect.get(bound, 'fixtureValue'), 123)
  bound.notifyHeadlessBrowserSessionTabsChanged?.(launch.workspace.publicId); assert.equal(notified, true)
  assert.deepEqual(Object.getOwnPropertyDescriptors(host), descriptors)
  assert.deepEqual(Object.getOwnPropertyDescriptors(config), originalFactoryState)
  assert.deepEqual(Object.getOwnPropertyDescriptors(provider), providerDescriptors)
  assert.equal(pool.connect, originalConnect)
  assert.equal(Object.isFrozen(host), false); assert.equal(Object.isFrozen(pool), false); assert.equal(Object.isFrozen(provider), false)
  assert.equal(createOrcadCatalogBrowserFactory(provider), provider.factory)
  assert.equal(createOrcadCatalogBrowserFactory({ ...provider, kind: 'electron' }, config), provider.factory)
  assert.equal(createOrcadCatalogBrowserFactory(null, config), null)
  assert.equal(state.connects, 2); assert.equal(state.releases, 2); assert.equal(state.ends, 0)
  assert.equal(state.queries.filter(sql => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').length, 2)
  assert.equal(state.queries.filter(sql => sql === 'COMMIT').length, 2)
  // 기존 두 resolver assertion 뒤에 host 우선순위 경계만 추가합니다.
  const foreignHost = 'runtime:browser-fixture-other'
  const connectionOnlyRepo = { ...registration.repo, connectionId: 'synthetic-browser-ssh' }
  delete connectionOnlyRepo.executionHostId
  repositoryRow.payload = connectionOnlyRepo
  await assert.rejects(bound.resolveBrowserWorkspace(launch.workspace.publicId), { code: 'CATALOG_REGISTRATION_HOST_MISMATCH' })
  repositoryRow.payload = { ...registration.repo, connectionId: 'synthetic-browser-ssh' }
  assert.deepEqual(await bound.resolveBrowserWorkspace(launch.workspace.publicId), expected)
  row.payload = { ...launch.workspace.payload, hostId: foreignHost, executionHostId: LOCAL_EXECUTION_HOST_ID }
  await assert.rejects(bound.resolveBrowserWorkspace(launch.workspace.publicId), { code: 'CATALOG_REGISTRATION_HOST_MISMATCH' })
  row.payload = { ...launch.workspace.payload, hostId: LOCAL_EXECUTION_HOST_ID, executionHostId: foreignHost }
  assert.deepEqual(await bound.resolveBrowserWorkspace(launch.workspace.publicId), expected)
  assert.equal(state.connects, 6); assert.equal(state.releases, 6); assert.equal(state.ends, 0)
  assert.equal(state.queries.filter(sql => sql === 'COMMIT').length, 4)
  assert.equal(state.queries.filter(sql => sql === 'ROLLBACK').length, 2)

  } finally { await owner.end() }
})
