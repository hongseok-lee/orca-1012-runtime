import type {NativeSessionCheckpoint} from './native-session-checkpoint.ts'
import {nativeInitializationProof} from './native-initialization-proof.ts'

/** A committed response identifies the conversation to seek, not proof that
 * it survived. Cold recovery requires a fresh authenticated HOME observation.
 * Only explicitly input-free initialization may propose NEW; the PG cold
 * permit must still reject input effects and old writers before any restart. */
export function nativeColdIdentity(provider:'codex'|'claude',checkpoint:NativeSessionCheckpoint,expected?:string):string|null {
  if(checkpoint.state==='UNKNOWN') {throw new Error('NATIVE_IDENTITY_UNCONFIRMED')}
  const initialization=nativeInitializationProof(checkpoint)
  if(initialization) {
    if(expected!==undefined&&expected!==initialization.previousNativeSessionRef) {throw new Error('NATIVE_IDENTITY_MISMATCH')}
    return null
  }
  if(checkpoint.state==='UNBOUND') {throw new Error('NATIVE_INITIALIZATION_UNCONFIRMED')}
  if(checkpoint.state==='FOUND'||checkpoint.state==='PROVISIONAL') {
    if(checkpoint.provider!==provider || (expected!==undefined&&expected!==checkpoint.nativeSessionRef)) {
      throw new Error('NATIVE_IDENTITY_MISMATCH')
    }
    if(checkpoint.state==='PROVISIONAL') {throw new Error('NATIVE_HISTORY_NOT_PERSISTED')}
    return checkpoint.nativeSessionRef
  }
  if(provider==='codex'&&expected!==undefined) {throw new Error('NATIVE_HISTORY_MISSING')}
  return expected??null
}
