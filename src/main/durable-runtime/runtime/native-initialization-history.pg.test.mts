import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {createDurablePool} from '../db/connection.ts'
import {nativeInitializationHistorySql} from './native-initialization-history.ts'

if(process.env.PGDATABASE!=='orca_terminal_task05_20261019') {throw new Error('Owned task05 database required')}
test('PG generation restart requires exact input-free guard and excludes effects, untracked cold and unstopped attempts',async()=>{
 const pool=createDurablePool({max:1}),client=await pool.connect(),schema=`initialization_${randomUUID().replaceAll('-','')}`
 const unit=randomUUID(),attempt=randomUUID(),session=randomUUID(),command=randomUUID(),proof={generation:'base',previousNativeSessionRef:'thread'}
 const query=nativeInitializationHistorySql.replaceAll('durable_runtime.',`${schema}.`)
 const blocked=async(value:unknown=proof)=>Number((await client.query(query,[unit,attempt,session,command,value===null?null:JSON.stringify(value)])).rowCount)>0
 try {
  await client.query('BEGIN')
  await client.query(`CREATE SCHEMA ${schema}`)
  await client.query(`CREATE TABLE ${schema}.attempts(id uuid,runtime_unit_id uuid,stopped_at timestamptz);
   CREATE TABLE ${schema}.provider_context_deliveries(id uuid,session_id uuid);
   CREATE TABLE ${schema}.messages(id uuid,session_id uuid,intake_status text);
   CREATE TABLE ${schema}.delivery_attempts(id uuid,session_id uuid,provider_ref text,state text);
   CREATE TABLE ${schema}.runtime_commands(id uuid,runtime_unit_id uuid,command_name text,input jsonb);
   CREATE TABLE ${schema}.runtime_audit_events(id uuid,runtime_unit_id uuid,attempt_id uuid,kind text,next_state jsonb)`)
  assert.equal(await blocked(),true)
  const guard={source:'AUTHENTICATED_AGENT_HOME',protocolVersion:2,state:'PROVISIONAL',inputState:'NOT_STARTED',initialization:proof}
  await client.query(`INSERT INTO ${schema}.runtime_audit_events VALUES($1,$2,$3,'INITIAL_NATIVE_CHECKPOINT_GUARDED',$4),
   ($5,$2,$3,'INITIAL_PROVIDER_READY','{}')`,[randomUUID(),unit,attempt,JSON.stringify(guard),randomUUID()])
  assert.equal(await blocked(),false)
  assert.equal(await blocked(null),true,'READY history cannot authorize an ordinary NEW')
  assert.equal(await blocked({...proof,generation:randomUUID()}),true,'proof must match current authenticated read')
  for(const state of ['EFFECT_POSSIBLE','ADMITTED','SETTLED','UNKNOWN','INTERRUPTED']) {
   await client.query(`INSERT INTO ${schema}.delivery_attempts VALUES($1,$2,NULL,$3)`,[randomUUID(),session,state])
   assert.equal(await blocked(),true,state)
   await client.query(`DELETE FROM ${schema}.delivery_attempts`)
  }
  await client.query(`INSERT INTO ${schema}.messages VALUES($1,$2,'UNKNOWN')`,[randomUUID(),session])
  assert.equal(await blocked(),true,'message uncertainty blocks restart even without a delivery row')
  await client.query(`UPDATE ${schema}.messages SET intake_status='DURABLE'`)
  assert.equal(await blocked(),false,'accepted but undispatched input is preserved for the new initialization')
  await client.query(`INSERT INTO ${schema}.provider_context_deliveries VALUES($1,$2)`,[randomUUID(),session])
  assert.equal(await blocked(),true);await client.query(`DELETE FROM ${schema}.provider_context_deliveries`)
  await client.query(`INSERT INTO ${schema}.attempts VALUES($1,$2,NULL)`,[randomUUID(),unit])
  assert.equal(await blocked(),true);await client.query(`UPDATE ${schema}.attempts SET stopped_at=clock_timestamp()`)
  assert.equal(await blocked(),false)
  await client.query(`INSERT INTO ${schema}.runtime_commands VALUES($1,$2,'releaseGate',$3)`,[randomUUID(),unit,JSON.stringify({attemptId:randomUUID()})])
  assert.equal(await blocked(),true)
  await client.query(`DELETE FROM ${schema}.runtime_commands`)
  for(const inputState of ['EFFECT_POSSIBLE','UNTRACKED']) {
   await client.query(`UPDATE ${schema}.runtime_audit_events SET next_state=$1 WHERE kind='INITIAL_NATIVE_CHECKPOINT_GUARDED'`,[JSON.stringify({...guard,inputState})])
   assert.equal(await blocked(),true,inputState)
  }
 }finally{await client.query('ROLLBACK');client.release();await pool.end()}
})
