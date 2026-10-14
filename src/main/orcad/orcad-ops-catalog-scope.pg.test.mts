import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import type { ExecutionHostId } from '../../shared/execution-host.ts'
import { getDefaultUIState } from '../../shared/constants.ts'
import { pairedDeviceAttachmentPrincipal } from '../durable-runtime/attachments/types.ts'
import type { CatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import { reserveCatalogWorkspace } from '../durable-runtime/catalog/create.ts'
import type { PreparedCatalogLaunch } from '../durable-runtime/catalog/launch.ts'
import { registerCatalogProject } from '../durable-runtime/catalog/register.ts'
import { prepareCatalogCall } from '../durable-runtime/catalog/request.ts'
import { parseCatalogUi } from '../durable-runtime/catalog/ui.ts'
import { createDurablePool } from '../durable-runtime/db/connection.ts'
import { recordInputCancel } from '../durable-runtime/input/cancel.ts'
import { recordUnitIntent } from '../durable-runtime/lifecycle/intent.ts'
import { reserveSleep } from '../durable-runtime/lifecycle/sleep.ts'
import { sanitizeOpsError } from '../durable-runtime/ops/errors.ts'
import { createPgOpsServices } from '../durable-runtime/ops/pg-services.ts'
import { OPS_REPLAY_STREAM } from '../durable-runtime/replay/types.ts'
import { captureDurableCatalogReadConfig } from '../durable-runtime/rpc/config.ts'
import { createOrcadOpsCatalogScopeServices } from './orcad-ops-catalog-scope.ts'
import { captureOrcadOpsConfig } from './orcad-ops-config.ts'
import { prepareOrcadOps } from './orcad-ops.ts'

// Fresh owned schema-only DB is supplied by Root later. No schema preparation/dev access here.
if (process.env.ORCA_OPS_CATALOG_SCOPE_APPROVED !== 'root-ready' ||
    !/^orca_ops_catalog_scope_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')) {
  throw new Error('Root assignment and fresh owned Ops Catalog scope DB required')
}
const owners = { recordUnitIntent, reserveSleep, recordInputCancel }
const policy = { operationDeadlineMs: 120000, idleDurationMs: null }
function launch(repo: string, principalId: string, backend: string, exportId: string): PreparedCatalogLaunch {
  const id = randomUUID(), name = `scope-${id}`, reservedPath = `/synthetic/ops-catalog/${name}`
  const publicId = `${repo}::${reservedPath}`, parentTabId = `synthetic-tab-${randomUUID()}`, leafId = randomUUID()
  const tabId = randomUUID(), sessionId = randomUUID(), unitId = randomUUID()
  const git = { path: reservedPath, head: '', branch: name, isBare: false, isMainWorktree: false }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Isolated PG fixture launch authority; no production issuer or physical resource proof.
  return { workspace: { id, publicId, kind: 'GIT', repoId: repo, projectGroupId: null,
    reservedPath, reservedName: name, generatedName: false, nameChoice: 0, aliases: [],
    payload: { ...git, id: publicId, repoId: repo, displayName: name, comment: '', linkedIssue: null,
      linkedPR: null, linkedLinearIssue: null, isArchived: false, isUnread: false, isPinned: false,
      sortOrder: 0, lastActivityAt: 0, parentWorktreeId: null, childWorktreeIds: [], lineage: null, git } },
    tab: { id: tabId, publicId: `${parentTabId}::${leafId}`, parentTabId, leafId,
      terminalHandle: `synthetic-logical:${tabId}`, uiOrder: 0,
      payload: { type: 'terminal', id: `${parentTabId}::${leafId}`, parentTabId, leafId,
        title: name, isActive: true, status: 'pending-handle', terminal: null } },
    sessionId, agent: { id: randomUUID(), provider: 'shell', create: true },
    unit: { id: unitId, create: true, authority: { principalId, runtimeUnitId: unitId, scope: `workspace:${id}` } },
    storage: { id: randomUUID(), createUnverified: true, backendId: backend, exportId,
      canonicalDirectory: `/synthetic/ops-catalog/homes/${sessionId}` },
    launchRequest: { command: 'synthetic-only' }, policy } as unknown as PreparedCatalogLaunch
}
const status = (expected: number) => (error: unknown) => sanitizeOpsError(error).status === expected

test('one Ops startup sees later authorized Catalog creation, hides foreign scope and preserves tombstone anchors without masking PG failure', async () => {
  const pool = createDurablePool({ max: 4 }), repo = `scope-repo:${randomUUID()}`, foreignRepo = `foreign-repo:${randomUUID()}`
  const principalId = pairedDeviceAttachmentPrincipal(randomUUID()), backend = `scope-backend:${randomUUID()}`, exportId = 'scope-export'
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture registration/creation authority only, never authenticated HTTP data.
  const authority = { principalId, repositoryIds: [repo, foreignRepo], projectGroupIds: [], workspacePublicIds: [] } as unknown as CatalogAuthority
  let host: ExecutionHostId = 'local'
  try {
    assert.equal((await pool.query('SELECT count(*)::text AS n FROM durable_runtime.schema_migrations')).rows[0].n, '19')
    for (const table of ['workspaces', 'runtime_units', 'catalog_repositories']) {
      assert.equal((await pool.query(`SELECT count(*)::text AS n FROM durable_runtime.${table}`)).rows[0].n, '0')
    }
    for (const id of [repo, foreignRepo]) {
      const registered = await registerCatalogProject(pool, authority, { mutationId: `scope-register:${id}`,
        repo: { id, path: `/synthetic/ops-catalog/${id}`, displayName: id, badgeColor: '#0ea5e9',
          addedAt: 1, kind: 'git', projectGroupId: null, executionHostId: 'local' },
        group: null, ui: parseCatalogUi(getDefaultUIState()) })
      assert.equal(registered.status, 'COMMITTED')
    }
    await pool.query('INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)', [backend, exportId])
    const repositories = [repo], catalogInput = { pool, datasetName: 'orca-1012-dev-v1', hostId: 'local' as const,
      repositoryIds: repositories, projectGroupIds: [], workspacePublicIds: [], readHostIdentity() {
        assert.equal(this, catalogInput); return host
      } }
    const privateInput = { origin: 'http://localhost:16768', namespaceId: 'synthetic-ops-catalog', workspaceIds: [],
      workspaceScope: 'catalog' as const, lifecyclePolicy: { ...policy }, pollIntervalMs: 1000 }
    const ops = await prepareOrcadOps(captureOrcadOpsConfig(privateInput), catalogInput)
    assert.ok(ops)
    const actor = { ...ops.scope, workspaceIds: [], principalId: 'synthetic-existing-verifier-principal',
      authorizationRef: 'synthetic-existing-verifier-ref' }
    const staticServices = createPgOpsServices({ pool, scope: ops.scope, streamId: OPS_REPLAY_STREAM,
      lifecyclePolicy: policy, controllerConnected: false })
    assert.deepEqual((await ops.services.units(actor)).units, [])
    const created = launch(repo, principalId, backend, exportId), foreign = launch(foreignRepo, principalId, backend, exportId)
    for (const item of [created, foreign]) {
      const outcome = await reserveCatalogWorkspace(pool, prepareCatalogCall('worktree.create', {
        repo: item.workspace.repoId!, name: item.workspace.reservedName, nameWasGenerated: false,
        displayName: item.workspace.reservedName, clientMutationId: `scope-create:${item.workspace.id}`
      }, { authority, capabilities: [] }), item, owners)
      assert.equal(outcome.status, 'COMMITTED')
    }
    // Mutating the original server registration cannot broaden the captured wrapper.
    repositories.push(foreignRepo); catalogInput.datasetName = 'replacement'
    catalogInput.readHostIdentity = () => 'runtime:replacement'
    privateInput.lifecyclePolicy.operationDeadlineMs = 1
    const mutableActor = { ...actor, workspaceIds: [] as string[] }
    const pending = ops.services.units(mutableActor)
    mutableActor.workspaceIds.push(foreign.workspace.id); mutableActor.namespaceId = 'replacement'
    const list = await pending
    assert.deepEqual(list.units.map(unit => unit.id), [created.unit.id])
    assert.ok(list.units[0].availableActions.some(action => action.action === 'wake' &&
      !action.enabled && action.reason === 'CONTROLLER_NOT_CONNECTED'))
    assert.deepEqual((await staticServices.units(actor)).units, [])
    assert.equal((await ops.services.unit(actor, created.unit.id)).unit.id, created.unit.id)
    await assert.rejects(ops.services.unit(actor, foreign.unit.id), status(403))
    await assert.rejects(ops.services.units({ ...actor, workspaceIds: [created.workspace.id] }), status(403))
    await assert.rejects(ops.services.units({ ...actor, datasetName: 'other-dataset' }), status(403))
    const anchorSql = 'SELECT workspace_id,repo_id,runtime_unit_id,create_request FROM durable_runtime.catalog_workspace_metadata WHERE workspace_id=$1'
    const anchor = (await pool.query(anchorSql, [created.workspace.id])).rows
    // Fixture-only logical tombstone/member removal; no physical deletion or Catalog success is fabricated.
    await pool.query('UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp(),revision=revision+1 WHERE id=$1', [created.workspace.id])
    await pool.query('DELETE FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1', [created.unit.id])
    assert.equal((await ops.services.unit(actor, created.unit.id)).unit.id, created.unit.id)
    assert.deepEqual((await pool.query(anchorSql, [created.workspace.id])).rows, anchor)
    host = 'runtime:other-host'
    await assert.rejects(ops.services.units(actor), status(503))
    host = 'local'
    const wrongScope = { ...ops.scope, datasetName: 'other-dataset' }
    const wrongDataset = createOrcadOpsCatalogScopeServices(captureDurableCatalogReadConfig({ ...catalogInput,
      datasetName: wrongScope.datasetName, repositoryIds: [repo], readHostIdentity: () => host }),
    { pool, scope: wrongScope, streamId: OPS_REPLAY_STREAM, lifecyclePolicy: policy, controllerConnected: false })
    await assert.rejects(wrongDataset.units({ ...actor, ...wrongScope }), status(503))
    const failingPool = new Proxy(pool, { get(original, key) {
      if (key === 'connect') { return async () => {
        const client = await original.connect()
        return new Proxy(client, { get(connection, property) {
          if (property === 'query') { return (...args: unknown[]) => String(args[0]).includes('dataset_metadata')
            ? connection.query('SELECT * FROM durable_runtime.ops_scope_fixture_missing_relation')
            : Reflect.apply(connection.query, connection, args) }
          const member = Reflect.get(connection, property)
          return typeof member === 'function' ? member.bind(connection) : member
        } })
      } }
      const member = Reflect.get(original, key)
      return typeof member === 'function' ? member.bind(original) : member
    } }) satisfies Pool
    const failure = createOrcadOpsCatalogScopeServices(captureDurableCatalogReadConfig({ ...catalogInput,
      pool: failingPool, datasetName: ops.scope.datasetName, repositoryIds: [repo], readHostIdentity: () => host }),
    { pool: failingPool, scope: ops.scope, streamId: OPS_REPLAY_STREAM, lifecyclePolicy: policy, controllerConnected: false })
    await assert.rejects(failure.units(actor), error => {
      const safe = sanitizeOpsError(error)
      assert.equal(safe.status, 503); assert.ok(!safe.message.includes('missing_relation')); return true
    })
    // The helper did not end the borrowed Pool; it still queries normally after the real PG error.
    assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value, 1)
  } finally { await pool.end() }
})
