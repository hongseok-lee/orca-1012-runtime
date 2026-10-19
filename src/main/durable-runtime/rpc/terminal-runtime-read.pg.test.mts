import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { applyMigrations, readMigrations } from '../db/migrate.ts'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { fixture } from '../input/verification-fixtures.mts'
import { fixtureContext, fixtureRuntime } from './fixture-support.mts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { resolveCatalogTerminalTarget } from './terminal-target.ts'
import { createCatalogTerminalRuntimeReader } from './terminal-runtime-read.ts'
import type { ReadyTerminalInputPort } from '../input/runtime-input-types.ts'
import type { GatewayContext, VerifiedControllerIdentity, ExecutorId } from '../runtime/gateway/types.ts'
import type { PodUid } from '../runtime/runtime-evidence.ts'
if (process.env.PGDATABASE !== 'orca_terminal_task05_20261019') { throw new Error('Owned task05 database required') }
test('Catalog PTY reads require current scoped execution and reject changed authority before private dispatch', async () => {
  const pool = createDurablePool({ max: 4 })
  try {
    await applyMigrations(pool, await readMigrations(process.env.ORCA_TERMINAL_TEST_MIGRATIONS!))
    const f = await fixture(pool, 'RUNNING'), sessionId = f.request.authority.sessionId
    const runtimeUnitId = logicalId('runtime-unit', f.unitId), operationId = logicalId('operation', randomUUID())
    const attemptId = logicalId('attempt', randomUUID()), podUid = `synthetic-runtime-${attemptId}` as PodUid
    const controller = {scope: `synthetic-input-controller:${operationId}`, owner: 'synthetic-input-owner',
      term: counter('controller-term', '1')} as VerifiedControllerIdentity
    const context: GatewayContext = Object.freeze({runtimeUnitId, operationId, controller})
    const executorId = 'synthetic-original-executor' as ExecutorId
    const tab = (await pool.query('SELECT * FROM durable_runtime.tabs WHERE terminal_handle=$1', [f.terminalHandle])).rows[0]
    const group = `terminal-runtime:${randomUUID()}`
    const payload = {id: `tab:${randomUUID()}`, type: 'terminal', title: 'synthetic runtime Chat', isActive: true,
      parentTabId: 'synthetic-parent', leafId: 'synthetic-leaf', status: 'ready', terminal: f.terminalHandle, viewMode: 'terminal'}
    await withDurableTransaction(pool, async tx => {
      await tx.query("UPDATE durable_runtime.agents SET provider='codex' WHERE id=(SELECT agent_id FROM durable_runtime.sessions WHERE id=$1)", [sessionId])
      await tx.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [group, {id: group}])
      await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata
        (workspace_id,kind,project_group_id,reserved_path,payload,create_request,runtime_unit_id)
        VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}',$5)`, [tab.workspace_id, group, `/synthetic/runtime/${group}`,
        {id: tab.workspace_id, projectGroupId: group, name: 'Runtime fixture', folderPath: `/synthetic/runtime/${group}`,
          comment: '', createdAt: 1, updatedAt: 1, lastActivityAt: 1, sortOrder: 0, isArchived: false, isUnread: false, isPinned: false, executionHostId: 'local'}, runtimeUnitId])
      await tx.query("INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request) VALUES($1,$2,$3,'{}')", [tab.id, payload.id, payload])
      await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)", [runtimeUnitId])
      await tx.query("UPDATE durable_runtime.runtime_units SET execution_epoch=1,phase='READY',intent_revision=1 WHERE id=$1", [runtimeUnitId])
      await tx.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status)
        VALUES($1,$2,1,'COLD',$3,'synthetic-input-runtime',0,'{}','READY')`, [attemptId, runtimeUnitId, podUid])
      await tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1', [runtimeUnitId, attemptId])
      await tx.query("INSERT INTO durable_runtime.execution_grants(id,runtime_unit_id,attempt_id,execution_epoch,state) VALUES($1,$2,$3,1,'ACTIVE')", [randomUUID(), runtimeUnitId, attemptId])
      await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '15 minutes')", [controller.scope, controller.owner])
      await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,step_revision,expected_pod_uid,execution_epoch)
        VALUES($1,$2,'ENSURE_RUNNING',1,$3,1,'INPUT',0,$4,1)`, [operationId, runtimeUnitId, controller.scope, podUid])
    })
    await pool.query(`INSERT INTO durable_runtime.agent_control_hosts
      (attempt_id,runtime_unit_id,session_id,provider,pod_uid,control_id,control_pid,control_start_ticks,root_device,root_inode,connection_instance_id)
      VALUES($1,$2,$3,'codex',$4,$5,42,'1','1','1','synthetic-connection')`, [attemptId,runtimeUnitId,sessionId,podUid,randomUUID()])
    const config = captureDurableCatalogReadConfig({ pool, datasetName: 'orca-1012-dev-v1', hostId: 'local',
      readHostIdentity: () => 'local', repositoryIds: [], projectGroupIds: [group], workspacePublicIds: [] })
    const rpc = fixtureContext(fixtureRuntime().runtime)
    const target = await withDurableTransaction(pool, tx => resolveCatalogTerminalTarget(tx,config,rpc,f.terminalHandle,()=>{}))
    assert.ok(target)
    let calls = 0
    const port = { binding: { sessionId, tabId: tab.id, terminalHandle: f.terminalHandle, providerBindingRevision: '0',
      runtimeUnitId, attemptId, podUid, executionEpoch: '1', connectionInstanceId: 'synthetic-connection' }, context, executorId,
      terminal: { supported: () => true, request: async () => { calls++; return { live: true } } }
    } as unknown as ReadyTerminalInputPort
    const reader = createCatalogTerminalRuntimeReader(config,rpc,f.terminalHandle,target,()=>port)
    assert.deepEqual(await reader.status(),{ live: true })
    assert.equal(calls,1)
    const foreign = createCatalogTerminalRuntimeReader({...config,projectGroupIds:[]},rpc,f.terminalHandle,target,()=>port)
    await assert.rejects(foreign.status(),/selector_not_found/)
    assert.equal(calls,1)
    await pool.query("UPDATE durable_runtime.controller_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE scope=$1",[controller.scope])
    await assert.rejects(reader.status(),/TERMINAL_RUNTIME_UNAVAILABLE/)
    assert.equal(calls,1)
    await pool.query("UPDATE durable_runtime.controller_leases SET expires_at=clock_timestamp()+interval '15 minutes' WHERE scope=$1",[controller.scope])
    await pool.query("UPDATE durable_runtime.runtime_units SET phase='ABSENT' WHERE id=$1",[runtimeUnitId])
    await assert.rejects(reader.status(),/TERMINAL_RUNTIME_UNAVAILABLE/)
    assert.equal(calls,1)
  } finally { await pool.end() }
})
