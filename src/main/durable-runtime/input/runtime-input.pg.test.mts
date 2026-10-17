import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {test} from 'node:test'
import {counter, logicalId} from '../../../shared/durable-runtime/identity.ts'
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

if (process.env.ORCA_TERMINAL_RUNTIME_DB !== 'orca_public_clipboard_20261014' ||
    process.env.PGDATABASE !== process.env.ORCA_TERMINAL_RUNTIME_DB) {
  throw new Error('Exact isolated Terminal runtime fixture database required')
}

// Real PG/production intake, stage, claim, driver parser and observation store;
// synthetic socket/controller/native transport/protection, never provider auth.
await test('committed Terminal execution keeps original lineage across close, replay and uncertainty', async t => {
  const pool = createDurablePool({max: 4})
  t.after(() => pool.end())
  const identity = (await pool.query(`SELECT current_database() AS name,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system,
    (SELECT dataset_name FROM durable_runtime.dataset_metadata) AS dataset,pg_backend_pid() AS pid`)).rows[0]
  assert.equal(identity.name, 'orca_public_clipboard_20261014')
  assert.equal(identity.oid, '80991')
  assert.equal(identity.system, '7696101282789175327')
  const ledger = (await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 19)
  t.diagnostic(JSON.stringify({phase: 'same-pool-identity', ...identity, ledger: ledger.length}))

  async function setup(unknown = false) {
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
    let nativeCalls = 0, handlers: CodexAppServerConnectionHandlers = {}, active: ReadyTerminalInputPort | null = null
    const notices: unknown[] = [], observations: ProviderObservation[] = [], commits: CommittedTerminalInput[] = []
    const coordinator = createTerminalInputRuntime(pool, {current: () => active}, n => notices.push(n))
    t.after(() => coordinator.dispose())
    const driver = new DurableCodexDriver({open: async (_launch, next) => {
      handlers = next
      return {pid: undefined, closed: false, notify() {}, respond() {}, respondWithError() {}, close: async () => true,
        request: async method => {
          if (method === 'thread/start') { return {thread: {id: `synthetic-thread:${sessionId}`}} }
          if (method === 'turn/start') { nativeCalls++; return unknown ? {} : {turn: {id: `synthetic-turn:${sessionId}`}} }
          return {}
        }}
    }, receiptWaitMs: 1}, observation => {observations.push(observation); coordinator.observe(observation)})
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
        return driver.dispatch(request, {invoke: async (_effect, work) => work()})
      }})
    const owner = new TerminalConnectionOwner(), device = randomUUID(), fingerprint = 'c'.repeat(64)
    owner.register('original', device)
    const socket = fixtureContext(fixtureRuntime().runtime, {pairedDeviceId: device,
      authenticatedCallerFingerprint: fingerprint, terminalInputConnection: owner.capture('original', device, fingerprint, () => true)})
    const config = captureDurableCatalogReadConfig({pool, datasetName: identity.dataset, hostId: 'local',
      readHostIdentity: () => 'local', repositoryIds: [], projectGroupIds: [group], workspacePublicIds: []})
    const handler = createCatalogTerminalSendRpc(config, input => {commits.push(input); coordinator.committed(input)})
    const key = randomUUID(), params = {terminal: f.terminalHandle, text: 'synthetic original runtime input', enter: true}
    const send = () => handler(params, {...socket, requestId: key}, () => {throw new Error('unexpected legacy')})
    await send()
    assert.equal(commits.length, 1)
    assert.equal(nativeCalls, 0, 'intake ACK cannot wait for READY or provider effect')
    return {coordinator, send, commits, notices, observations, sessionId, runtimeUnitId, operationId, originalOperation, tab,
      controller, get nativeCalls() {return nativeCalls}, start: () => {active = port; coordinator.ready()},
      close: () => owner.invalidate('original'), notify: (method: string, params: unknown) => handlers.onNotification?.(method, params),
      exit: () => handlers.onExit?.(new Error('synthetic connection loss'))}
  }

  const first = await setup()
  await first.send()
  assert.equal(first.commits.length, 1, 'receipt replay does not notify or dispatch')
  first.close()
  // Confirmed Chat input remains accepted after normal disconnect/UI changes.
  await pool.query("UPDATE durable_runtime.catalog_tab_metadata SET payload=jsonb_set(payload,'{viewMode}','\"terminal\"') WHERE tab_id=$1", [first.tab.id])
  await pool.query('UPDATE durable_runtime.tabs SET revision=revision+1 WHERE id=$1', [first.tab.id])
  first.start(); await first.coordinator.drain(); await first.coordinator.drain()
  assert.equal(first.nativeCalls, 1)
  assert.equal(first.observations[0].kind, 'ADMITTED')
  first.notify('turn/completed', {threadId: `synthetic-thread:${first.sessionId}`, turn: {id: `synthetic-turn:${first.sessionId}`, status: 'completed'}})
  await first.coordinator.drain()
  const stored = (await pool.query('SELECT intake_status FROM durable_runtime.messages WHERE session_id=$1', [first.sessionId])).rows
  assert.deepEqual(stored, [{intake_status: 'SETTLED'}])
  assert.ok(first.observations.find(o => o.kind === 'COMPLETED' && o.completed))
  first.coordinator.committed(first.commits[0]); await first.coordinator.drain()
  assert.equal(first.nativeCalls, 1)
  const other = createTerminalInputRuntime(pool, {current: () => null})
  t.after(() => other.dispose())
  // A new in-memory coordinator has no current real owner and cannot replay effects.
  other.committed(first.commits[0]); await other.drain()
  assert.equal(first.nativeCalls, 1)
  assert.deepEqual((await pool.query('SELECT to_jsonb(o) AS row FROM durable_runtime.operations o WHERE id=$1', [first.operationId])).rows[0].row, first.originalOperation)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM durable_runtime.operations WHERE runtime_unit_id=$1 AND kind='INPUT_DELIVERY'", [first.runtimeUnitId])).rows[0].n, 1)

  const lost = await setup(true)
  lost.start(); await lost.coordinator.drain(); await lost.coordinator.drain()
  assert.equal(lost.nativeCalls, 1)
  assert.ok(lost.observations.find(o => o.kind === 'UNKNOWN' && o.uncertainty))
  assert.equal((await pool.query("SELECT state FROM durable_runtime.delivery_attempts WHERE session_id=$1", [lost.sessionId])).rows[0].state, 'UNKNOWN')
  lost.coordinator.committed(lost.commits[0]); lost.coordinator.ready(); await lost.coordinator.drain()
  assert.equal(lost.nativeCalls, 1, 'UNKNOWN is retained, never automatically resent')

  const closed = await setup()
  await pool.query("UPDATE durable_runtime.tabs SET lifecycle='CLOSED' WHERE id=$1", [closed.tab.id])
  closed.start(); await closed.coordinator.drain()
  assert.equal(closed.nativeCalls, 0)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM durable_runtime.operations WHERE runtime_unit_id=$1 AND kind='INPUT_DELIVERY'", [closed.runtimeUnitId])).rows[0].n, 0)
  assert.equal((await pool.query('SELECT intake_status FROM durable_runtime.messages WHERE session_id=$1', [closed.sessionId])).rows[0].intake_status, 'DURABLE')
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
})
