import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentControlFrameCursor } from './agent-control-frame-cursor.ts'
import type { ControlJournal } from './agent-control-journal.ts'
test('restored PTY output waits for its consumer before later provider frames', async () => {
  let release!: () => void
  const consumed = new Promise<void>(resolve => { release = resolve })
  const order: string[] = []
  const journal: ControlJournal = { load: async () => ({ cursor: 2, notifications: [
    { hostSeq: 1, event: 'PTY_OUTPUT' }, { hostSeq: 2, event: 'NOTIFICATION' }
  ] }), record: async () => 2, resync: async () => 2 }
  const cursor = new AgentControlFrameCursor(journal)
  const restored = cursor.restore('control', 0, async frame => {
    order.push(String(frame.event))
    if (frame.event === 'PTY_OUTPUT') { await consumed; order.push('pty-consumed') }
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['PTY_OUTPUT'])
  release(); await restored
  assert.deepEqual(order, ['PTY_OUTPUT', 'pty-consumed', 'NOTIFICATION'])
  assert.equal(cursor.sequence, 2)
})
test('ACK and resume share durable all-frame prefix; uncommitted effect cannot move either',async()=>{
  let finish!:(n:number)=>void
  const journal:ControlJournal={load:async()=>({cursor:0,notifications:[]}),record:()=>new Promise(r=>{finish=r}),resync:async()=>{throw new Error('unexpected')}}
  const cursor=new AgentControlFrameCursor(journal)
  assert.equal(cursor.accept(1),true)
  const commit=cursor.commit('control',{hostSeq:1,id:'response-without-notification'})
  assert.equal(cursor.ack(),0);assert.equal(cursor.resume(),0)
  finish(1);await commit
  assert.equal(cursor.ack(),1);assert.equal(cursor.resume(),1)
  assert.throws(()=>cursor.accept(3),'sparse frames never become contiguous by taking max')
  assert.equal(cursor.accept(1),false)
})
test('quarantine prohibits effects and withholds ACK until actual retained snapshot commits',async()=>{
  let certified=false
  const journal:ControlJournal={load:async()=>({cursor:0,notifications:[]}),record:async()=>0,resync:async(_id,to,snapshot)=>{assert.deepEqual(snapshot,{thread:{id:'native'}});certified=true;return to}}
  const cursor=new AgentControlFrameCursor(journal)
  await cursor.restore('control',1380,()=>{})
  assert.equal(cursor.ack(),null,'a legacy sparse notification hint is not a durable all-frame prefix')
  cursor.quarantine({from:1381,to:1381})
  assert.equal(cursor.ack(),null)
  let sent=0
  await assert.rejects(cursor.request('control','turn/start',{},0,async()=>{sent++;return {}}))
  assert.equal(sent,0)
  await cursor.request('control','thread/resume',{threadId:'native',excludeTurns:true},0,async p=>{assert.equal(p?.excludeTurns,false);assert.equal(cursor.ack(),null);return {thread:{id:'native'}}})
  assert.equal(certified,true);assert.equal(cursor.ack(),1381);assert.equal(cursor.resume(),1381)
})

test('failed output consumption never persists or acknowledges its frame',async()=>{
 let records=0
 const journal:ControlJournal={load:async()=>({cursor:0,notifications:[]}),record:async()=>{records++;return 1},resync:async()=>0}
 const cursor=new AgentControlFrameCursor(journal)
 await assert.rejects(cursor.deliver(()=>'control',{hostSeq:1,event:'NOTIFICATION'},async()=>{cursor.accept(1);throw new Error('output append failed')}))
 assert.equal(records,0);assert.equal(cursor.ack(),0);assert.equal(cursor.resume(),0)
})

test('a provider without terminal snapshots keeps healthy legacy traffic but cannot ACK an unproved prefix',async()=>{
 const journal:ControlJournal={load:async()=>({cursor:0,notifications:[]}),record:async()=>0,resync:async()=>{throw new Error('unsupported')}}
 const cursor=new AgentControlFrameCursor(journal,false)
 await cursor.restore('control',90,()=>{})
 let sent=false
 await cursor.request('control','claude/send',{message:{}},0,async()=>{sent=true;return {}})
 assert.equal(sent,true);assert.equal(cursor.ack(),0);assert.equal(cursor.resume(),90)
})
