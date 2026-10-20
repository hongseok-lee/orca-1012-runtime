import type {NativeSessionCheckpoint} from './native-session-checkpoint.ts'
import type {NativeInitializationProof} from './native-checkpoint-files.ts'

/** This is only a proposal. The PG cold-effect permit must independently
 * exclude possible input effects and old writers before the Agent uses it. */
export function nativeInitializationProof(checkpoint:NativeSessionCheckpoint|null):NativeInitializationProof|null {
  if(!checkpoint||!('inputState' in checkpoint)||checkpoint.inputState!=='NOT_STARTED'||checkpoint.provider!=='codex'||
      typeof checkpoint.generation!=='string'||! /^(base|[0-9a-f-]{36})$/.test(checkpoint.generation)) {return null}
  if(checkpoint.state==='UNBOUND') {return {generation:checkpoint.generation,previousNativeSessionRef:checkpoint.previousNativeSessionRef}}
  return checkpoint.state==='PROVISIONAL'?{generation:checkpoint.generation,previousNativeSessionRef:checkpoint.nativeSessionRef}:null
}
