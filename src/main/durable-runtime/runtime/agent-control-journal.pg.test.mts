import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createDurablePool} from '../db/connection.ts'
import {applyMigrations,readMigrations} from '../db/migrate.ts'
import {createAgentControlJournal} from './agent-control-journal.ts'
if(!/^orca_control_cursor_[a-z0-9_]+$/.test(process.env.PGDATABASE??'')) {throw new Error('Owned cursor fixture database required')}
test('PG all-frame prefix survives response-only tail, takeover and concurrent writes',async()=>{
const pool=createDurablePool({max:4})
try {
 await applyMigrations(pool,await readMigrations(`${process.env.ORCA_CURSOR_TEST_SOURCE}/src/main/durable-runtime/db/migrations`))

  const id=randomUUID(),journal=createAgentControlJournal(pool,'owned-pod')
  assert.equal(await journal.record(id,{hostSeq:2,id:'rpc-response',result:{ok:true}}),0)
  assert.equal((await journal.load(id)).cursor,0)
  assert.equal(await journal.record(id,{hostSeq:1,event:'HELLO',podBearer:'must-not-retain'}),2)
  const fresh=createAgentControlJournal(pool,'owned-pod')
  assert.equal((await fresh.load(id)).cursor,2,'response tail persists across new owner')
  const incarnationId = randomUUID()
  const frames=[{hostSeq:3,event:'NOTIFICATION',method:'item/completed',params:{item:{id:'output',text:'retained'}}},{hostSeq:4,id:'next-response',result:{ok:true}},
    {hostSeq:5,event:'PTY_OUTPUT',controlId:id,incarnationId,startByte:0,endByte:2,bytes:Buffer.from('hi').toString('base64')},
    {hostSeq:6,event:'PTY_EXIT',controlId:id,incarnationId,exitCode:0}]
  await Promise.all(frames.map(frame=>fresh.record(id,frame)))
  const restored=await createAgentControlJournal(pool,'owned-pod').load(id)
  assert.equal(restored.cursor,6);assert.deepEqual(restored.notifications,[frames[0],frames[2],frames[3]])
  assert.equal((await pool.query("SELECT body ? 'podBearer' AS secret FROM durable_runtime.agent_control_frames WHERE control_id=$1 AND seq=1",[id])).rows[0].secret,false)
  await assert.rejects(fresh.record(id,{...frames[0],params:{item:{id:'output',text:'conflict'}}}))
  await assert.rejects(createAgentControlJournal(pool,'other-pod').load(id))
  assert.equal((await fresh.load(id)).cursor,6)
}finally {await pool.end()}
})
