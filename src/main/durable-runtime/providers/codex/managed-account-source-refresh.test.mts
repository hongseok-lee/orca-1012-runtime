import assert from 'node:assert/strict'
import test from 'node:test'
import type {CodexAppServerConnection} from '../../../codex/codex-app-server-connection-types.ts'
import type {ManagedCodexCredentialReader} from './managed-credential-owner.ts'
import {createManagedAccountSourceRefresh} from './managed-account-source-refresh.ts'
test('source renewal pins original home and requires native stop proof before completion',async()=>{
  const original={accountId:'selected',revision:'1:2:3:4',authJson:'never-forward',expectedEmail:'fixture@example.invalid'}
  let current=original,stopped=0,proof=true
  const calls:unknown[]=[]
  const read=Object.assign(()=>current,{sourceHome:()=>'/fixture/original-account'}) as ManagedCodexCredentialReader
  const refresh=createManagedAccountSourceRefresh({read,assertCurrent:()=>{},open:async home=>{
    assert.equal(home,'/fixture/original-account')
    return {request:async(method:string,params:unknown)=>{calls.push({method,params});current={...original,revision:'1:2:4:4'};return {account:{type:'chatgpt',email:original.expectedEmail},requiresOpenaiAuth:true}},
      close:async()=>{stopped++;return proof}} as unknown as CodexAppServerConnection
  }})
  await refresh('agent',original,async()=>{assert.equal(stopped,1)})
  assert.equal(stopped,1);assert.deepEqual(calls,[{method:'account/read',params:{refreshToken:true}}])
  current=original;proof=false
  await assert.rejects(refresh('agent',original,async()=>{throw new Error('unproven stop cannot be recorded')}),/STOP_UNCONFIRMED/);assert.equal(stopped,2)
})
