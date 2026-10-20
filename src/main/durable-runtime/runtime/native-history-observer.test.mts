import assert from 'node:assert/strict'
import test from 'node:test'
import {createNativeHistoryObserver} from './native-history-observer.ts'
import {agentControlReaders} from './agent-control-readers.ts'
import type {NativeSessionCheckpoint} from './native-session-checkpoint.ts'

test('live input history promotion and later loss are recorded separately; failed commits remain retryable',async()=>{
  let checkpoint:NativeSessionCheckpoint={state:'PROVISIONAL',provider:'codex',nativeSessionRef:'thread'}
  let owned=true,commit=true
  const recorded:string[]=[]
  const observer=createNativeHistoryObserver('thread',async()=>checkpoint,()=>owned,async value=>{
    recorded.push(value.state);return commit
  })
  await observer.observe()
  checkpoint={state:'FOUND',provider:'codex',nativeSessionRef:'thread'}
  commit=false;await observer.observe()
  commit=true;await Promise.all([observer.observe(),observer.observe()])
  checkpoint={state:'PROVISIONAL',provider:'codex',nativeSessionRef:'thread'}
  await observer.observe()
  assert.deepEqual(recorded,['PROVISIONAL','FOUND','FOUND','PROVISIONAL'])
  checkpoint={state:'FOUND',provider:'codex',nativeSessionRef:'foreign'}
  await assert.rejects(observer.observe(),/NATIVE_HISTORY_IDENTITY_MISMATCH/)
  owned=false;await observer.observe()
  assert.equal(recorded.length,4)
})

test('native disk reads remain available after opening while mount qualification stays closed',async()=>{
  let connected=true,opened=false,calls=0
  const readers=agentControlReaders(async method=>{
    calls++
    if(method==='MOUNT_PROBE') {return {output:'mount'}}
    return {state:'FOUND',provider:'codex',nativeSessionRef:'thread'}
  },()=>connected,'codex',()=>{},()=>connected&&!opened)
  assert.equal(await readers.readMountProbe(),'mount')
  opened=true
  assert.equal((await readers.readNativeSession()).state,'FOUND')
  await assert.rejects(readers.readMountProbe(),/AGENT_CODEX_CONTROL_UNCONFIRMED/)
  connected=false
  await assert.rejects(readers.readNativeSession(),/AGENT_CODEX_CONTROL_UNCONFIRMED/)
  assert.equal(calls,2)
})

test('ownership lost during authenticated read cannot publish history evidence',async()=>{
  let owned=true,records=0
  const observer=createNativeHistoryObserver('thread',async()=>{
    owned=false;return {state:'FOUND',provider:'codex',nativeSessionRef:'thread'}
  },()=>owned,async()=>{records++;return true})
  await observer.observe()
  assert.equal(records,0)
})
