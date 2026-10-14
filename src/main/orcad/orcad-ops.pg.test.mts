import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool } from '../durable-runtime/db/connection.ts'
import { snapshotRuntimeOpsHttpConfig } from '../durable-runtime/ops/runtime-config.ts'
import { OPS_REPLAY_STREAM } from '../durable-runtime/replay/types.ts'
import { getOpsUiAsset } from '../durable-runtime/ops-ui/index.ts'
import { captureOrcadDurableCatalogConfig, prepareOrcadDurableCatalog } from './orcad-durable-catalog.ts'
import { captureOrcadOpsConfig, OrcadOpsConfigurationError } from './orcad-ops-config.ts'
import { prepareOrcadOps } from './orcad-ops.ts'
import { startOrcadWithLifecycle } from './orcad-lifecycle.ts'
import { stopOrcadRuntimeWithDurableCatalog } from './orcad-durable-catalog-cleanup.ts'

// Root supplies one fresh owned 001–019 schema-only DB. This fixture never migrates or touches dev.
if (process.env.ORCA_OPS_STARTUP_APPROVED !== 'root-ready' ||
    !/^orca_p126_startup_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')) {
  throw new Error('Root Ops startup Ready and fresh owned schema-only DB required')
}
const pg = { host: process.env.PGHOST!, port: Number(process.env.PGPORT ?? '5432'),
  database: process.env.PGDATABASE!, user: process.env.PGUSER!, max: 2 }
const configured = (workspaceIds: string[] = []) => ({ origin: 'http://localhost:16768',
  namespaceId: 'synthetic-ops-startup', workspaceIds,
  lifecyclePolicy: { operationDeadlineMs: 10000, idleDurationMs: 60000 }, pollIntervalMs: 1000 })
const code = (expected: string) => (error: unknown): boolean =>
  error instanceof OrcadOpsConfigurationError && error.code === expected && error.message === expected

