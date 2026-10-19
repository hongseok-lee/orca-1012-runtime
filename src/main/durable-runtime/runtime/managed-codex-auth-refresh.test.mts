import test from 'node:test'
import assert from 'node:assert/strict'
import { managedCodexAuthControl, refreshResidentManagedCodexAuth, ManagedCodexAuthRefreshState, createResidentManagedCodexAuthRefresh,
  handleManagedCodexAuthRefresh, MANAGED_CODEX_AUTH_REFRESH_METHOD, managedCodexAuthRefreshSupported, MANAGED_CODEX_AUTH_REFRESH_CAPABILITY } from './managed-codex-auth-refresh.ts'
const credential=()=>({accountId:'fixture',revision:'1:2:3:4',authJson:JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture',refresh_token:'fixture',id_token:'fixture'}})})
test('normal managed attach reaches exact official refresh RPC and projects no account/token details',async()=>{
  const calls:unknown[]=[],observed:unknown[]=[]
  const resident={async request(method:string,params:unknown){calls.push({method,params});return {
    account:{type:'chatgpt',email:'private@example.invalid',planType:'pro'},requiresOpenaiAuth:true,privateField:'never-forward'}}}
  const control=managedCodexAuthControl(()=>managedCodexAuthRefreshSupported([MANAGED_CODEX_AUTH_REFRESH_CAPABILITY]),()=>true,async (method,params)=>{
    assert.equal(method,MANAGED_CODEX_AUTH_REFRESH_METHOD)
    return handleManagedCodexAuthRefresh({provider:'codex',phase:'READY',connection:resident,params,applyCredential:()=>{}})
  },credential)
  await new ManagedCodexAuthRefreshState(v=>observed.push(v)).refresh(control)
  assert.deepEqual(calls,[{method:'account/read',params:{refreshToken:true}}])
  assert.deepEqual(observed,[{state:'COMPLETED',authMode:'chatgpt'}])
  assert.equal(JSON.stringify(observed).includes('private'),false)
})
test('old host and invalid attachment do not send unsupported native requests or restart/replay',async()=>{
  let calls=0
  const send=async()=>{calls++;throw new Error('must not send')}
  const old=managedCodexAuthControl(()=>false,()=>true,send)
  const seen:unknown[]=[]
  await new ManagedCodexAuthRefreshState(v=>seen.push(v)).refresh(old)
  assert.deepEqual(seen,[{state:'UNAVAILABLE',reason:'HOST_CAPABILITY_MISSING'}]);assert.equal(calls,0)
  assert.equal((await new ManagedCodexAuthRefreshState(()=>{}).refresh(managedCodexAuthControl(()=>true,()=>false,send))).state,'FAILED')
  assert.equal(calls,0)
})
test('official auth rejection remains explicit, bounded and never becomes inferred model/tool success',async()=>{
  let calls=0
  const control=managedCodexAuthControl(()=>true,()=>true,async()=>refreshResidentManagedCodexAuth({async request(){calls++;throw new Error('private native error token_revoked')}}),credential)
  const seen:unknown[]=[]
  const state=new ManagedCodexAuthRefreshState(v=>seen.push(v))
  await state.refresh(control)
  assert.throws(()=>state.assertDispatchAllowed(),/AGENT_MANAGED_AUTH_TOKEN_REVOKED/)
  assert.equal(calls,1)
  assert.deepEqual(seen,[{state:'FAILED',code:'TOKEN_REVOKED'}])
  assert.deepEqual(await refreshResidentManagedCodexAuth({async request(){return {account:null,requiresOpenaiAuth:true}}}),{state:'FAILED',code:'MANAGED_AUTH_REQUIRED'})
})

test('actual Agent endpoint refuses provider/phase/token-parameter substitution before native refresh',async()=>{
 let calls=0
 const connection={async request(){calls++;return {account:{type:'chatgpt'},requiresOpenaiAuth:true}}}
 for(const patch of [{provider:'claude'},{phase:'CLOSED_GATE'},{connection:null},{params:{accessToken:'never-forward'}}]) {
   assert.deepEqual(await handleManagedCodexAuthRefresh({provider:'codex',phase:'READY',connection,params:undefined,...patch}),{state:'FAILED',code:'REFRESH_UNCONFIRMED'})
 }
 assert.equal(calls,0)
})

test('resident auth failure does not reconsume OAuth on takeover/poll; only changed supplied credentials reopen refresh',async()=>{
 let supplied='fixture-supply-1',calls=0
 const refresh=createResidentManagedCodexAuthRefresh(()=>({async request(){calls++;if(calls===1){throw new Error('token_revoked')}return {account:{type:'chatgpt'},requiresOpenaiAuth:true}}}),()=>supplied)
 const state=new ManagedCodexAuthRefreshState(()=>{})
 await state.refresh({refreshManagedAuth:refresh});assert.throws(()=>state.assertDispatchAllowed())
 await state.refresh({refreshManagedAuth:refresh});assert.equal(calls,1)
 supplied='fixture-supply-2'
 await state.refresh({refreshManagedAuth:refresh});assert.equal(calls,2);assert.doesNotThrow(()=>state.assertDispatchAllowed())
})

test('supported host without the persisted credential owner fails before any native request',async()=>{
 let calls=0
 const control=managedCodexAuthControl(()=>true,()=>true,async()=>{calls++;return {state:'COMPLETED',authMode:'chatgpt'}})
 assert.deepEqual(await control.refreshManagedAuth(),{state:'FAILED',code:'CREDENTIAL_OWNER_UNAVAILABLE'})
 assert.equal(calls,0)
})
