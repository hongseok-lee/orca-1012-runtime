import {RuntimeSubscriptionRegistry} from '../../runtime/runtime-subscription-registry.ts'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import test from 'node:test'
import {counter,logicalId} from '../../../shared/durable-runtime/identity.ts'
import {applyMigrations,readMigrations} from '../db/migrate.ts'
import {createDurablePool,withDurableTransaction} from '../db/connection.ts'
import {fixture} from '../input/verification-fixtures.mts'
import {fixtureContext,fixtureRuntime} from './fixture-support.mts'
import {captureDurableCatalogReadConfig} from './config.ts'
import type {VerifiedControllerIdentity} from '../runtime/gateway/types.ts'
import type {PodUid} from '../runtime/runtime-evidence.ts'
import {createCatalogTerminalDisplay} from './terminal-display.ts'
import {createAgentControlJournal} from '../runtime/agent-control-journal.ts'
import {createCatalogTerminalLeaseSubscribe} from './terminal-lease-subscribe.ts'
import type {RuntimeTerminalRead} from '../../../shared/runtime-types.ts'
if(process.env.PGDATABASE!=='orca_terminal_task05_20261019') {throw new Error('Owned task05 database required')}
test('retained display survives absent runtime, preserves UTF-8/cursor, and clears display only',async()=>{
  const pool=createDurablePool({max:4})
  try {
    await applyMigrations(pool,await readMigrations(process.env.ORCA_TERMINAL_TEST_MIGRATIONS!))
    const f = await fixture(pool, 'RUNNING'), sessionId = f.request.authority.sessionId
    const runtimeUnitId = logicalId('runtime-unit', f.unitId), operationId = logicalId('operation', randomUUID())
    const attemptId = logicalId('attempt', randomUUID()), podUid = `synthetic-runtime-${attemptId}` as PodUid
    const controller = {scope: `synthetic-input-controller:${operationId}`, owner: 'synthetic-input-owner',
      term: counter('controller-term', '1')} as VerifiedControllerIdentity
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
    const controlId=(await pool.query('SELECT control_id FROM durable_runtime.agent_control_hosts WHERE attempt_id=$1',[attemptId])).rows[0].control_id
    const incarnationId=randomUUID(),journal=createAgentControlJournal(pool,podUid),display=createCatalogTerminalDisplay(config)
    const legacy=():never=>{throw new Error('unexpected legacy')}
    const read=async(cursor?:number)=>(await display('terminal.read',{terminal:f.terminalHandle,cursor},rpc,legacy) as {terminal:RuntimeTerminalRead}).terminal
    let seq=0,byte=0
    const output=async(bytes:Buffer)=>{await journal.record(controlId,{hostSeq:++seq,controlId,event:'PTY_OUTPUT',incarnationId,startByte:byte,endByte:byte+bytes.length,bytes:bytes.toString('base64')});byte+=bytes.length}
    await output(Buffer.from('first\n'))
    const unicode=Buffer.from('한글\n')
    await output(unicode.subarray(0,2))
    const first=await read(0);assert.deepEqual(first.tail,['first']);assert.equal(first.nextCursor,'1')
    await output(unicode.subarray(2))
    await pool.query("UPDATE durable_runtime.runtime_units SET phase='ABSENT' WHERE id=$1",[runtimeUnitId])
    const absent=await read(1);assert.deepEqual(absent.tail,['한글']);assert.equal(absent.nextCursor,'2')
    const foreign=createCatalogTerminalDisplay({...config,projectGroupIds:[]})
    await assert.rejects(foreign('terminal.read',{terminal:f.terminalHandle},rpc,legacy),/selector_not_found/)
    const before=(await pool.query('SELECT count(*)::int AS n FROM durable_runtime.agent_control_frames WHERE control_id=$1',[controlId])).rows[0].n
    assert.deepEqual(await display('terminal.clearBuffer',{terminal:f.terminalHandle},rpc,legacy),{clear:{handle:f.terminalHandle,cleared:true}})
    const cleared=await read(0);assert.deepEqual(cleared.tail,[]);assert.equal(cleared.nextCursor,'2');assert.equal(cleared.truncated,true)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM durable_runtime.agent_control_frames WHERE control_id=$1',[controlId])).rows[0].n,before)
    await output(Buffer.from('later\n'))
    assert.deepEqual((await read(2)).tail,['later'])
    await assert.rejects(display('terminal.read',{terminal:f.terminalHandle,screen:true},rpc,legacy),/TERMINAL_SCREEN_SNAPSHOT_UNAVAILABLE/)
    const abort=new AbortController(),frames:unknown[]=[],registry=new RuntimeSubscriptionRegistry()
    const lease=createCatalogTerminalLeaseSubscribe(config,()=>{throw new Error('lease must not look up runtime')})
    const held=lease({terminal:f.terminalHandle,client:{id:'phone',type:'mobile'},capabilities:{mobileInputLeaseOnly:1}},
      {...rpc,signal:abort.signal,runtime:{registerOwnedSubscriptionCleanup:registry.registerOwned.bind(registry)} as typeof rpc.runtime},frame=>{frames.push(frame);if((frame as {type:string}).type==='subscribed') {abort.abort()}},legacy)
    await held
    assert.deepEqual(frames.map(frame=>(frame as {type:string}).type),['subscribed','end'])
    for(let i=0;i<130;i++) { await output(Buffer.from('x\n')) }
    const batched=await read(3);assert.equal(batched.tail.length,130);assert.equal(batched.nextCursor,'133')
    await pool.query("INSERT INTO durable_runtime.agent_control_resyncs(control_id,through_seq,missing_kind,snapshot) VALUES($1,$2,'UNKNOWN','{}')",[controlId,seq+1])
    await pool.query('UPDATE durable_runtime.agent_control_cursors SET last_seq=$2 WHERE control_id=$1',[controlId,seq+1])
    await assert.rejects(read(133),/TERMINAL_RETAINED_OUTPUT_GAP/)

  } finally {await pool.end()}
})
