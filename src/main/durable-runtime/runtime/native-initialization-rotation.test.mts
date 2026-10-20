import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {initializeNativeInputBoundary,markNativeEntered,recordNativeSessionCheckpoint,readNativeSessionCheckpoint,markNativeInputEntered} from './native-session-checkpoint.ts'
import {nativeInitializationProof} from './native-initialization-proof.ts'
import {rotateNativeInitialization} from './native-initialization-rotation.ts'
import {nativeColdIdentity} from './native-cold-identity.ts'
import {nativeCheckpointDirectory} from './native-checkpoint-files.ts'

test('empty initialization recovers across generation switch and pre-ID crash while old identities stay immutable',()=>{
 const home=mkdtempSync(join(tmpdir(),'orca-native-generation-'));mkdirSync(join(home,'.orca-native'),{mode:0o700})
 try {
  initializeNativeInputBoundary(home);markNativeEntered(home)
  const preId=readNativeSessionCheckpoint(home,'codex')
  assert.equal(preId.state,'UNBOUND')
  assert.equal(nativeColdIdentity('codex',preId),null)
  recordNativeSessionCheckpoint(home,'codex','empty-thread')
  const original=readFileSync(join(home,'.orca-native','native-session.json'))
  const checkpoint=readNativeSessionCheckpoint(home,'codex'),proof=nativeInitializationProof(checkpoint)!
  assert.equal(nativeColdIdentity('codex',checkpoint,'empty-thread'),null)
  assert.throws(()=>nativeColdIdentity('codex',checkpoint,'foreign'),/NATIVE_IDENTITY_MISMATCH/)
  // An incomplete staging directory does not affect the active generation.
  mkdirSync(join(home,'.orca-native','generations','incomplete'),{recursive:true,mode:0o700})
  assert.deepEqual(readNativeSessionCheckpoint(home,'codex'),checkpoint)
  rotateNativeInitialization(home,proof)
  const switched=readNativeSessionCheckpoint(home,'codex'),firstPath=nativeCheckpointDirectory(home).path
  assert.equal(switched.state,'UNBOUND')
  assert.equal(nativeColdIdentity('codex',switched,'empty-thread'),null)
  // Crash after pointer publication, then another after process entry but
  // before thread/start returned: both remain explicitly input-free.
  markNativeEntered(home)
  assert.deepEqual(readNativeSessionCheckpoint(home,'codex'),switched)
  assert.throws(()=>rotateNativeInitialization(home,proof),/NATIVE_INITIALIZATION_CHANGED/)
  rotateNativeInitialization(home,nativeInitializationProof(switched)!)
  markNativeEntered(home);recordNativeSessionCheckpoint(home,'codex','new-thread')
  assert.equal(JSON.parse(readFileSync(join(firstPath,'initialization-origin.json'),'utf8')).previousNativeSessionRef,'empty-thread')
  assert.deepEqual(readFileSync(join(home,'.orca-native','native-session.json')),original)
  const beforeInput=nativeInitializationProof(readNativeSessionCheckpoint(home,'codex'))!
  markNativeInputEntered(home,'new-thread')
  assert.equal(nativeInitializationProof(readNativeSessionCheckpoint(home,'codex')),null)
  assert.throws(()=>rotateNativeInitialization(home,beforeInput),/NATIVE_INITIALIZATION_CHANGED/)
 }finally{rmSync(home,{recursive:true})}
})
