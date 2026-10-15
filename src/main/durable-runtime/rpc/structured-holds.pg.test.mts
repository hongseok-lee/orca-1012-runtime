import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { eraseRpcMethods, isStreamingMethod } from '../../runtime/rpc/core'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../runtime/rpc/methods/structured-agent-session'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { RuntimeSubscriptionRegistry } from '../../runtime/runtime-subscription-registry'
import { DurableCatalogReadAdapter } from './public.ts'
import { fixtureConfig, fixtureContext, fixtureRuntime } from './fixture-support.mts'

if (process.env.ORCA_STRUCTURED_HOLDS_APPROVED !== 'root-delegated-first-verification' ||
    process.env.PGDATABASE !== 'orca_public_structured_subscribe_20261014' ||
    process.env.ORCA_STRUCTURED_HOLDS_DATABASE !== process.env.PGDATABASE) {
  throw new Error('Root exact existing hold database required; no schema/reset/delete')
}

await test('PG 1개: 실제 bound hold/release는 Pod0 논리 Session과 현재 Catalog 권한만 읽습니다', async t => {
  const pool = createDurablePool({ max: 3, application_name: 'orca-structured-holds-first' })
  const adapters: DurableCatalogReadAdapter[] = []
  t.after(async () => { for (const adapter of adapters) { adapter.dispose() }; await pool.end() })
  // Same borrowed Pool identity, before the first new UUID seed.
  const identity = (await pool.query(`SELECT current_database() AS database,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS backend_pid,
    (SELECT jsonb_agg(dataset_name ORDER BY dataset_name) FROM durable_runtime.dataset_metadata) AS datasets`)).rows[0]
  t.diagnostic(JSON.stringify({ phase: 'before-seed', ...identity }))
  assert.equal(identity.database, 'orca_public_structured_subscribe_20261014'); assert.equal(identity.oid, '84739')
  assert.equal(identity.system, '7696101282789175327'); assert.deepEqual(identity.datasets, ['orca-1012-dev-v1'])
  assert.ok(Number.isInteger(identity.backend_pid) && identity.backend_pid > 0)
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 19)
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='durable_runtime' ORDER BY tablename")).rows.map(row => row.tablename as string)
  assert.ok(tables.every(table => /^[a-z_]+$/.test(table)))
  const snapshotSQL = `${tables.map(table => `SELECT '${table}' AS table_name,
    COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS body FROM durable_runtime."${table}" t`).join(' UNION ALL ')} ORDER BY table_name`
  async function snapshot() {
    return (await pool.query(snapshotSQL)).rows.map(row => ({ table: row.table_name,
      sha256: createHash('sha256').update(row.body).digest('hex') }))
  }
  const namespace = `synthetic-holds-${randomUUID()}`, agentId = randomUUID(), workspaceId = randomUUID()
  const publicWorkspaceId = `${namespace}-workspace`, repoId = `${namespace}-repo`, path = `/synthetic/holds/${namespace}`
  const sessions = Array.from({ length: 4 }, () => randomUUID())
  const aliases = sessions.map(() => `structured_${randomUUID().replaceAll('-', '_')}`)
  const repo = { id: repoId, path, displayName: repoId, kind: 'folder', executionHostId: 'local', badgeColor: '#ffffff', addedAt: 1 }
  const payload = { id: publicWorkspaceId, repoId, path, head: '', branch: '', displayName: namespace, comment: '',
    isBare: false, isMainWorktree: true, sortOrder: 0, lastActivityAt: 1, linkedIssue: null, linkedPR: null,
    linkedLinearIssue: null, parentWorktreeId: null, childWorktreeIds: [], lineage: null,
    git: { path, head: '', branch: '', isBare: false, isMainWorktree: true }, isArchived: false, isUnread: false, isPinned: false }
  // New UUID/namespace-owned synthetic logical rows only. No Unit, membership, Pod or provider proof.
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'claude')", [agentId])
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,$3,'READY')",
      [workspaceId, publicWorkspaceId, namespace])
    await tx.query('INSERT INTO durable_runtime.catalog_repositories(id,payload) VALUES($1,$2)', [repoId, repo])
    await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,repo_id,reserved_path,payload,create_request)
      VALUES($1,'REPO_FOLDER',$2,$3,$4,'{}')`, [workspaceId, repoId, path, payload])
    for (let i = 0; i < sessions.length; i++) {
      await tx.query('INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle,session_fence) VALUES($1,$2,$3,$4,47)',
        [sessions[i], agentId, workspaceId, i === 0 ? 'CLOSED' : 'OPEN'])
      await tx.query(`INSERT INTO durable_runtime.structured_session_aliases
        (public_session_id,session_id,workspace_id,provider,execution_host_id,location,original_create,created_by)
        VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, [aliases[i], sessions[i], workspaceId,
        i === 2 ? 'codex' : 'claude', i === 3 ? 'runtime:synthetic-foreign' : 'local',
        { workspaceId: publicWorkspaceId, executionHostId: 'local', wslDistro: null, workspaceKind: 'folder' }, namespace])
    }
  })
  assert.equal((await pool.query('SELECT count(*)::text AS count FROM durable_runtime.runtime_members WHERE session_id=ANY($1::uuid[])', [sessions])).rows[0].count, '0')
  const native = fixtureRuntime(), registry = new RuntimeSubscriptionRegistry()
  const registrations: { id: string; calls: number; connection?: string }[] = []
  let enabled = true, ends = 0
  const runtime = new Proxy(native.runtime, { get(object, property, receiver) {
    if (property === 'getClientSettings') { return () => ({ experimentalStructuredNativeChat: enabled }) }
    if (property === 'registerOwnedSubscriptionCleanup') {
      return (id: string, close: () => void, connection?: string) => {
        const entry = { id, calls: 0, connection }; registrations.push(entry)
        return registry.registerOwned(id, () => { entry.calls++; close() }, connection)
      }
    }
    if (property === 'registerSubscriptionCleanup') { return registry.register.bind(registry) }
    if (property === 'cleanupSubscription') { return registry.cleanup.bind(registry) }
    return Reflect.get(object, property, receiver)
  } })
  const borrowed = new Proxy(pool, { get(target, property) {
    if (property === 'end') { return async () => { ends++; throw new Error('Adapter must not close the borrowed Pool') } }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const config = { ...fixtureConfig(borrowed), repositoryIds: [repoId] }, declarations = eraseRpcMethods(STRUCTURED_AGENT_SESSION_METHODS)
  function bind(settings = config) {
    const adapter = new DurableCatalogReadAdapter(settings); adapters.push(adapter)
    const methods = adapter.bind(declarations), hold = methods.find(method => method.name === 'agentSession.hold')
    const release = methods.find(method => method.name === 'agentSession.release')
    assert.ok(hold && !isStreamingMethod(hold)); assert.ok(release && !isStreamingMethod(release))
    return { adapter, hold: hold.handler, release: release.handler }
  }
  const bound = bind(), context = fixtureContext(runtime, { clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] })
  async function hold(sessionId = aliases[0], selected = bound, ctx = context, error?: RegExp) {
    const before = await snapshot(), operation = Promise.resolve(selected.hold({ sessionId, holderId: 'same-surface' } as never, ctx))
    if (error) { await assert.rejects(operation, error) } else { assert.deepEqual(await operation, { held: true }) }
    assert.deepEqual(await snapshot(), before, 'each hold is business-read-only, including rejected holds')
  }
  async function release(sessionId = aliases[0], ctx = context) {
    const before = await snapshot()
    assert.deepEqual(await bound.release({ sessionId, holderId: 'same-surface' } as never, ctx), { released: true })
    assert.deepEqual(await snapshot(), before, 'release changes no business table')
  }
  await hold(); const first = registrations.at(-1)!
  await hold(); const replacement = registrations.at(-1)!
  assert.ok(first.calls > 0); assert.equal(replacement.calls, 0)
  const sibling = { ...context, connectionId: 'synthetic-other-connection' }
  await hold(aliases[0], bound, sibling); const siblingEntry = registrations.at(-1)!
  await release(); assert.ok(replacement.calls > 0); assert.equal(siblingEntry.calls, 0)
  await release(); await release(aliases[0], sibling); assert.ok(siblingEntry.calls > 0)
  await hold(aliases[1]); registry.cleanupForConnection(context.connectionId!); await release(aliases[1])
  await hold(aliases[0], bind({ ...config, repositoryIds: [] }), context, /selector_not_found/)
  await hold(aliases[0], bind({ ...config, datasetName: 'synthetic-other-dataset' }), context, /CATALOG_DATASET_MISMATCH/)
  await hold(`structured_${randomUUID().replaceAll('-', '_')}`, bound, context, /STRUCTURED_HOLD_ALIAS_SCOPE/)
  await hold(aliases[2], bound, context, /STRUCTURED_HOLD_ALIAS_SCOPE/)
  await hold(aliases[3], bound, context, /STRUCTURED_HOLD_ALIAS_SCOPE/)
  await pool.query('UPDATE durable_runtime.catalog_repositories SET payload=$2 WHERE id=$1', [repoId, { ...repo, executionHostId: 'runtime:synthetic-foreign' }])
  await hold(aliases[0], bound, context, /CATALOG_REGISTRATION_HOST_MISMATCH/)
  await pool.query('UPDATE durable_runtime.catalog_repositories SET payload=$2 WHERE id=$1', [repoId, repo])
  await pool.query('UPDATE durable_runtime.catalog_workspace_metadata SET payload=$2 WHERE workspace_id=$1', [workspaceId, { ...payload, hostId: 'runtime:synthetic-foreign' }])
  await hold(aliases[0], bound, context, /CATALOG_REGISTRATION_HOST_MISMATCH/)
  await pool.query('UPDATE durable_runtime.catalog_workspace_metadata SET payload=$2 WHERE workspace_id=$1', [workspaceId, payload])
  await pool.query('UPDATE durable_runtime.catalog_repositories SET deleted_at=clock_timestamp() WHERE id=$1', [repoId])
  await hold(aliases[0], bound, context, /CATALOG_REPOSITORY_UNAVAILABLE/)
  await pool.query('UPDATE durable_runtime.catalog_repositories SET deleted_at=NULL WHERE id=$1', [repoId])
  await hold()
  await pool.query('UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp() WHERE id=$1', [workspaceId])
  await hold(aliases[0], bound, context, /CATALOG_WORKSPACE_UNAVAILABLE/)
  enabled = false; await release(); await release()
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  assert.equal(ends, 0); assert.deepEqual(native.unexpected, [])
  for (const adapter of adapters) { adapter.dispose() }
  assert.equal(ends, 0)
})
