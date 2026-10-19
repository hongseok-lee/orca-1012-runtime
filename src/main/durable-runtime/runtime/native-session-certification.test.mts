import assert from 'node:assert/strict'
import test from 'node:test'
import { certifiedNativeSessionRef } from './native-session-certification.ts'

test('Claude launch-ready and historical READY cannot certify resume; actual init and original Codex response can',()=>{
  const claude={provider:'claude',nativeSessionRef:'launch-selected'}
  assert.equal(certifiedNativeSessionRef('claude','INITIAL_PROVIDER_READY',{providerRef:claude}),null)
  assert.equal(certifiedNativeSessionRef('claude','INITIAL_PROVIDER_READY',{nativeSessionObserved:false,launchProviderRef:claude}),null)
  assert.equal(certifiedNativeSessionRef('claude','INITIAL_PROVIDER_READY',{nativeSessionObserved:false,providerRef:claude}),null)
  const actual={provider:'claude',nativeSessionRef:'actual-init-response'}
  assert.equal(certifiedNativeSessionRef('claude','INITIAL_PROVIDER_NATIVE_OBSERVED',{providerRef:actual,source:'ORIGINAL_NATIVE_RESPONSE'}),'actual-init-response')
  assert.equal(certifiedNativeSessionRef('claude','INITIAL_PROVIDER_READY',{nativeSessionObserved:true,providerRef:actual}),'actual-init-response')
  assert.equal(certifiedNativeSessionRef('codex','INITIAL_PROVIDER_READY',{providerRef:{provider:'codex',nativeSessionRef:'actual-thread-response'}}),'actual-thread-response')
  assert.equal(certifiedNativeSessionRef('codex','INITIAL_PROVIDER_NATIVE_OBSERVED',{providerRef:actual}),null)
})
