import test from 'node:test'
import assert from 'node:assert/strict'
import { assertResyncCoverage } from './agent-control-resync.ts'
const item={id:'answer',type:'agentMessage',text:'retained output'}
const user={id:'user',type:'userMessage',content:[{type:'text',text:'input'}]}
const snapshot={thread:{id:'native',turns:[{id:'turn',status:'completed',items:[user,item]}]}}
const deliveries=[{state:'SETTLED',provider_ref:'turn'}]
const notifications=[{method:'item/completed',params:{turnId:'turn',item:user}},{method:'item/completed',params:{turnId:'turn',item}},{method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}}]
test('explicit snapshot resync requires actual terminal output and settled native effects',()=>{
  assert.doesNotThrow(()=>assertResyncCoverage(snapshot,'native',deliveries,notifications))
  assert.throws(()=>assertResyncCoverage(snapshot,'other',deliveries,notifications))
  assert.throws(()=>assertResyncCoverage(snapshot,'native',[...deliveries,{state:'UNKNOWN',provider_ref:null}],notifications))
  assert.throws(()=>assertResyncCoverage(snapshot,'native',deliveries,notifications.slice(2)))
  assert.throws(()=>assertResyncCoverage(snapshot,'native',deliveries,[notifications[0],{...notifications[1],params:{turnId:'turn',item:{...item,text:'partial'}}},notifications[2]]))
  assert.throws(()=>assertResyncCoverage({thread:{id:'native',turns:[{id:'turn',status:'completed',items:[]}] }},'native',deliveries,notifications))
  assert.throws(()=>assertResyncCoverage({thread:{id:'native',turns:[]}},'native',deliveries,notifications))
  assert.throws(()=>assertResyncCoverage(snapshot,'native',[...deliveries,{state:'SETTLED',provider_ref:'missing-turn'}],notifications))
})
