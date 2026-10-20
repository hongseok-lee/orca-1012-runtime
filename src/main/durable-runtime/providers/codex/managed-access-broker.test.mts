import assert from 'node:assert/strict'
import test from 'node:test'
import {createManagedCodexAccessBroker, selectedManagedCodexAccess} from './managed-access-broker.ts'
import type {ManagedCodexCredential} from './managed-credential-owner.ts'
const time=1_000_000
function credential(revision='1:2:3:4',exp=900,accountId='selected'):ManagedCodexCredential {
  const payload=Buffer.from(JSON.stringify({exp,'https://api.openai.com/auth':{chatgpt_account_id:'workspace'}})).toString('base64url')
  return {accountId,revision,authJson:JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:'workspace',access_token:`e30.${payload}.c2ln`,refresh_token:'private-refresh',id_token:'private-id'}})}
}
function fixture() {
  let source=credential(),refreshes=0,rotations: {revision:string;state:'STARTED'|'COMPLETED'}|null=null
  const hooks={read:()=>source,now:()=>time,withAccountLock:async<T,>(_id:string|null,body:()=>Promise<T>)=>body(),
    readRotation:async()=>rotations,recordRotation:async(_id:string|null,revision:string,state:'STARTED'|'COMPLETED')=>{rotations={revision,state}},
    refreshSource:async()=>{refreshes++;await Promise.resolve();source=credential('1:2:4:4',2000)}}
  return {hooks,set source(value:ManagedCodexCredential){source=value},get source(){return source},get refreshes(){return refreshes}}
}
test('same-account Agents share one source renewal and receive access-only credentials',async()=>{
  const f=fixture(),broker=createManagedCodexAccessBroker(f.hooks)
  const [a,b]=await Promise.all([broker.read('agent-a'),broker.read('agent-b')])
  assert.equal(f.refreshes,1);assert.deepEqual(a,b)
  assert.deepEqual(Object.keys(a).sort(),['accessToken','accountId','chatgptAccountId','expiresAt','revision'])
  assert.equal(JSON.stringify(a).includes('private'),false)
  await broker.read('agent-c');assert.equal(f.refreshes,1)
})
test('a failed rotation remains held across broker restart until source revision changes',async()=>{
  const f=fixture();let calls=0
  f.hooks.refreshSource=async()=>{calls++;throw new Error('private-refresh-error')}
  await assert.rejects(createManagedCodexAccessBroker(f.hooks).read('a'),/^Error: CODEX_ACCESS_REFRESH_UNCONFIRMED$/)
  await assert.rejects(createManagedCodexAccessBroker(f.hooks).read('b'),/CODEX_ACCESS_REFRESH_UNCONFIRMED/)
  assert.equal(calls,1)
  f.source=credential('1:2:5:4',2000)
  await createManagedCodexAccessBroker(f.hooks).read('b');assert.equal(calls,1)
})
test('authorization rejection refreshes once; late rejection of older revision reuses the new token',async()=>{
  const f=fixture();f.source=credential('1:2:3:4',2000)
  const broker=createManagedCodexAccessBroker(f.hooks)
  const rejection={revision:f.source.revision,chatgptAccountId:'workspace'}
  await Promise.all([broker.read('a',rejection),broker.read('b',rejection)])
  assert.equal(f.refreshes,1)
  await broker.read('c',rejection);assert.equal(f.refreshes,1)
})
test('selection changes during renewal and foreign account refresh requests never return a token',async()=>{
  const f=fixture(),broker=createManagedCodexAccessBroker(f.hooks)
  await assert.rejects(broker.read('a',{revision:f.source.revision,chatgptAccountId:'other'}),/CODEX_ACCESS_ACCOUNT_MISMATCH/)
  f.hooks.refreshSource=async()=>{f.source=credential('1:2:5:4',2000,'other-owner')}
  await assert.rejects(broker.read('a'),/CODEX_ACCESS_OWNER_CHANGED/)
  assert.throws(()=>selectedManagedCodexAccess({...f.source,authJson:'private-invalid'}),/^Error: CODEX_ACCESS_SOURCE$/)
})
