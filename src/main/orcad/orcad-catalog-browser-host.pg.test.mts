import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createDurablePool, withDurableTransaction } from '../durable-runtime/db/connection.ts'
import { withCatalogReadSnapshot } from '../durable-runtime/catalog/read.ts'
import { registerCatalogProject } from '../durable-runtime/catalog/register.ts'
import { reserveCatalogWorkspace } from '../durable-runtime/catalog/create.ts'
import { prepareCatalogCall } from '../durable-runtime/catalog/request.ts'
import { recordUnitIntent } from '../durable-runtime/lifecycle/intent.ts'
import { reserveSleep } from '../durable-runtime/lifecycle/sleep.ts'
import { recordInputCancel } from '../durable-runtime/input/cancel.ts'
import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import type { ExecutionHostId } from '../../shared/execution-host.ts'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host.ts'
import { createOrcadCatalogBrowserFactory } from './orcad-catalog-browser-host.ts'
import { browserFixtureAuthority, browserFixtureLaunch, browserFixtureRegistration,
  browserFixtureHost, browserFixtureProvider } from './orcad-catalog-browser-fixture-input.ts'

// Written only. Root must allocate a distinct prepared DB before this one PG callback.
if (process.env.ORCA_BROWSER_CATALOG_PG_APPROVED !== 'root-first' ||
    !(process.env.PGDATABASE ?? '').startsWith('orca_browser_catalog_')) {
  throw new Error('Root-owned prepared browser Catalog fixture DB required')
}
await test('PG-only PENDING browser Workspace lookup preserves RR ownership and durable state', async () => {
  const pool = createDurablePool({ max: 2 })
  const query = (sql: string, values: readonly unknown[] = []) => withDurableTransaction(pool, tx => tx.query(sql, values))
  const traces: { queries: string[]; isolation?: string; readOnly?: string; released: number }[] = []
  const state: { host?: RuntimeBrowserCommandHost; entered?: () => void; gate?: Promise<void> } = {}
  let releaseConnect = () => {}
  let hostIdentity: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
  const foreignHost = 'runtime:browser-fixture-other' satisfies ExecutionHostId
  const connect = pool.connect.bind(pool)
  const borrowed = new Proxy(pool, { get(target, property) {
    if (property !== 'connect') { return Reflect.get(target, property, target) }
    return async function (this: Pool) {
      assert.equal(this, borrowed)
      const client = await connect()
      const trace: typeof traces[number] = { queries: [], released: 0 }
      traces.push(trace)
      if (state.gate) { state.entered?.(); await state.gate }
      const ownerQuery = client.query.bind(client), release = client.release.bind(client)
      return new Proxy(client, { get(owned, key) {
        if (key === 'release') { return (destroy?: boolean) => { trace.released++; release(destroy) } }
        if (key === 'query') { return async (sql: string, values: readonly unknown[] = []) => {
          trace.queries.push(sql)
          if (sql.includes('dataset_metadata')) {
            trace.isolation = (await ownerQuery('SHOW transaction_isolation')).rows[0].transaction_isolation
            trace.readOnly = (await ownerQuery('SHOW transaction_read_only')).rows[0].transaction_read_only
          }
          return ownerQuery(sql, [...values])
        } }
        const value = Reflect.get(owned, key, owned)
        return typeof value === 'function' ? value.bind(owned) : value
      } })
    }
  } })
  try {
    const existing = await query("SELECT to_regclass('durable_runtime.catalog_workspace_metadata') AS existing")
    assert.ok(existing.rows[0].existing, 'Root-prepared schema only; fixture does not migrate/install')
    const repoId = `synthetic-browser-repo:${randomUUID()}`
    const authority = browserFixtureAuthority(repoId), registration = browserFixtureRegistration(repoId)
    assert.equal((await registerCatalogProject(pool, authority, registration)).status, 'COMMITTED')
    await query(`INSERT INTO durable_runtime.storage_domains(backend_id,export_id)
      VALUES('synthetic-browser-backend','synthetic-browser-export') ON CONFLICT DO NOTHING`)
    const first = browserFixtureLaunch(repoId, `browser-first-${randomUUID()}`)
    const second = browserFixtureLaunch(repoId, `browser-second-${randomUUID()}`)
    for (const launch of [first, second]) {
      const call = prepareCatalogCall('worktree.create', { repo: repoId, name: launch.workspace.reservedName,
        nameWasGenerated: false, displayName: 'Browser fixture shared label', clientMutationId: randomUUID() }, { authority, capabilities: [] })
      assert.equal((await reserveCatalogWorkspace(pool, call, launch, { recordUnitIntent, reserveSleep, recordInputCancel })).status, 'COMMITTED')
    }
    assert.equal((await query('SELECT provisioning_state FROM durable_runtime.workspaces WHERE id=$1',
      [first.workspace.id])).rows[0].provisioning_state, 'PENDING')
    async function snapshot() {
      return withCatalogReadSnapshot(pool, async tx => {
        const result: Record<string, unknown> = {}
        for (const table of ['workspaces', 'sessions', 'agents', 'tabs', 'runtime_units', 'attempts', 'operations',
          'storage_bindings', 'rpc_receipts', 'session_events', 'outbox_events', 'runtime_commands', 'schema_migrations',
          'catalog_heads', 'catalog_workspace_metadata', 'catalog_tab_metadata']) {
          result[table] = (await tx.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows
            FROM durable_runtime.${table} t`)).rows[0].rows
        }
        return result
      })
    }
    async function unchanged(call: () => Promise<unknown>) {
      const before = await snapshot(); const result = await call(); assert.deepEqual(await snapshot(), before); return result
    }
    const config = { pool: borrowed, datasetName: 'orca-1012-dev-v1', hostId: LOCAL_EXECUTION_HOST_ID,
      readHostIdentity() { assert.equal(this, config); return hostIdentity },
      repositoryIds: [repoId], projectGroupIds: [], workspacePublicIds: [] }
    const provider = browserFixtureProvider(host => { state.host = host }), originalHost = browserFixtureHost()
    function hostFor(input = config) {
      const factory = createOrcadCatalogBrowserFactory(provider, input); assert.ok(factory); factory(originalHost)
      const host = state.host; assert.ok(host); return host
    }
    const host = hostFor(), expected = { id: first.workspace.publicId, repoId, hostId: LOCAL_EXECUTION_HOST_ID }
    assert.deepEqual(await unchanged(() => host.resolveWorktreeSelector(`id:${first.workspace.publicId}`)), expected)
    assert.deepEqual(await unchanged(() => host.resolveBrowserWorkspace(first.workspace.aliases[0])), expected)
    await unchanged(() => assert.rejects(host.resolveBrowserWorkspace('name:Browser fixture shared label'), { code: 'selector_ambiguous' }))
    await unchanged(() => assert.rejects(hostFor({ ...config, repositoryIds: ['unregistered'], readHostIdentity: () => hostIdentity }).resolveBrowserWorkspace(first.workspace.publicId), { code: 'selector_not_found' }))
    await unchanged(() => assert.rejects(hostFor({ ...config, datasetName: 'wrong-dataset', readHostIdentity: () => hostIdentity }).resolveBrowserWorkspace(first.workspace.publicId), { code: 'CATALOG_BROWSER_DATASET_MISMATCH' }))
    await query('UPDATE durable_runtime.catalog_repositories SET payload=$2 WHERE id=$1', [repoId,
      JSON.stringify({ ...registration.repo, executionHostId: foreignHost })])
    await unchanged(() => assert.rejects(host.resolveBrowserWorkspace(first.workspace.publicId), { code: 'CATALOG_REGISTRATION_HOST_MISMATCH' }))
    await query('UPDATE durable_runtime.catalog_repositories SET payload=$2 WHERE id=$1', [repoId, JSON.stringify(registration.repo)])
    await query('UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp(),revision=revision+1 WHERE id=$1', [second.workspace.id])
    await unchanged(() => assert.rejects(host.resolveBrowserWorkspace(second.workspace.aliases[0]), { code: 'CATALOG_WORKSPACE_DELETED' }))
    const delayedHost = hostFor(), beforeDelay = await snapshot()
    const entered = new Promise<void>(resolve => { state.entered = resolve })
    state.gate = new Promise<void>(resolve => { releaseConnect = resolve })
    const pending = delayedHost.resolveBrowserWorkspace(first.workspace.aliases[0]); await entered
    config.repositoryIds.splice(0); config.datasetName = 'mutated-after-connect'
    config.pool = new Proxy(pool, { get(target, key) {
      if (key === 'connect') { return () => { throw new Error('Uncaptured replacement connect') } }
      return Reflect.get(target, key, target)
    } })
    config.readHostIdentity = () => { throw new Error('Uncaptured replacement host callback') }
    releaseConnect(); state.gate = undefined
    assert.deepEqual(await pending, expected); assert.deepEqual(await snapshot(), beforeDelay)
    hostIdentity = foreignHost
    await unchanged(() => assert.rejects(delayedHost.resolveBrowserWorkspace(first.workspace.publicId), { code: 'CATALOG_HOST_MISMATCH' }))
    for (const trace of traces) {
      assert.equal(trace.isolation, 'repeatable read'); assert.equal(trace.readOnly, 'on'); assert.equal(trace.released, 1)
      assert.equal(trace.queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      assert.ok(['COMMIT', 'ROLLBACK'].includes(trace.queries.at(-1) ?? ''))
      assert.equal(trace.queries.filter(sql => sql === 'COMMIT' || sql === 'ROLLBACK').length, 1)
    }
  } finally {
    releaseConnect(); await pool.end()
  }
})
