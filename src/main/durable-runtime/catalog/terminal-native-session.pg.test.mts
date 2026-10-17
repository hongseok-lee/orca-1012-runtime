import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createDurablePool, withDurableTransaction, type DurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { ReadyProviderBinding } from '../providers/shared/contracts.ts'
import type { CatalogAuthority } from './authority.ts'
import { readCatalogSnapshot, resolveCatalogWorkspace, withCatalogReadSnapshot } from './read.ts'
import { projectCatalogTabs, readWorkspaceTabsInTransaction } from './projection.ts'
import { publishCatalogTerminalNativeSessionReady } from './terminal-native-session.ts'

// Real Catalog transactions; every provider/READY lineage below is synthetic.
// No production driver, authority, grant, lease or provider process is issued.
test('same-RR original READY identity, atomic head/hint, rollback and authorization', { concurrency: false }, async () => {
  assert.equal(process.env.PGDATABASE, 'orca_ops_resources_20261017')
  const pool = createDurablePool({ max: 4, application_name: 'terminal-native-identity-owned', statement_timeout: 15000 })
  const owner = `terminal-native-identity:${randomUUID()}`, workspace = logicalId('workspace', randomUUID())
  const bindings = [0, 1].map(() => ({ sessionId: logicalId('session', randomUUID()), tabId: logicalId('tab', randomUUID()),
    terminalHandle: `${owner}:${randomUUID()}`, providerBindingRevision: counter('row:provider-binding', '1'),
    runtimeUnitId: logicalId('runtime-unit', randomUUID()), attemptId: logicalId('attempt', randomUUID()),
    podUid: `synthetic-pod:${randomUUID()}`, executionEpoch: counter('execution-epoch', '1'),
    connectionInstanceId: `synthetic-connection:${randomUUID()}`,
    providerRef: { provider: 'codex', nativeSessionRef: `synthetic-thread:${randomUUID()}` }
  }) as ReadyProviderBinding)
  const operations = bindings.map(() => logicalId('operation', randomUUID()))
  const authority = { principalId: owner, repositoryIds: [], projectGroupIds: [owner], workspacePublicIds: [] } as unknown as CatalogAuthority
  const snapshot = () => readCatalogSnapshot(pool, authority)
  const workspaceTabs = async () => {
    const view = await snapshot(), found = view.workspaces.find(row => row.workspace_id === workspace)!
    return projectCatalogTabs(view, found)
  }
  const identity = (tabs: Awaited<ReturnType<typeof workspaceTabs>>, index = 0) => {
    const tab = tabs.tabs.find(row => row.id === bindings[index].terminalHandle)
    assert.ok(tab && tab.type === 'terminal'); return tab.nativeChatSession
  }
  async function ready(tx: DurableTransaction, index: number, revision = '1', publish = true) {
    const binding = bindings[index]
    await lockAggregates(tx, { sessionIds: [binding.sessionId], runtimeUnitIds: [binding.runtimeUnitId] })
    const event = { kind: 'INITIAL_PROVIDER_READY', attemptId: binding.attemptId, podUid: binding.podUid,
      executionEpoch: binding.executionEpoch, providerBindingRevision: revision,
      connectionInstanceId: binding.connectionInstanceId, providerRef: { ...binding.providerRef } }
    const audit = await appendAudit(tx, { actorId: owner, runtimeUnitId: binding.runtimeUnitId,
      operationId: operations[index], sessionId: binding.sessionId, kind: event.kind, nextState: event,
      occurredAt: new Date(), receivedAt: new Date(), producerId: randomUUID(),
      producerSeq: counter('sequence:producer', '1'), evidenceRefs: [] })
    await enqueueOutbox(tx, { eventId: logicalId('event', audit), aggregateId: binding.runtimeUnitId,
      aggregateKind: 'runtime-unit', revision: counter('row:runtime-unit', '1'), event })
    if (publish) { await publishCatalogTerminalNativeSessionReady(tx, audit, binding) }
  }
  try {
    const db = (await pool.query(`SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system`)).rows[0]
    assert.deepEqual(db, { oid: '98744', system: '7696101282789175327' })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM durable_runtime.schema_migrations')).rows[0].n, 23)
    await withDurableTransaction(pool, async tx => {
      await tx.query(`INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,$2,'READY')`, [workspace, owner])
      await tx.query(`INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)`, [owner, {
        id: owner, name: owner, createdFrom: 'manual', parentPath: null, parentGroupId: null, color: null,
        tabOrder: 0, createdAt: 0, updatedAt: 0, isCollapsed: false }])
      await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,project_group_id,reserved_path,payload,create_request)
        VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}')`, [workspace, owner, `/synthetic/${workspace}`, {
        id: owner, projectGroupId: owner, name: owner, folderPath: `/synthetic/${workspace}`, comment: '', createdAt: 0,
        updatedAt: 0, lastActivityAt: 0, sortOrder: 0, isArchived: false, isUnread: false, isPinned: false }])
      await tx.query(`INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)`, [`workspace:${workspace}`, owner])
      await tx.query(`INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$1,1,clock_timestamp())`, [owner])
      for (const [index, binding] of bindings.entries()) {
        const agent = randomUUID(), storage = randomUUID()
        await tx.query(`INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'codex')`, [agent])
        await tx.query(`INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle,provider_binding_revision) VALUES($1,$2,$3,'OPEN',1)`,
          [binding.sessionId, agent, workspace])
        await tx.query(`INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase,execution_epoch) VALUES($1,'SUSPENDED','ABSENT',1)`, [binding.runtimeUnitId])
        await tx.query(`INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)`, [binding.runtimeUnitId])
        await tx.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,resource_profile_revision,effective_resources,status,ready_at)
          VALUES($1,$2,1,'COLD',$3,0,'{}','STOPPED',clock_timestamp())`, [binding.attemptId, binding.runtimeUnitId, binding.podUid])
        await tx.query(`INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)`, [storage, owner])
        await tx.query(`INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state)
          VALUES($1,$1,$2,$3,'RO')`, [storage, owner, `/synthetic/${storage}`])
        await tx.query(`INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)`,
          [binding.runtimeUnitId, binding.sessionId, storage])
        await tx.query(`INSERT INTO durable_runtime.tabs(id,workspace_id,session_id,kind,terminal_handle,ui_order,lifecycle)
          VALUES($1,$2,$3,'terminal',$4,$5,'OPEN')`, [binding.tabId, workspace, binding.sessionId, binding.terminalHandle, index])
        await tx.query(`INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request) VALUES($1,$2,$3,'{}')`,
          [binding.tabId, binding.terminalHandle, { id: binding.terminalHandle, type: 'terminal', title: owner,
            isActive: index === 0, parentTabId: binding.terminalHandle, leafId: binding.terminalHandle,
            status: 'ready', terminal: binding.terminalHandle, viewMode: 'chat' }])
        await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch,result)
          VALUES($1,$2,'COLD_START',0,$3,1,'RELEASE_GATE',1,$4)`, [operations[index], binding.runtimeUnitId, owner,
          { state: 'SUCCEEDED', ready: true, providerBindings: [{ ...binding.providerRef }] }])
      }
    })
    const before = await snapshot(), heads = before.heads.filter(row => row.scope === 'catalog' || row.scope === `workspace:${workspace}`)
    assert.equal(identity(await workspaceTabs()), undefined)
    await assert.rejects(withDurableTransaction(pool, async tx => { await ready(tx, 0); throw new Error('SYNTHETIC_ROLLBACK') }), /SYNTHETIC_ROLLBACK/)
    assert.deepEqual((await snapshot()).heads.filter(row => heads.some(head => row.scope === head.scope)), heads)
    assert.equal(identity(await workspaceTabs()), undefined)
    await withDurableTransaction(pool, tx => ready(tx, 1, '0', false))
    assert.equal(identity(await workspaceTabs(), 1), undefined)
    await withCatalogReadSnapshot(pool, async tx => {
      const found = await resolveCatalogWorkspace(tx, owner, authority)
      assert.equal(identity(await readWorkspaceTabsInTransaction(tx, found)), undefined)
      await withDurableTransaction(pool, write => ready(write, 0))
      assert.equal(identity(await readWorkspaceTabsInTransaction(tx, found)), undefined)
    })
    const after = await snapshot(), tabs = await workspaceTabs()
    assert.deepEqual(identity(tabs), { agent: 'codex', sessionId: bindings[0].providerRef.nativeSessionRef })
    assert.equal(identity(tabs, 1), undefined)
    for (const head of heads) {
      assert.equal(after.heads.find(row => row.scope === head.scope)?.revision, (BigInt(head.revision) + 1n).toString())
    }
    await withCatalogReadSnapshot(pool, async tx => {
      assert.deepEqual(identity(await readWorkspaceTabsInTransaction(tx, await resolveCatalogWorkspace(tx, owner, authority))), identity(tabs))
    })
    const denied = await readCatalogSnapshot(pool, { ...authority, projectGroupIds: [] })
    assert.equal(denied.workspaces.some(row => row.workspace_id === workspace), false)
    assert.equal(denied.tabs.some(row => row.tab_id === bindings[0].tabId), false)
    const hints = await pool.query(`SELECT event FROM durable_runtime.outbox_events WHERE aggregate_kind='catalog' AND aggregate_id=$1`, [workspace])
    assert.equal(hints.rows.length, 1); assert.equal(hints.rows[0].event.kind, 'CATALOG_TERMINAL_NATIVE_SESSION_READY')
    const stored = await pool.query(`SELECT payload FROM durable_runtime.catalog_tab_metadata WHERE tab_id=ANY($1::uuid[])`, [bindings.map(binding => binding.tabId)])
    assert.ok(stored.rows.every(row => !Object.hasOwn(row.payload, 'nativeChatSession') && !Object.hasOwn(row.payload, 'agentStatus')))
    console.log(JSON.stringify({ phase: 'TERMINAL_NATIVE_IDENTITY_PG_COMPLETE', owner, syntheticReady: true, originalMetadataUntouched: true,
      actualProvider: false, schemaApplied: 0, authorityIssued: 0 }))
  } finally { await pool.end() }
})
