import { createTerminalRawSubscriptions } from './terminal-raw-subscriptions.ts'
import { createCatalogTerminalSendRpc } from './terminal-send.ts'
import { createCatalogTerminalActions } from './terminal-runtime-actions.ts'
import { TerminalConnectionOwner } from '../../runtime/rpc/terminal-connection-owner.ts'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
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
    let calls = 0, writes = 0, loseResponse = false
    const incarnationId = randomUUID()
    const port = { binding: { sessionId, tabId: tab.id, terminalHandle: f.terminalHandle, providerBindingRevision: '0',
      runtimeUnitId, attemptId, podUid, executionEpoch: '1', connectionInstanceId: 'synthetic-connection' }, context, executorId,
      terminal: { supported: () => true, request: async (method: string, params?: Record<string, unknown>) => {
        if (method === 'PTY_WRITE') {
          writes++
          if (loseResponse) { throw new Error('synthetic response loss after effect') }
          return { incarnationId, status: 'WRITTEN', bytesWritten: Buffer.from(String(params?.bytes), 'base64').length }
        }
        if (method === 'PTY_RESIZE') { return { resized: true } }
        calls++; return { live: true }
      } }
    } as unknown as ReadyTerminalInputPort
    const reader = createCatalogTerminalRuntimeReader(config,rpc,f.terminalHandle,target,()=>port)
    assert.deepEqual(await reader.status(),{ live: true })
    assert.equal(calls,1)
    const foreign = createCatalogTerminalRuntimeReader({...config,projectGroupIds:[]},rpc,f.terminalHandle,target,()=>port)
    await assert.rejects(foreign.status(),/selector_not_found/)
    assert.equal(calls,1)
    const owner = new TerminalConnectionOwner(), device = randomUUID()
    owner.register('raw-connection', device)
    const inputRpc = { ...rpc, pairedDeviceId: device, terminalInputConnection: owner.capture('raw-connection',device,rpc.authenticatedCallerFingerprint!,()=>true) }
    let lostFloorCommit = false
    const lossy = new Proxy(pool, { get(owner, key) {
      if (key === 'connect') { return async () => {
        const client = await owner.connect()
        let changedFloor = false
        return new Proxy(client, { get(target, property) {
          if (property === 'query') { return async (...args: unknown[]) => {
            const sql = String(args[0])
            if (sql.includes('INSERT INTO durable_runtime.terminal_input_floors')) { changedFloor = true }
            const result = await Reflect.apply(target.query,target,args)
            if (sql === 'COMMIT' && changedFloor && !lostFloorCommit) {
              lostFloorCommit = true
              throw Object.assign(new Error('synthetic lost floor COMMIT response'),{code:'08006'})
            }
            return result
          } }
          const value = Reflect.get(target,property)
          return typeof value === 'function' ? value.bind(target) : value
        } })
      } }
      const value = Reflect.get(owner,key)
      return typeof value === 'function' ? value.bind(owner) : value
    } }) as Pool
    const actions = createCatalogTerminalActions({...config,pool:lossy},inputRpc,f.terminalHandle,target,()=>port)
    const bytes = Buffer.from('one command\r')
    const sent = await actions.write(incarnationId,bytes,'one')
    assert.deepEqual(sent,{status:'WRITTEN',bytesWritten:bytes.length})
    assert.deepEqual(await actions.write(incarnationId,bytes,'one'),sent)
    assert.equal(writes,1)
    assert.equal(lostFloorCommit,true)
    await assert.rejects(actions.write(incarnationId,Buffer.from('different'),'one'),/TERMINAL_RAW_REQUEST_CONFLICT/)
    const beforeResize = (await pool.query('SELECT floor_generation,revision FROM durable_runtime.terminal_input_floors WHERE terminal_handle=$1',[f.terminalHandle])).rows[0]
    await actions.resize(incarnationId,91,37,'resize')
    assert.deepEqual((await pool.query('SELECT floor_generation,revision FROM durable_runtime.terminal_input_floors WHERE terminal_handle=$1',[f.terminalHandle])).rows[0],beforeResize)
    loseResponse=true
    assert.deepEqual(await actions.write(incarnationId,bytes,'lost'),{status:'UNKNOWN',bytesWritten:0})
    assert.deepEqual(await actions.write(incarnationId,bytes,'lost'),{status:'UNKNOWN',bytesWritten:0})
    assert.equal(writes,2)
    const observations = (await pool.query('SELECT state,bytes_written FROM durable_runtime.terminal_raw_observations WHERE session_id=$1 ORDER BY created_at',[sessionId])).rows
    assert.deepEqual(observations,[{state:'WRITTEN',bytes_written:bytes.length},{state:'UNKNOWN',bytes_written:0}])
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM durable_runtime.messages WHERE session_id=$1',[sessionId])).rows[0].n,0)
    loseResponse=false
    const otherDevice = randomUUID()
    owner.register('other-connection',otherDevice)
    const otherRpc = { ...rpc, pairedDeviceId: otherDevice, terminalInputConnection: owner.capture('other-connection',otherDevice,rpc.authenticatedCallerFingerprint!,()=>true) }
    const otherActions = createCatalogTerminalActions(config,otherRpc,f.terminalHandle,target,()=>port)
    await otherActions.write(incarnationId,bytes,'other')
    assert.equal(writes,3)
    const otherFloor = (await pool.query('SELECT connection_id,floor_generation,revision FROM durable_runtime.terminal_input_floors WHERE terminal_handle=$1',[f.terminalHandle])).rows[0]
    assert.deepEqual(await actions.write(incarnationId,bytes,'one'),sent)
    await assert.rejects(actions.write(incarnationId,Buffer.from('\x1b[?1;2c'),'query'),/TERMINAL_QUERY_REPLY_NOT_OWNER/)
    assert.deepEqual((await pool.query('SELECT connection_id,floor_generation,revision FROM durable_runtime.terminal_input_floors WHERE terminal_handle=$1',[f.terminalHandle])).rows[0],otherFloor)
    assert.equal(writes,3)

    const raw = createTerminalRawSubscriptions()
    const detach = raw.attach(f.terminalHandle,inputRpc,incarnationId,actions)
    const send = createCatalogTerminalSendRpc(config,undefined,raw)
    const unaryContext = { ...inputRpc, requestId: 'raw-unary-one' }
    const result = await send({ terminal:f.terminalHandle, text:'hello', enter:true, expectedIncarnationId:incarnationId },unaryContext,()=>{throw new Error('legacy raw escape')})
    assert.deepEqual(result,{send:{handle:f.terminalHandle,accepted:true,bytesWritten:6}})
    assert.equal(writes,4)
    await assert.rejects(send({ terminal:f.terminalHandle, text:'no', expectedIncarnationId:randomUUID() },{...unaryContext,requestId:'stale'},()=>{}),/TERMINAL_RAW_INCARNATION_CHANGED/)
    detach()
    await assert.rejects(send({ terminal:f.terminalHandle, text:'no' },{...unaryContext,requestId:'detached'},()=>{}),/TERMINAL_RAW_SUBSCRIPTION_REQUIRED/)
    const rawFloor = (await pool.query('SELECT floor_generation FROM durable_runtime.terminal_input_floors WHERE terminal_handle=$1',[f.terminalHandle])).rows[0].floor_generation
    await pool.query("UPDATE durable_runtime.catalog_tab_metadata SET payload=jsonb_set(payload,'{viewMode}','\"chat\"') WHERE tab_id=$1",[tab.id])
    const chat = await send({terminal:f.terminalHandle,text:'explicit Chat input',enter:true},{...unaryContext,requestId:'chat-mode'},()=>{})
    assert.deepEqual(chat,{send:{handle:f.terminalHandle,accepted:true,bytesWritten:0}})
    assert.equal(writes,4)
    await pool.query("UPDATE durable_runtime.catalog_tab_metadata SET payload=jsonb_set(payload,'{viewMode}','\"terminal\"') WHERE tab_id=$1",[tab.id])
    await actions.write(incarnationId,Buffer.from('back to raw'),'raw-again')
    assert.equal(writes,5)
    const restoredFloor = (await pool.query('SELECT mode,floor_generation FROM durable_runtime.terminal_input_floors WHERE terminal_handle=$1',[f.terminalHandle])).rows[0]
    assert.equal(restoredFloor.mode,'RAW_TERMINAL')
    assert.equal(BigInt(restoredFloor.floor_generation),BigInt(rawFloor)+2n)
    actions.close()
    assert.throws(()=>actions.write(incarnationId,bytes,'closed'),/TERMINAL_AUTHENTICATED_CONNECTION_REQUIRED/)
    assert.equal(writes,5)
    await pool.query("UPDATE durable_runtime.controller_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE scope=$1",[controller.scope])
    await assert.rejects(reader.status(),/TERMINAL_RUNTIME_UNAVAILABLE/)
    assert.equal(calls,1)
    await pool.query("UPDATE durable_runtime.controller_leases SET expires_at=clock_timestamp()+interval '15 minutes' WHERE scope=$1",[controller.scope])
    await pool.query("UPDATE durable_runtime.runtime_units SET phase='ABSENT' WHERE id=$1",[runtimeUnitId])
    await assert.rejects(reader.status(),/TERMINAL_RUNTIME_UNAVAILABLE/)
    assert.equal(calls,1)
  } finally { await pool.end() }
})
