import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import {createTerminalInputRuntime} from './runtime-input.ts'
import type {CommittedTerminalInput, ReadyTerminalInputPort} from './runtime-input-types.ts'

test('known auth refusal retains accepted input before any DB effect; readiness can resume the same receipt', async () => {
  let connects=0, allowed=false
  const session=randomUUID(), message=randomUUID(), terminal='fixture-terminal'
  const pool={connect:async()=>{connects++;throw new Error('fixture stops at first transaction')},query:async()=>{throw new Error('unexpected query')}} as unknown as Pool
  const port={binding:{sessionId:session},context:{controller:{}},executorId:'fixture',dispatchReady:()=>allowed} as unknown as ReadyTerminalInputPort
  const coordinator=createTerminalInputRuntime(pool,{current:()=>port})
  const input={authority:{principal:'fixture',sessionId:session,scope:{kind:'TERMINAL',terminalHandle:terminal}},
    binding:{logicalHandle:terminal,sessionId:session,principalId:'fixture'},targetPin:{payload:{}},sessionFence:'1',
    receipt:{key:{method:'terminal.send',principalId:'fixture',operationKey:'fixture'},response:{version:1,kind:'SUBMITTED',terminalHandle:terminal,
      input:{inputId:randomUUID(),messageId:message,messageRevision:'1',runtimeUnitId:randomUUID(),intentRevision:'1'}}}} as unknown as CommittedTerminalInput
  coordinator.committed(input);coordinator.ready();await coordinator.drain()
  assert.equal(connects,0,'no stage, claim, delivery row or provider call while refused')
  allowed=true;coordinator.ready();await coordinator.drain()
  assert.equal(connects,1,'the original accepted input is still queued, without another send')
  coordinator.dispose()
})
