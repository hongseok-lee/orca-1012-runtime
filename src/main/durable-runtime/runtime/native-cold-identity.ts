import type {NativeSessionCheckpoint} from './native-session-checkpoint.ts'

/** A committed response identifies the conversation to seek, not proof that
 * it survived. Cold recovery requires a fresh authenticated HOME observation.
 * Never replace a missing or ambiguous conversation with a new native ID. */
export function nativeColdIdentity(provider:'codex'|'claude',checkpoint:NativeSessionCheckpoint,expected?:string):string|null {
  if(checkpoint.state==='UNKNOWN') {throw new Error('NATIVE_IDENTITY_UNCONFIRMED')}
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
