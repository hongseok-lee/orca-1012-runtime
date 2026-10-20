import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,unlinkSync,symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNativeSessionCheckpoint,markNativeEntered,recordNativeSessionCheckpoint,claudeResumeLaunch,initializeNativeInputBoundary,markNativeInputEntered } from './native-session-checkpoint.ts'

test('interrupted start distinguishes no native effect, uncertain effect, and actual native response across reconstruction',()=>{
 const home=mkdtempSync(join(tmpdir(),'orca-native-checkpoint-'));mkdirSync(join(home,'.orca-native'),{mode:0o700})
 try {
  assert.deepEqual(readNativeSessionCheckpoint(home,'codex'),{state:'NONE'})
  markNativeEntered(home)
  assert.deepEqual(readNativeSessionCheckpoint(home,'codex'),{state:'UNKNOWN'})
  recordNativeSessionCheckpoint(home,'codex','actual-thread-response')
  assert.deepEqual(readNativeSessionCheckpoint(home,'codex'),{state:'PROVISIONAL',provider:'codex',nativeSessionRef:'actual-thread-response',inputState:'UNTRACKED'})
  const sessions=join(home,'.codex','sessions');mkdirSync(sessions,{recursive:true,mode:0o700})
  const rollout=join(sessions,'rollout-actual-thread-response.jsonl')
  writeFileSync(rollout,`${JSON.stringify({type:'session_meta',payload:{id:'actual-thread-response'}})}\n`)
  assert.deepEqual(readNativeSessionCheckpoint(home,'codex'),{state:'FOUND',provider:'codex',nativeSessionRef:'actual-thread-response',inputState:'UNTRACKED'})
  unlinkSync(rollout)
  assert.equal(readNativeSessionCheckpoint(home,'codex').state,'PROVISIONAL','checkpoint alone cannot certify missing history')
  writeFileSync(rollout,`${JSON.stringify({type:'session_meta',payload:{id:'foreign-thread'}})}\n`)
  assert.equal(readNativeSessionCheckpoint(home,'codex').state,'UNKNOWN','filename cannot substitute for native metadata identity')
  unlinkSync(rollout);symlinkSync(join(home,'.orca-native','native-session.json'),rollout)
  assert.equal(readNativeSessionCheckpoint(home,'codex').state,'UNKNOWN','symlink is never native rollout proof')
  recordNativeSessionCheckpoint(home,'codex','actual-thread-response')
  assert.throws(()=>recordNativeSessionCheckpoint(home,'codex','different-thread'))
  assert.deepEqual(readNativeSessionCheckpoint(home,'claude'),{state:'UNKNOWN'})
  assert.deepEqual(claudeResumeLaunch({args:['--dangerously-skip-permissions','--session-id','launch-id']},'observed-native-id').args,
   ['--dangerously-skip-permissions','--resume','observed-native-id'])
 } finally {rmSync(home,{recursive:true})}
})

test('new protocol marks possible input before native invocation and cannot backfill absence on a legacy HOME',()=>{
 const home=mkdtempSync(join(tmpdir(),'orca-input-boundary-'));mkdirSync(join(home,'.orca-native'),{mode:0o700})
 const legacy=mkdtempSync(join(tmpdir(),'orca-input-legacy-'));mkdirSync(join(legacy,'.orca-native'),{mode:0o700})
 try {
  initializeNativeInputBoundary(home);markNativeEntered(home)
  recordNativeSessionCheckpoint(home,'codex','thread')
  assert.deepEqual(readNativeSessionCheckpoint(home,'codex'),{state:'PROVISIONAL',provider:'codex',nativeSessionRef:'thread',inputState:'NOT_STARTED'})
  assert.throws(()=>markNativeInputEntered(home,'foreign'),/NATIVE_INPUT_IDENTITY_UNCONFIRMED/)
  assert.equal(Reflect.get(readNativeSessionCheckpoint(home,'codex'),'inputState'),'NOT_STARTED')
  markNativeInputEntered(home,'thread')
  // Simulate a crash before any native request/response: the filesystem alone
  // must retain EFFECT_POSSIBLE, never infer that this input can be resent.
  assert.deepEqual(readNativeSessionCheckpoint(home,'codex'),{state:'PROVISIONAL',provider:'codex',nativeSessionRef:'thread',inputState:'EFFECT_POSSIBLE'})
  markNativeInputEntered(home,'thread')
  assert.throws(()=>initializeNativeInputBoundary(home),/NATIVE_INPUT_BOUNDARY_ALREADY_ENTERED/)
  markNativeEntered(legacy);recordNativeSessionCheckpoint(legacy,'codex','old-thread')
  assert.throws(()=>initializeNativeInputBoundary(legacy),/NATIVE_INPUT_BOUNDARY_ALREADY_ENTERED/)
  assert.equal(Reflect.get(readNativeSessionCheckpoint(legacy,'codex'),'inputState'),'UNTRACKED')
 }finally{rmSync(home,{recursive:true});rmSync(legacy,{recursive:true})}
})
