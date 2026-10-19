import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNativeSessionCheckpoint,markNativeEntered,recordNativeSessionCheckpoint,claudeResumeLaunch } from './native-session-checkpoint.ts'

test('interrupted start distinguishes no native effect, uncertain effect, and actual native response across reconstruction',()=>{
 const home=mkdtempSync(join(tmpdir(),'orca-native-checkpoint-'));mkdirSync(join(home,'.orca-native'),{mode:0o700})
 try {
  assert.deepEqual(readNativeSessionCheckpoint(home,'codex'),{state:'NONE'})
  markNativeEntered(home)
  assert.deepEqual(readNativeSessionCheckpoint(home,'codex'),{state:'UNKNOWN'})
  recordNativeSessionCheckpoint(home,'codex','actual-thread-response')
  assert.deepEqual(readNativeSessionCheckpoint(home,'codex'),{state:'FOUND',provider:'codex',nativeSessionRef:'actual-thread-response'})
  recordNativeSessionCheckpoint(home,'codex','actual-thread-response')
  assert.throws(()=>recordNativeSessionCheckpoint(home,'codex','different-thread'))
  assert.deepEqual(readNativeSessionCheckpoint(home,'claude'),{state:'UNKNOWN'})
  assert.deepEqual(claudeResumeLaunch({args:['--dangerously-skip-permissions','--session-id','launch-id']},'observed-native-id').args,
   ['--dangerously-skip-permissions','--resume','observed-native-id'])
 } finally {rmSync(home,{recursive:true})}
})