await test('actual Catalog authority, dataset, tombstones and same borrowed Pool reach the existing Runtime config', async () => {
  const actual = createDurablePool(pg), transactions: string[][] = []
  let ends = 0
  const pool = new Proxy(actual, { get(target, key) {
    if (key === 'end') { return async () => { ends++; await target.end() } }
    if (key === 'connect') { return async () => {
      const client = await target.connect(), statements: string[] = []
      transactions.push(statements)
      return new Proxy(client, { get(original, property) {
        if (property === 'query') { return (...args: unknown[]) => {
          statements.push(String(args[0]))
          return Reflect.apply(original.query, original, args)
        } }
        const value = Reflect.get(original, property)
        return typeof value === 'function' ? value.bind(original) : value
      } })
    } }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  let owner: Awaited<ReturnType<typeof prepareOrcadDurableCatalog>> = null
  try {
    const versions = (await actual.query<{ version: string }>(
      'SELECT version FROM durable_runtime.schema_migrations ORDER BY version')).rows
    assert.deepEqual(versions.map(row => Number(row.version.slice(0, 3))), Array.from({ length: 19 }, (_, i) => i + 1))
    for (const table of ['workspaces', 'runtime_units', 'catalog_project_groups', 'catalog_repositories', 'catalog_heads', 'catalog_ui_state']) {
      assert.equal((await actual.query(`SELECT count(*)::text AS n FROM durable_runtime.${table}`)).rows[0].n, '0')
    }
    const repo = `synthetic-ops-repo:${randomUUID()}`, group = `synthetic-ops-group:${randomUUID()}`
    const foreignGroup = `synthetic-ops-foreign:${randomUUID()}`
    const groupPayload = (id: string) => ({ id, name: id, parentPath: null, parentGroupId: null,
      color: null, isCollapsed: false, tabOrder: 0, createdAt: 1, updatedAt: 1, createdFrom: 'manual' })
    const ui = { lastActiveRepoId: null, lastActiveWorktreeId: null, activeView: 'terminal', sidebarWidth: 240,
      rightSidebarOpen: false, rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files', rightSidebarWidth: 320,
      groupBy: 'none', sortBy: 'smart', projectOrderBy: 'manual', showActiveOnly: false, hideDefaultBranchWorkspace: false,
      filterRepoIds: [], collapsedGroups: [], uiZoomLevel: 0, editorFontZoomLevel: 0, worktreeCardProperties: [],
      statusBarItems: [], statusBarVisible: true, dismissedUpdateVersion: null, lastUpdateCheckAt: null }
    for (const id of [group, foreignGroup]) {
      await actual.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [id, groupPayload(id)])
    }
    await actual.query('INSERT INTO durable_runtime.catalog_repositories(id,project_group_id,payload) VALUES($1,$2,$3)',
      [repo, group, { id: repo, path: `/synthetic/ops/${repo}`, displayName: repo, badgeColor: '#ffffff',
        addedAt: 1, kind: 'git', projectGroupId: group, executionHostId: 'local' }])
    for (const scope of ['catalog', 'ui:host']) {
      await actual.query('INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)', [scope, randomUUID()])
    }
    await actual.query("INSERT INTO durable_runtime.catalog_ui_state(scope,payload) VALUES('host',$1)", [ui])
    owner = await prepareOrcadDurableCatalog(captureOrcadDurableCatalogConfig({
      datasetName: 'orca-1012-dev-v1', hostId: 'local', repositoryIds: [repo], projectGroupIds: [group],
      workspacePublicIds: [], pg }, process.env.PGPASSFILE!), () => pool)
    assert.ok(owner); assert.equal(owner.readConfig.pool, pool)
    const workspaces = [randomUUID(), randomUUID(), randomUUID()], units = [randomUUID(), randomUUID(), randomUUID()]
    for (const [index, id] of workspaces.entries()) {
      const projectGroupId = index === 2 ? foreignGroup : group
      // Public IDs stay opaque strings. The requested Ops IDs are separate internal UUIDs.
      const publicId = `synthetic-public:${id}`, path = `/synthetic/ops/${id}`
      await actual.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,$3,'READY')", [id, publicId, id])
      await actual.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [units[index]])
      await actual.query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,project_group_id,reserved_path,payload,create_request,runtime_unit_id)
        VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}',$5)`, [id, projectGroupId, path,
        { id: publicId, projectGroupId, name: id, folderPath: path, comment: '', createdAt: 1, updatedAt: 1,
          lastActivityAt: 0, sortOrder: 0, isArchived: false, isUnread: false, isPinned: false }, units[index]])
    }
    await actual.query('UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp(),revision=revision+1 WHERE id=$1', [workspaces[1]])
    const immutableBefore = (await actual.query('SELECT workspace_id,project_group_id,runtime_unit_id,create_request FROM durable_runtime.catalog_workspace_metadata ORDER BY workspace_id')).rows
    const mutable = configured(workspaces.slice(0, 2)), groupIds = [group]
    const catalog = { ...owner.readConfig, projectGroupIds: groupIds }
    const pending = prepareOrcadOps(mutable, catalog)
    mutable.workspaceIds.length = 0; mutable.namespaceId = 'replacement'; mutable.lifecyclePolicy.operationDeadlineMs = 1
    groupIds[0] = foreignGroup; catalog.datasetName = 'replacement'
    const ops = await pending
    assert.ok(ops); assert.deepEqual(ops.scope.workspaceIds, workspaces.slice(0, 2))
    assert.equal(ops.scope.namespaceId, 'synthetic-ops-startup'); assert.equal(ops.scope.datasetName, 'orca-1012-dev-v1')
    assert.equal(ops.ui, getOpsUiAsset); assert.equal(ops.streamId, OPS_REPLAY_STREAM)
    assert.deepEqual(ops.ui?.('/ops/'), getOpsUiAsset('/ops/'))
    const runtimeConfig = snapshotRuntimeOpsHttpConfig(ops)
    assert.deepEqual(runtimeConfig.ui?.('/ops/app.js'), getOpsUiAsset('/ops/app.js'))
    const actor = { ...ops.scope, principalId: 'synthetic-verified-owner', authorizationRef: 'synthetic-existing-verifier' }
    const connectionsBefore = transactions.length
    const list = await runtimeConfig.services.units(actor)
    assert.ok(transactions.length > connectionsBefore, 'Actual services must query the borrowed Catalog Pool')
    assert.deepEqual(list.units.map(row => row.id).sort(), units.slice(0, 2).sort())
    assert.ok(list.units.every(row => row.availableActions.find(action => action.action === 'wake')?.reason === 'CONTROLLER_NOT_CONNECTED'))
    assert.ok(transactions.some(sql => sql[0] === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' &&
      sql.some(text => text.includes('dataset_metadata')) && sql.some(text => text.includes('catalog_workspace_metadata')) &&
      sql.some(text => text.includes('SELECT id,dataset_name')) && sql.at(-1) === 'COMMIT'))
    const empty = await prepareOrcadOps(captureOrcadOpsConfig(configured()), owner.readConfig)
    assert.ok(empty)
    assert.deepEqual((await empty.services.units({ ...actor, workspaceIds: [] })).units, [])
    await assert.rejects(prepareOrcadOps(captureOrcadOpsConfig({ ...configured([workspaces[2]]), namespaceId: foreignGroup }), owner.readConfig),
      code('OPS_STARTUP_WORKSPACE_FORBIDDEN'))
    await assert.rejects(prepareOrcadOps(captureOrcadOpsConfig(configured([randomUUID()])), owner.readConfig), code('OPS_STARTUP_WORKSPACE_FORBIDDEN'))
    // Actual 001 admits one dataset; reject a mismatched server scope without changing schema or its seed.
    await assert.rejects(prepareOrcadOps(captureOrcadOpsConfig(configured()), { ...owner.readConfig, datasetName: 'synthetic-other-dataset' }),
      code('OPS_STARTUP_DATASET_MISMATCH'))
    assert.deepEqual((await actual.query('SELECT workspace_id,project_group_id,runtime_unit_id,create_request FROM durable_runtime.catalog_workspace_metadata ORDER BY workspace_id')).rows, immutableBefore)
    assert.equal(ends, 0, 'Ops must never close its borrowed Pool')
    const catalogOwner = owner, order: string[] = []
    const handle = await startOrcadWithLifecycle(async register => {
      register(() => stopOrcadRuntimeWithDurableCatalog({ stopRpc: async () => { order.push('rpc-http') },
        stopAgentControlAdapter: () => {}, stopDaemon: async () => {}, uninstallObservedStatusIdentity: () => {},
        uninstallHookStatusRepublish: () => {}, stopAgentHookServer: () => {},
        stopDurableCatalog: async () => { order.push('catalog-pool'); await catalogOwner.stop() } }))
      return { opsHttp: ops }
    }, async () => { order.push('host') })
    assert.equal(handle.opsHttp, ops)
    const stop1 = handle.stop(), stop2 = handle.stop()
    assert.equal(stop1, stop2); await Promise.all([stop1, stop2])
    assert.deepEqual(order, ['rpc-http', 'catalog-pool', 'host']); assert.equal(ends, 1)
  } finally {
    if (owner) { await owner.stop() } else if (!ends) { await pool.end() }
    assert.equal(ends, 1)
  }
})
