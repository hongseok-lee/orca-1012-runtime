import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createDurablePool} from '../db/connection.ts'
import {createTerminalCodexOutput} from './terminal-codex-output.ts'
test('PG raw-frame replay preserves original output identity despite receive time and JSONB key order',async()=>{
 const root=mkdtempSync(join(tmpdir(),'orca-cursor-replay-')),directory=join(root,'spool');mkdirSync(directory,{mode:0o700})
 const pool=createDurablePool({max:1})
 let output=createTerminalCodexOutput({pool,spoolDirectory:directory,current:()=>null})
 const first={connectionId:'control',sequence:'3',method:'item/completed',params:{turnId:'turn',item:{id:'answer',text:'output'}},observedAt:'2026-10-19T16:00:00Z'}
 try {
 output.onNativeNotification(first)
 await output.close()
 output=createTerminalCodexOutput({pool,spoolDirectory:directory,current:()=>null})
 output.onNativeNotification({...first,params:{item:{text:'output',id:'answer'},turnId:'turn'},observedAt:'2026-10-19T17:00:00Z'})
 assert.equal(output.snapshot().spooled,1)
 assert.throws(()=>output.onNativeNotification({...first,params:{turnId:'turn',item:{id:'answer',text:'conflicting'}}}))
 }finally{await output.close();await pool.end();rmSync(root,{recursive:true})}
})
