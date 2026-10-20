import assert from 'node:assert/strict'
import test from 'node:test'
import {nativeColdIdentity} from './native-cold-identity.ts'

test('cold Codex chooses resume only from current persisted identity and preserves the expected conversation',()=>{
  assert.equal(nativeColdIdentity('codex',{state:'NONE'}),null)
  assert.throws(()=>nativeColdIdentity('codex',{state:'NONE'},'old-thread'),/NATIVE_HISTORY_MISSING/)
  assert.throws(()=>nativeColdIdentity('codex',{state:'UNKNOWN'}),/NATIVE_IDENTITY_UNCONFIRMED/)
  assert.throws(()=>nativeColdIdentity('codex',{state:'PROVISIONAL',provider:'codex',nativeSessionRef:'thread'},'thread'),/NATIVE_HISTORY_NOT_PERSISTED/)
  assert.throws(()=>nativeColdIdentity('codex',{state:'FOUND',provider:'codex',nativeSessionRef:'other'},'thread'),/NATIVE_IDENTITY_MISMATCH/)
  assert.equal(nativeColdIdentity('codex',{state:'FOUND',provider:'codex',nativeSessionRef:'thread'},'thread'),'thread')
  assert.equal(nativeColdIdentity('codex',{state:'FOUND',provider:'codex',nativeSessionRef:'thread'}),'thread')
  assert.throws(()=>nativeColdIdentity('codex',{state:'FOUND',provider:'claude',nativeSessionRef:'thread'}),/NATIVE_IDENTITY_MISMATCH/)
})
