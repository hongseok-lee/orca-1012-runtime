import {nativeRequestFailure} from './native-request-failure.ts'
import {CodexAppServerRequestError} from '../../codex/codex-app-server-request-error.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import {createAgentExternalAuthBridge,supplyAgentExternalAuth,captureManagedCodexAccess,externalAgentAuthControl} from './agent-external-auth.ts'
const access={accountId:'selected',revision:'1:2:3:4',accessToken:'private-access',chatgptAccountId:'workspace',expiresAt:999999}
test('private asynchronous auth reply resolves a native wait without token-bearing events',async()=>{
  const events:Record<string,unknown>[]=[],bridge=createAgentExternalAuthBridge(event=>events.push(event),()=>1000)
  const nativeWait=bridge.read(),event=events[0]
  assert.equal(JSON.stringify(events).includes('private-access'),false)
  await supplyAgentExternalAuth(event,async()=>access,()=>true,async params=>({accepted:bridge.supply(params)}),()=>1000)
  assert.deepEqual(await nativeWait,access)
  assert.equal(bridge.supply({requestId:event.requestId,access}),false,'late/replayed supply cannot initialize another native request')
  assert.throws(()=>captureManagedCodexAccess({...access,refreshToken:'must-not-cross'}),/UNCONFIRMED/)
  bridge.close()
})
test('expired requests do not read/renew credentials; old hosts do not fall back to rotating-token auth',async()=>{
  let reads=0,legacyCalls=0
  const replies:unknown[]=[]
  await supplyAgentExternalAuth({requestId:'1',deadlineAt:1000},async()=>{reads++;return access},()=>true,async p=>{replies.push(p)},()=>1001)
  assert.equal(reads,0);assert.deepEqual(replies,[{requestId:'1',unavailable:true}])
  const control=externalAgentAuthControl(true,()=>false,()=>true,async()=>{throw new Error('unsupported')},
    {refreshManagedAuth:async()=>{legacyCalls++;return {state:'COMPLETED',authMode:'chatgpt'}}})
  assert.deepEqual(await control.refreshManagedAuth(),{state:'FAILED',code:'REFRESH_UNCONFIRMED'});assert.equal(legacyCalls,0)
})

test('renewal receives a live owner/deadline guard and cannot supply after ownership loss',async()=>{
  let owned=true,now=1000,guard:(()=>boolean)|undefined
  const replies:unknown[]=[]
  await supplyAgentExternalAuth({requestId:'1',deadlineAt:9000},async(_rejected,current)=>{
    guard=current;assert.equal(current?.(),true)
    now=9000;assert.equal(current?.(),false)
    now=1001;owned=false;assert.equal(current?.(),false)
    return access
  },()=>owned,async p=>{replies.push(p)},()=>now)
  assert.ok(guard);assert.deepEqual(replies,[])
})

test('native failure journal keeps numeric refusal and category without provider text or credentials',()=>{
 const refused=nativeRequestFailure(new CodexAppServerRequestError('thread/resume',-32600,'thread not found: secret-user-input bearer-token'))
 assert.deepEqual(refused,{nativeCode:-32600,category:'THREAD_UNAVAILABLE'})
 assert.equal(JSON.stringify(refused).includes('secret-user-input'),false)
 assert.deepEqual(nativeRequestFailure({message:'secret',code:100}),{nativeCode:null,category:'TRANSPORT_OR_LOCAL_FAILURE'})
})
