import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { applyMigrations, readMigrations } from '../db/migrate.ts'
import { seedWriterLifecycle } from './writer-lifecycle-fixtures.mts'
import { reconcileOrphanedAttempt, observeAgentPod } from './orphan-reconcile.ts'
import { api, terminalPod } from './agent-pod-stop-fixtures.mts'
import { harness } from './kubernetes-pod-auth-fixtures.mts'
import { fixture, stoppedMetadataAttempt, activity, policy } from '../lifecycle/verification-fixtures.mts'
import { reserveSleep } from '../lifecycle/sleep.ts'
import { reconcileClosedUnits } from '../lifecycle/closed-unit.ts'
import { controller as fixtureController } from '../lifecycle/verification-fixtures.mts'
import { counter } from '../../../shared/durable-runtime/identity.ts'

if (!/^orca_writer_lifecycle_idle_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')) { throw new Error('Owned idle test DB required') }
const pool = createDurablePool({ max: 3 })
await applyMigrations(pool, await readMigrations(process.env.ORCA_TERMINAL_TEST_MIGRATIONS!))
try {
  await test('sleep stop settles only after sandbox proof and preserves the newer RUNNING intent and pending input', async () => {
    const f = await seedWriterLifecycle(pool), c = f.candidate, operation = randomUUID(), command = randomUUID()
    await pool.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,
      execution_epoch,expected_pod_uid,external_resource_name,deadline_at)
      VALUES($1,$2,'SLEEP',1,$3,2,'FENCE_ATTEMPT',1,$4,$5,clock_timestamp()+interval '1 minute')`,
    [operation,c.runtimeUnitId,f.controller.scope,c.podUid,c.podName])
    await pool.query(`INSERT INTO durable_runtime.runtime_commands(id,operation_id,runtime_unit_id,command_name,original_controller_term,
      step_revision,pod_target,expected_pod_uid,execution_epoch,intent_revision,input_hash,input,state,owner_controller_term,executor_id,execution_token,claimed_at)
      VALUES($1,$2,$3,'fenceAttempt',2,0,'EXISTING_POD',$4,1,1,$5,'{}','EXECUTING',2,'idle-test',$6,clock_timestamp())`,
    [command,operation,c.runtimeUnitId,c.podUid,'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',randomUUID()])
    await pool.query("UPDATE durable_runtime.runtime_units SET desired_mode='RUNNING',intent_revision=2,phase='QUIESCING' WHERE id=$1",[c.runtimeUnitId])
    const terminal = terminalPod()
    terminal.metadata.uid=c.podUid; terminal.metadata.name=c.podName
    terminal.metadata.annotations['orca.dev/attempt-id']=c.attemptId; terminal.metadata.labels['orca.dev/runtime-unit']=c.runtimeUnitId
    const observation=await observeAgentPod(api,c,new AbortController().signal,harness([{body:terminal}]).transport)
    const result=await reconcileOrphanedAttempt(pool,f.controller,c,observation,'idle-test')
    assert.ok(result.ok, JSON.stringify(result)); assert.equal(result.value.status,'RECONCILED')
    const unit=(await pool.query('SELECT desired_mode,intent_revision::text,active_attempt_id,execution_epoch::text,reconcile_due_at IS NOT NULL AS due FROM durable_runtime.runtime_units WHERE id=$1',[c.runtimeUnitId])).rows[0]
    assert.deepEqual(unit,{desired_mode:'RUNNING',intent_revision:'2',active_attempt_id:null,execution_epoch:'2',due:true})
    assert.equal((await pool.query('SELECT state FROM durable_runtime.runtime_commands WHERE id=$1',[command])).rows[0].state,'RESOLVED')
    assert.equal((await pool.query('SELECT step FROM durable_runtime.operations WHERE id=$1',[operation])).rows[0].step,'SUCCEEDED')
    assert.equal((await pool.query('SELECT writer_attempt_id FROM durable_runtime.storage_bindings WHERE id=$1',[f.binding])).rows[0].writer_attempt_id,null)
    assert.deepEqual((await pool.query('SELECT intake_status FROM durable_runtime.messages WHERE session_id=$1 ORDER BY seq',[f.session])).rows.map(row=>row.intake_status),['DURABLE','UNKNOWN'])
  })
  await test('one closed member keeps the open sibling; all closed members retire an empty unit', async () => {
    const f=await fixture(pool), owner=await fixtureController(pool,'idle-close-test','2')
    await pool.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSING' WHERE id=$1",[f.sessions[0]])
    await reconcileClosedUnits(pool,owner,policy)
    assert.equal((await pool.query('SELECT desired_mode FROM durable_runtime.runtime_units WHERE id=$1',[f.unit])).rows[0].desired_mode,'RUNNING')
    await pool.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSING' WHERE id=ANY($1::uuid[])",[f.sessions])
    await reconcileClosedUnits(pool,owner,policy)
    assert.equal((await pool.query('SELECT desired_mode FROM durable_runtime.runtime_units WHERE id=$1',[f.unit])).rows[0].desired_mode,'DELETED')
    assert.ok((await pool.query('SELECT lifecycle FROM durable_runtime.sessions WHERE id=ANY($1::uuid[])',[f.sessions])).rows.every(row=>row.lifecycle==='CLOSED'))
  })
  await test('automatic reservation checks PG idle deadline again under the unit lock', async () => {
    const f=await fixture(pool), a=await stoppedMetadataAttempt(pool,f,true)
    await pool.query("UPDATE durable_runtime.runtime_units SET idle_due_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[f.unit])
    const request={unitId:f.unit,actorId:'idle-test',discoveredMembers:f.sessions,expectedRevision:counter('row:runtime-unit','0'),expectedIntentRevision:counter('intent-revision','0'),policy,onlyWhenIdleDue:true,activityFreshnessMs:60000,activity:activity(f,a)}
    assert.deepEqual(await withDurableTransaction(pool,tx=>reserveSleep(tx,request)),{status:'DEFERRED',reason:'NOT_IDLE_DUE'})
    await pool.query("UPDATE durable_runtime.runtime_units SET idle_due_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.unit])
    assert.equal((await withDurableTransaction(pool,tx=>reserveSleep(tx,request))).status,'RESERVED')
  })
} finally { await pool.end() }
