import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {test} from 'node:test'
import {counter, logicalId} from '../../../shared/durable-runtime/identity.ts'
import {applyMigrations,readMigrations} from '../db/migrate.ts'
import {createDurablePool, runDurableTransaction, withDurableTransaction} from '../db/connection.ts'
import {lockAggregates} from '../db/locks.ts'
import {fixture} from './verification-fixtures.mts'
import {createTerminalInputRuntime} from './runtime-input.ts'
import type {CommittedTerminalInput, ReadyTerminalInputPort} from './runtime-input-types.ts'
import {captureDurableCatalogReadConfig} from '../rpc/config.ts'
import {createCatalogTerminalSendRpc} from '../rpc/terminal-send.ts'
import {fixtureContext, fixtureRuntime} from '../rpc/fixture-support.mts'
import {TerminalConnectionOwner} from '../../runtime/rpc/terminal-connection-owner.ts'
import {DurableCodexDriver} from '../providers/codex/driver.ts'
import type {CodexAppServerConnectionHandlers} from '../../codex/codex-app-server-connection-types.ts'
import type {GatewayContext, VerifiedControllerIdentity, ExecutorId} from '../runtime/gateway/types.ts'
import type {ProviderBinding, ProviderObservation} from '../providers/shared/contracts.ts'
import type {PodUid} from '../runtime/runtime-evidence.ts'

