import test from 'node:test'
import assert from 'node:assert/strict'
import {createExternalCodexAuth} from './external-codex-auth.ts'
import type {CodexAppServerConnection} from '../../codex/codex-app-server-connection-types.ts'
const tick=()=>new Promise(resolve=>setImmediate(resolve))
test('external native auth supplies access only, fences account refresh and does not duplicate initialization',async()=>{
  const calls:unknown[]=[],replies:unknown[]=[],errors:unknown[]=[],renewals:unknown[]=[]
  let revision='1',wait:((value:never)=>void)|null=null
  const access=()=>({accountId:'owner',revision,accessToken:'private-access',chatgptAccountId:'workspace',expiresAt:200000})
  const connection={closed:false,request:async(method:string,params:unknown)=>{calls.push({method,params});return {type:'chatgptAuthTokens'}},
    respond:(id:unknown,result:unknown)=>replies.push({id,result}),respondWithError:(...args:unknown[])=>errors.push(args)} as unknown as CodexAppServerConnection
  const auth=createExternalCodexAuth({connection:()=>connection,now:()=>1000,readAccess:async rejected=>{
    if(rejected){renewals.push(rejected);await new Promise(resolve=>{wait=resolve});revision='2'}return access()
  }})
  const initialization=auth.initialize()
  await assert.rejects(auth.initialize(),/CODEX_EXTERNAL_AUTH_UNCONFIRMED/);await initialization
  assert.deepEqual(calls,[{method:'account/login/start',params:{type:'chatgptAuthTokens',accessToken:'private-access',chatgptAccountId:'workspace'}}])
  assert.equal(auth.handle({id:1,method:'item/tool/call',params:{}}),false)
  const request={id:2,method:'account/chatgptAuthTokens/refresh',params:{reason:'unauthorized',previousAccountId:'workspace'}}
  auth.handle({...request,params:{reason:'unauthorized',previousAccountId:'foreign'}})
  assert.equal(errors.length,1);assert.equal(renewals.length,0)
  auth.handle(request);auth.handle(request);await tick()
  assert.equal(renewals.length,1)
  const release=wait as unknown as (value:unknown)=>void;release(undefined);await tick()
  assert.deepEqual(replies,[{id:2,result:{accessToken:'private-access',chatgptAccountId:'workspace'}}])
  assert.equal(JSON.stringify(renewals).includes('private-access'),false)
  assert.deepEqual(renewals,[{revision:'1',chatgptAccountId:'workspace'}])
})