import {createProviderCancelRuntime} from './runtime-cancel.ts'
import {assertProviderCancelTarget} from '../runtime/provider-cancel-target.ts'
if(process.env.PGDATABASE!=='orca_terminal_task05_20261019') {throw new Error('Owned task05 database required')}
await test('legacy Stop pins pending and native targets; runtime uses one committed cancel command',async t=>{
  const pool=createDurablePool({max:6})
  t.after(()=>pool.end())
  await applyMigrations(pool,await readMigrations(process.env.ORCA_TERMINAL_TEST_MIGRATIONS!))
  const identity={dataset:'orca-1012-dev-v1'}
  async function setup(unknown = false, refuseBeforeEffect = false) {
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
      parentTabId: 'synthetic-parent', leafId: 'synthetic-leaf', status: 'ready', terminal: f.terminalHandle, viewMode: 'chat'}
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
    const originalOperation = (await pool.query('SELECT to_jsonb(o) AS row FROM durable_runtime.operations o WHERE id=$1', [operationId])).rows[0].row
    let nativeCalls = 0, interrupts = 0, handlers: CodexAppServerConnectionHandlers = {}, active: ReadyTerminalInputPort | null = null
    const notices: unknown[] = [], observations: ProviderObservation[] = [], commits: CommittedTerminalInput[] = []
    const coordinator = createTerminalInputRuntime(pool, {current: () => active}, n => notices.push(n))
    t.after(() => coordinator.dispose())
    const driver = new DurableCodexDriver({open: async (_launch, next) => {
      handlers = next
      return {pid: 424242, closed: false, notify() {}, respond() {}, respondWithError() {}, close: async () => true,
        request: async method => {
          if (method === 'thread/start') { return {thread: {id: `synthetic-thread:${sessionId}`}} }
          if (method === 'turn/interrupt') { interrupts++; handlers.onNotification?.('turn/completed',{threadId:`synthetic-thread:${sessionId}`,turn:{id:`synthetic-turn:${sessionId}${nativeCalls===1?'':`:${nativeCalls}`}`,status:'interrupted'}}); return {} }
          if (method === 'turn/start') { nativeCalls++; return unknown ? {} : {turn: {id: `synthetic-turn:${sessionId}${nativeCalls === 1 ? '' : `:${nativeCalls}`}`}} }
          return {}
        }}
    }, receiptWaitMs: 1, capture: async()=>({synthetic:true}), terminate: async()=>true}, observation => {observations.push(observation); coordinator.observe(observation)})
    const binding: ProviderBinding = {sessionId, tabId: logicalId('tab', tab.id), terminalHandle: f.terminalHandle,
      providerBindingRevision: counter('row:provider-binding', '0'), runtimeUnitId, attemptId, podUid,
      executionEpoch: counter('execution-epoch', '1'), connectionInstanceId: driver.connectionInstanceId}
    // Only a synthetic transport starts; this fixture cannot issue native/provider I/O.
    const fakeClaim = {visibility: 'TRANSACTION_LOCAL', commandId: randomUUID(), identity: {},
      executorId, executionToken: randomUUID(), controllerTerm: controller.term} as never
    const ready = await driver.cold({mode: 'COLD', binding, native: {kind: 'NEW'}, persistentHome: '/synthetic/home',
      checkout: '/synthetic/checkout', launch: {command: 'never-executed', args: [], options: {}}}, fakeClaim,
    {invoke: async (_effect, work) => work()})
    const port: ReadyTerminalInputPort = Object.freeze({binding: ready, context, executorId,
      cancelTarget: driver.cancelTarget.bind(driver),
      cancel: async (cancelContext,target,claim,guard) => driver.cancel(target,claim,{invoke:async (effect,work)=>{
        // Real PG command/intent gate; physical permit is synthetic in this fixture.
        await withDurableTransaction(pool,async tx=>{
          await lockAggregates(tx,{sessionIds:[sessionId],runtimeUnitIds:[runtimeUnitId]})
          await guard(tx)
          const row=(await tx.query('SELECT state,command_name,input FROM durable_runtime.runtime_commands WHERE id=$1',[claim.commandId])).rows[0]
          assert.equal(row.state,'EXECUTING'); assert.equal(row.command_name,'cancel')
          await assertProviderCancelTarget(tx,effect,row.input)
        })
        assert.notEqual(cancelContext.operationId,operationId)
        return work()
      }}),
      dispatch: async (deliveryContext, request, guard) => {
        // Enforce both preceding actual PG COMMITs before the fake native effect.
        const state = (await pool.query(`SELECT c.state,d.state AS delivery_state,
          (SELECT state FROM durable_runtime.runtime_commands WHERE operation_id=c.operation_id AND command_name='stageInput') AS stage_state
          FROM durable_runtime.runtime_commands c JOIN durable_runtime.delivery_attempts d ON d.id=$2 WHERE c.id=$1`,
        [request.commandClaim.commandId, request.deliveryAttemptId])).rows[0]
        assert.deepEqual(state, {state: 'EXECUTING', delivery_state: 'EFFECT_POSSIBLE', stage_state: 'RESOLVED'})
        const guarded = await runDurableTransaction(pool, async tx => {
          await lockAggregates(tx, {sessionIds: [sessionId], runtimeUnitIds: [runtimeUnitId]})
          await guard(tx)
        })
        assert.equal(guarded.ok, true)
        assert.notEqual(deliveryContext.operationId, operationId)
        return driver.dispatch(request, {invoke: async (_effect, work) => {
          if (refuseBeforeEffect) { throw new Error('synthetic permit rejected before native callback') }
          return work()
        }})
      }})
    const owner = new TerminalConnectionOwner(), device = randomUUID(), fingerprint = 'c'.repeat(64)
    owner.register('original', device)
    const socket = fixtureContext(fixtureRuntime().runtime, {pairedDeviceId: device,
      authenticatedCallerFingerprint: fingerprint, terminalInputConnection: owner.capture('original', device, fingerprint, () => true)})
    const config = captureDurableCatalogReadConfig({pool, datasetName: identity.dataset, hostId: 'local',
      readHostIdentity: () => 'local', repositoryIds: [], projectGroupIds: [group], workspacePublicIds: []})
    const cancellation=createProviderCancelRuntime(pool,()=>active,code=>notices.push({phase:'CANCEL_ERROR',code}))
    t.after(()=>cancellation.close())
    const handler = createCatalogTerminalSendRpc(config, input => {commits.push(input); coordinator.committed(input)},undefined,cancellation.notify)
    const stop=()=>handler({terminal:f.terminalHandle,text:'\x1b'}, {...socket,requestId:randomUUID()},()=>{throw new Error('legacy escape')})
    const key = randomUUID(), params = {terminal: f.terminalHandle, text: 'synthetic original runtime input', enter: true}
    const send = () => handler(params, {...socket, requestId: key}, () => {throw new Error('unexpected legacy')})
    const sendNew = (text: string) => handler({...params, text}, {...socket, requestId: randomUUID()}, () => {throw new Error('unexpected legacy')})
    await send()
    assert.equal(commits.length, 1)
    assert.equal(nativeCalls, 0, 'intake ACK cannot wait for READY or provider effect')
    return {coordinator, cancellation, stop, get interrupts(){return interrupts}, send, sendNew, commits, notices, observations, sessionId, runtimeUnitId, operationId, originalOperation, tab,
      controller, get nativeCalls() {return nativeCalls}, start: () => {active = port; coordinator.ready()},
      close: () => owner.invalidate('original'), notify: (method: string, params: unknown) => handlers.onNotification?.(method, params),
      exit: () => handlers.onExit?.(new Error('synthetic connection loss'))}
  }

  const pending=await setup()
  await pending.stop(); await pending.cancellation.drain()
  assert.equal(pending.nativeCalls,0)
  assert.equal((await pool.query('SELECT intake_status FROM durable_runtime.messages WHERE session_id=$1',[pending.sessionId])).rows[0].intake_status,'CANCELLED')
  await pending.sendNew('later input must survive duplicate Escape')
  await pending.stop(); await pending.cancellation.drain()
  const states=(await pool.query('SELECT intake_status FROM durable_runtime.messages WHERE session_id=$1 ORDER BY accepted_at',[pending.sessionId])).rows.map(r=>r.intake_status)
  assert.deepEqual(states,['CANCELLED','DURABLE'])
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM durable_runtime.cancel_intents WHERE session_id=$1',[pending.sessionId])).rows[0].n,1)

  const active=await setup()
  active.start(); await active.coordinator.drain(); await active.coordinator.drain()
  assert.equal(active.nativeCalls,1)
  await active.stop(); await active.cancellation.drain(); await active.coordinator.drain()
  assert.equal(active.interrupts,1,JSON.stringify(active.notices))
  assert.equal((await pool.query('SELECT intake_status FROM durable_runtime.messages WHERE session_id=$1',[active.sessionId])).rows[0].intake_status,'INTERRUPTED',JSON.stringify(active.notices))
  assert.equal((await pool.query('SELECT interrupt_status FROM durable_runtime.cancel_intents WHERE session_id=$1',[active.sessionId])).rows[0].interrupt_status,'CONFIRMED')
  await active.stop(); await active.cancellation.sweep(); await active.cancellation.drain()
  assert.equal(active.interrupts,1)
  const commands=(await pool.query("SELECT c.state FROM durable_runtime.runtime_commands c JOIN durable_runtime.operations o ON o.id=c.operation_id WHERE o.runtime_unit_id=$1 AND c.command_name='cancel'",[active.runtimeUnitId])).rows
  assert.deepEqual(commands,[{state:'RESOLVED'}])
  assert.equal(active.notices.some(n=>!!n && typeof n==='object' && 'phase' in n && n.phase==='CANCEL_ERROR'),false,JSON.stringify(active.notices))
})
